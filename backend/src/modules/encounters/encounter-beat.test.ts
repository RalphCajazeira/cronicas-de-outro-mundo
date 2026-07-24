import { describe, expect, it, vi } from 'vitest';
import {
  calculateSecondaryAttributes,
  createCoreV1EmptyEquipmentLoadout,
  createCoreV1EncounterActionSlots,
  createCoreV1EncounterState,
  getInitialAttributePreset,
  resolveCoreV1EncounterTargets,
  validateCoreV1ContentProfile,
  type CombatZone,
  type CoreV1EncounterParticipantInput,
  type CoreV1EncounterState,
} from '../rules/core-v1/index.js';
import {
  applyBeatGuardCapabilities,
  automaticReactionResolver,
  beatComponentRejectionReason,
  deriveEncounterFleeStep,
  ENCOUNTER_MAX_SCENE_RESPONSE_BYTES,
  encounterScenePackage,
  encounterTargetingContext,
  expireBeatGuardCapabilities,
  genericEncounterAction,
  normalizeBeatComponent,
  selectNpcBeatComponent,
} from './encounter-beat.js';
import type { PersistedEncounterAuthority } from './encounter-state-loader.js';
import {
  ENCOUNTER_MAX_PROJECTED_ACTIONS,
  loadEncounterActionCatalog,
  projectEncounterActionCatalog,
  type EncounterActionCatalog,
  type EncounterActionCatalogSource,
} from './encounter-action-loader.js';

const attributes = getInitialAttributePreset('balanced');
const secondary = calculateSecondaryAttributes({
  attributes, weaponFamilyRank: 0, magicSchoolRank: 0,
  accuracyRank: 0, evasionRank: 0, encumbrancePenalty: 0,
});

function participant(actorRef: string, sideRef: string, zone: CombatZone): CoreV1EncounterParticipantInput {
  return {
    actorRef, sideRef, actorStateVersion: 1, mechanicsStateVersion: 1,
    inventoryStateVersion: 1, effectsStateVersion: 1, zone, combatState: 'ready',
    primaryAttributes: attributes,
    resources: {
      hp: { current: 40, maximum: 40 }, mana: { current: 20, maximum: 20 },
      sp: { current: 20, maximum: 20 }, customResources: [],
    },
    secondaryAttributes: secondary,
    activeEffects: [],
    actionSlots: createCoreV1EncounterActionSlots(0n),
    reactionCapabilities: [],
    equipmentContext: {
      inventory: { entries: [] }, loadout: createCoreV1EmptyEquipmentLoadout(),
      requirements: {
        level: 1, primaryAttributes: attributes, knownContentRefs: [],
        equippedWeaponTags: [], equippedEquipmentTags: [], rulesetCode: 'core-v1',
      },
    },
    initiative: { tieBreak: actorRef === 'hero' ? 1 : 2 },
  };
}

function state(heroZone: CombatZone = 'near') {
  const created = createCoreV1EncounterState({
    encounterRef: 'beat-test', partySideRef: 'party', currentTick: 0n, status: 'active',
    participants: [participant('hero', 'party', heroZone), participant('ally', 'party', 'near'), participant('enemy', 'hostile', 'far')],
    relations: [
      { leftActorRef: 'ally', rightActorRef: 'ally', relation: 'self' },
      { leftActorRef: 'ally', rightActorRef: 'enemy', relation: 'hostile' },
      { leftActorRef: 'ally', rightActorRef: 'hero', relation: 'ally' },
      { leftActorRef: 'enemy', rightActorRef: 'enemy', relation: 'self' },
      { leftActorRef: 'enemy', rightActorRef: 'hero', relation: 'hostile' },
      { leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' },
    ],
  });
  if (!created.ok) throw new Error('fixture');
  return created.value;
}

function sizedState(participantCount: number, partyCount: number) {
  const participants = Array.from({ length: participantCount }, (_, index) => {
    const actorRef = index === 0 ? 'hero' : `actor-${String(index)}`;
    return participant(actorRef, index < partyCount ? 'party' : 'hostile', index % 2 === 0 ? 'near' : 'engaged');
  });
  const relations = participants.flatMap((left, leftIndex) => participants.slice(leftIndex).map((right) => ({
    leftActorRef: left.actorRef,
    rightActorRef: right.actorRef,
    relation: left.actorRef === right.actorRef ? 'self' as const
      : left.sideRef === right.sideRef ? 'ally' as const : 'hostile' as const,
  })));
  const created = createCoreV1EncounterState({
    encounterRef: `sized-${String(participantCount)}`,
    partySideRef: 'party',
    currentTick: 0n,
    status: 'active',
    participants,
    relations,
  });
  if (!created.ok) throw new Error('sized fixture');
  return created.value;
}

function projectedAction(index: number, targetRef: string, canUse = true) {
  return {
    source: 'content' as const,
    contentRef: {
      scope: 'campaign' as const,
      contentType: 'spell',
      code: `spell-${String(index)}`,
      versionNumber: 1,
    },
    code: `spell-${String(index)}`,
    name: `Spell ${String(index)}`,
    actionType: 'cast' as const,
    range: 'near',
    cost: { type: 'mana' as const, amount: 1 },
    validTargetRefs: [targetRef],
    canUse,
    ...(canUse ? {} : { blockers: ['insufficient_mana'] }),
  };
}

function enrichCapsuleState(
  encounter: CoreV1EncounterState,
  density: (actorRef: string, actorIndex: number) => {
    readonly equipment: number;
    readonly knownContent: number;
    readonly effects: number;
    readonly prepared: number;
  },
): CoreV1EncounterState {
  const participants = encounter.participants.map((entry, actorIndex) => {
    const actorDensity = density(entry.actorRef, actorIndex);
    let assignedEquipment = 0;
    const loadout = {
      slots: entry.equipmentContext.loadout.slots.map((slot) => {
        if (assignedEquipment >= actorDensity.equipment) return slot;
        assignedEquipment += 1;
        return { ...slot, entryRef: `${entry.actorRef}-equipment-${String(assignedEquipment)}` };
      }),
    };
    return {
      ...entry,
      activeEffects: Array.from({ length: actorDensity.effects }, (_, index) => ({
        effectRef: `${entry.actorRef}-effect-${String(index)}`,
        sourceActorRef: entry.actorRef,
        targetActorRef: entry.actorRef,
        sourceContent: {
          scope: 'campaign' as const,
          contentType: 'spell' as const,
          code: `${entry.actorRef}-effect-source-${String(index)}`,
          versionNumber: 1,
        },
        effectIndex: index,
        kind: 'primary_modifier' as const,
        stacks: 1,
        appliedAtTick: encounter.currentTick,
        durationState: { type: 'actions' as const, remainingActions: 3 },
        payload: {
          type: 'primary_modifier' as const,
          attributeCode: 'strength' as const,
          amount: 1,
        },
      })),
      equipmentContext: {
        ...entry.equipmentContext,
        loadout,
        requirements: {
          ...entry.equipmentContext.requirements,
          knownContentRefs: Array.from({ length: actorDensity.knownContent }, (_, index) => ({
            contentKind: index % 3 === 0 ? 'spell' as const : index % 3 === 1 ? 'skill' as const : 'weapon' as const,
            code: `${entry.actorRef}-content-${String(index)}`,
          })),
        },
      },
    };
  });
  const actionPlans = encounter.participants.flatMap((entry, actorIndex) => (
    Array.from({ length: density(entry.actorRef, actorIndex).prepared }, (_, index) => ({
      planRef: `prepared-${entry.actorRef}-${String(index)}`,
      actorRef: entry.actorRef,
      expectedStateVersion: encounter.stateVersion,
      intents: [],
      stopConditions: [],
    }))
  ));
  return { ...encounter, participants, actionPlans };
}

function jsonFieldCount(value: unknown): number {
  if (Array.isArray(value)) {
    return (value as unknown[]).reduce<number>((total, entry) => total + jsonFieldCount(entry), 0);
  }
  if (value === null || typeof value !== 'object') return 0;
  return Object.entries(value).reduce((total, [, entry]) => total + 1 + jsonFieldCount(entry), 0);
}

function actionCount(catalog: ReadonlyMap<string, EncounterActionCatalog>): number {
  return [...catalog.values()].reduce((total, entry) => (
    total + entry.attacks.length + entry.abilities.length + entry.items.length
  ), 0);
}

describe('encounter beat orchestration primitives', () => {
  it('translates free movement into the existing authoritative movement primitive', () => {
    const encounter = state();
    const action = genericEncounterAction(encounter, 'hero', { type: 'move', destination: 'far' }, 'beat-move', 'secondary');
    expect(action.intent).toMatchObject({ actionSource: 'movement', sourceActorRef: 'hero', targetSelector: 'self' });
    expect(action.definition).toMatchObject({
      actionKind: 'movement', actionTags: ['movement'], fullPrimaryAction: false,
      movement: { from: 'near', to: 'far', kind: 'retreat', terrain: 'normal' },
    });
    expect(beatComponentRejectionReason(encounter, 'hero', { type: 'move', destination: 'far' }, 'fallback'))
      .toBe('distance_incompatible');
    expect(beatComponentRejectionReason(encounter, 'hero', { type: 'move', destination: 'medium' }, 'fallback'))
      .toBe('fallback');
  });

  it('maps generic temporal actions to the canonical profile-less wait primitive', () => {
    const encounter = state();
    const components = [
      { type: 'defend' }, { type: 'protect', targetRef: 'ally' }, { type: 'intercept', targetRef: 'ally' },
      { type: 'prepare', contentRef: { scope: 'world', contentType: 'skill', code: 'strike', versionNumber: 1 }, trigger: 'enemy_attacks' },
      { type: 'assist', targetRef: 'ally' }, { type: 'observe' }, { type: 'interact', targetRef: 'ally' },
      { type: 'improvise', description: 'take cover' },
    ] as const;
    for (const [index, component] of components.entries()) {
      const action = genericEncounterAction(encounter, 'hero', component, `generic-${String(index)}`, 'secondary');
      expect(action.intent).toMatchObject({ actionSource: 'wait' });
      expect(action.definition).toMatchObject({
        actionSource: 'wait', actionKind: 'wait', actionTags: ['minor'], fullPrimaryAction: false, effectRefs: [],
      });
      expect(action.definition.profile).toBeUndefined();
    }
  });

  it('reports deterministic movement and flee normalization as explicit modifications', () => {
    expect(normalizeBeatComponent(state(), 'hero', { type: 'move', destination: 'medium' }))
      .toEqual({
        component: { type: 'move', destination: 'medium', movementKind: 'retreat' },
        modification: {
          code: 'MOVEMENT_KIND_INFERRED',
          reason: 'Movement kind was inferred as retreat from the authoritative zones.',
          field: 'movementKind',
        },
      });
    expect(normalizeBeatComponent(state(), 'hero', { type: 'flee' }))
      .toMatchObject({
        component: { type: 'move', destination: 'far', movementKind: 'run' },
        modification: { code: 'FLEE_STAGED', field: 'destination' },
      });
  });

  it('derives one legal canonical flee step from every zone without teleporting', () => {
    expect([
      deriveEncounterFleeStep('engaged', 'out_of_range'),
      deriveEncounterFleeStep('near', 'out_of_range'),
      deriveEncounterFleeStep('medium', 'out_of_range'),
      deriveEncounterFleeStep('far', 'out_of_range'),
      deriveEncounterFleeStep('out_of_range', 'out_of_range'),
    ]).toEqual([
      {
        status: 'step', from: 'engaged', to: 'near', desiredDestination: 'out_of_range',
        movementKind: 'disengage', transitions: 1, reachesDestination: false,
      },
      {
        status: 'step', from: 'near', to: 'far', desiredDestination: 'out_of_range',
        movementKind: 'run', transitions: 2, reachesDestination: false,
      },
      {
        status: 'step', from: 'medium', to: 'out_of_range', desiredDestination: 'out_of_range',
        movementKind: 'run', transitions: 2, reachesDestination: true,
      },
      {
        status: 'step', from: 'far', to: 'out_of_range', desiredDestination: 'out_of_range',
        movementKind: 'run', transitions: 1, reachesDestination: true,
      },
      { status: 'completed', from: 'out_of_range', desiredDestination: 'out_of_range' },
    ]);
    expect(deriveEncounterFleeStep('engaged', 'far')).toMatchObject({
      status: 'step', to: 'near', movementKind: 'disengage', reachesDestination: false,
    });
    expect(deriveEncounterFleeStep('near', 'far')).toMatchObject({
      status: 'step', to: 'far', movementKind: 'run', reachesDestination: true,
    });
    expect(deriveEncounterFleeStep('far', 'far')).toEqual({
      status: 'completed', from: 'far', desiredDestination: 'far',
    });
  });

  it('normalizes staged flee into the same legal movement primitive used by the Core', () => {
    const cases = [
      ['engaged', 'near', 'disengage', 'FLEE_STAGED'],
      ['near', 'far', 'run', 'FLEE_STAGED'],
      ['medium', 'out_of_range', 'run', undefined],
      ['far', 'out_of_range', 'run', undefined],
    ] as const;
    for (const [from, to, movementKindValue, modificationCode] of cases) {
      const encounter = state(from);
      const normalized = normalizeBeatComponent(encounter, 'hero', {
        type: 'flee', destination: 'out_of_range',
      });
      expect(normalized.component).toMatchObject({
        type: 'move', destination: to, movementKind: movementKindValue,
      });
      expect(normalized.modification?.code).toBe(modificationCode);
      expect(beatComponentRejectionReason(encounter, 'hero', normalized.component, 'fallback'))
        .toBe('fallback');
      expect(genericEncounterAction(
        encounter, 'hero', normalized.component, `flee-${from}`, 'secondary',
      ).definition.movement).toEqual({
        kind: movementKindValue, from, to, terrain: 'normal',
      });
    }
    expect(normalizeBeatComponent(state('out_of_range'), 'hero', {
      type: 'flee', destination: 'out_of_range',
    })).toMatchObject({
      completedFlee: true,
      component: { type: 'flee', destination: 'out_of_range' },
      modification: { code: 'FLEE_ALREADY_COMPLETE' },
    });
  });

  it('keeps self targeting independent from the actor absolute zone', () => {
    for (const zone of ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const) {
      const encounter = state(zone);
      const resolved = resolveCoreV1EncounterTargets({
        encounter,
        sourceActorRef: 'hero',
        targeting: { type: 'self', rangeBand: 'self' },
        selector: 'self',
        requestedTargetRefs: [],
        allowedRelations: ['self'],
        context: encounterTargetingContext(encounter, 'hero'),
      });
      expect(resolved).toMatchObject({
        ok: true,
        value: [{ targetRef: 'hero' }],
      });
    }
  });

  it('projects the canonical run step and its SP blocker without changing movement limits', () => {
    const nearScene = encounterScenePackage(state('near'), new Map());
    expect(nearScene.participants.find((entry) => entry.actorRef === 'hero')?.usableActions.movements)
      .toEqual(expect.arrayContaining([
        { destination: 'far', movementKind: 'run', canUse: true },
        {
          destination: 'out_of_range',
          movementKind: 'run',
          canUse: false,
          blockers: ['destination_too_far_for_one_movement'],
        },
      ]));
    const lowSp = {
      ...state('near'),
      participants: state('near').participants.map((entry) => entry.actorRef !== 'hero' ? entry : {
        ...entry,
        resources: { ...entry.resources, sp: { ...entry.resources.sp, current: 2 } },
      }),
    };
    expect(encounterScenePackage(lowSp, new Map()).participants
      .find((entry) => entry.actorRef === 'hero')?.usableActions.movements)
      .toEqual(expect.arrayContaining([
        {
          destination: 'far',
          movementKind: 'run',
          canUse: false,
          blockers: ['insufficient_sp'],
        },
      ]));
  });

  it('represents defend, protect and intercept as one-use encounter reaction capabilities without abilities', () => {
    const guarded = applyBeatGuardCapabilities(state(), 'hero', [
      { type: 'defend' }, { type: 'protect', targetRef: 'ally' }, { type: 'intercept', targetRef: 'ally' },
    ], 'fixture');
    expect(guarded.stateVersion).toBe(state().stateVersion + 1);
    expect(guarded.participants.find((entry) => entry.actorRef === 'hero')?.reactionCapabilities)
      .toEqual([expect.objectContaining({ kind: 'block' })]);
    expect(guarded.participants.find((entry) => entry.actorRef === 'ally')?.reactionCapabilities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'block' }), expect.objectContaining({ kind: 'interrupt' }),
      ]));
    const block = guarded.participants.find((entry) => entry.actorRef === 'hero')?.reactionCapabilities[0];
    if (block === undefined) throw new Error('fixture');
    expect(automaticReactionResolver().resolve({
      encounter: guarded,
      action: {} as never,
      reactorActorRef: 'hero', reactionKind: 'block', currentTick: guarded.currentTick,
    })).toMatchObject({ kind: 'block', success: true });
    const expired = expireBeatGuardCapabilities(guarded);
    expect(expired.participants.every((participant) => participant.reactionCapabilities
      .every((capability) => !capability.capabilityRef.startsWith('beat-')))).toBe(true);
  });

  it('chooses deterministic hostile and allied fallbacks from relations and actor tactics', () => {
    const encounter = state();
    expect(selectNpcBeatComponent(encounter, 'enemy', 'hero', undefined)).toEqual({
      strategy: 'aggressive', component: { type: 'move', destination: 'medium' }, targetRef: 'ally',
    });
    const tacticalAuthority = {
      actor: { metadata: { tactic: 'defensive' } },
    } as unknown as PersistedEncounterAuthority;
    expect(selectNpcBeatComponent(encounter, 'ally', 'hero', tacticalAuthority)).toEqual({
      strategy: 'defensive', component: { type: 'defend' },
    });
  });

  it('builds a compact reusable scene package with generic actions and tactical guidance', () => {
    const encounter = state();
    const authority = {
      actor: { role: 'guardian', personality: { traits: ['loyal'] }, metadata: { tactic: 'defensive', objective: 'protect hero', faction: 'party' } },
    } as unknown as PersistedEncounterAuthority;
    const scene = encounterScenePackage(encounter, new Map([['ally', authority]]));
    expect(scene.stateVersion).toBe(encounter.stateVersion);
    expect(scene.genericActions).toEqual(expect.arrayContaining(['move', 'defend', 'protect', 'prepare', 'attack', 'cast']));
    const allyScene = scene.participants.find((entry) => entry.actorRef === 'ally');
    expect(allyScene).toMatchObject({
      sideRef: 'party',
      resources: { hp: { current: 40, maximum: 40 } },
      usableActions: { attacks: [], abilities: [], items: [] },
      role: 'guardian', tacticalProfile: {
        strategy: 'defensive', objective: 'protect hero', faction: 'party', traits: ['loyal'],
      },
    });
    expect(allyScene?.relations).toEqual({
      allies: ['hero'], hostiles: ['enemy'], neutrals: [],
    });
    expect(scene.processingLimits).toMatchObject({
      maximumBeatsPerCall: 12,
      maximumComponentsPerBeat: 3,
      maximumNpcActionsPerBeat: 4,
      maximumEventsPerCheckpoint: 32,
      maximumProjectedActions: ENCOUNTER_MAX_PROJECTED_ACTIONS,
      maximumSceneBytes: ENCOUNTER_MAX_SCENE_RESPONSE_BYTES,
      maximumTransactionDurationMs: 30_000,
    });
  });

  it('keeps a maximum projected action capsule within the deterministic scene byte budget', () => {
    const actions = Array.from({ length: ENCOUNTER_MAX_PROJECTED_ACTIONS }, (_, index) => ({
      source: 'inventory' as const,
      inventoryEntryRef: `entry-${String(index)}`,
      code: `action-${String(index)}`,
      name: `Action ${String(index)}`,
      actionType: 'attack' as const,
      rarity: 'common',
      activation: 'active',
      range: 'near',
      cost: { type: 'none' as const },
      consumable: false,
      compatibleModes: ['one_handed' as const],
      validTargetRefs: ['enemy'],
      canUse: true,
      blockers: [],
    }));
    const catalog: EncounterActionCatalog = { attacks: actions, abilities: [], items: [] };
    const scene = encounterScenePackage(
      state(),
      new Map(),
      { actionCatalog: new Map([['hero', catalog]]) },
    );
    expect(scene.participants.reduce((total, actor) => (
      total + actor.usableActions.attacks.length + actor.usableActions.abilities.length + actor.usableActions.items.length
    ), 0)).toBe(ENCOUNTER_MAX_PROJECTED_ACTIONS);
    expect(Buffer.byteLength(JSON.stringify(scene), 'utf8')).toBeLessThanOrEqual(ENCOUNTER_MAX_SCENE_RESPONSE_BYTES);
  });

  it('measures realistic simple, group, eight-participant and maximum-contract capsules against byte budgets', () => {
    const reports: Record<string, unknown>[] = [];
    const measure = (
      scenario: string,
      encounter: CoreV1EncounterState,
      catalog: ReadonlyMap<string, EncounterActionCatalog>,
      dominantData: readonly string[],
    ) => {
      const scene = encounterScenePackage(encounter, new Map(), { actionCatalog: catalog });
      reports.push({
        scenario,
        participants: scene.participants.length,
        projectedActions: actionCount(catalog),
        jsonBytes: Buffer.byteLength(JSON.stringify(scene), 'utf8'),
        approximateFields: jsonFieldCount(scene),
        dominantData,
        catalogProjection: scene.catalogProjection,
      });
      return scene;
    };

    const simpleState = enrichCapsuleState(sizedState(2, 1), (_actorRef, actorIndex) => ({
      equipment: actorIndex === 0 ? 1 : 0,
      knownContent: actorIndex === 0 ? 6 : 0,
      effects: 0,
      prepared: 0,
    }));
    const simpleCatalog: EncounterActionCatalog = {
      attacks: [], abilities: Array.from({ length: 6 }, (_, index) => projectedAction(index, 'actor-1')), items: [],
    };
    const simpleCatalogByActor = new Map([['hero', simpleCatalog]]);
    const simple = measure(
      'simple_2_participants_6_contents',
      simpleState,
      simpleCatalogByActor,
      ['protagonist action details', 'participant resources', 'movement options'],
    );
    expect(Buffer.byteLength(JSON.stringify(simple), 'utf8')).toBeLessThanOrEqual(64 * 1024);

    const groupState = enrichCapsuleState(sizedState(6, 2), () => ({
      equipment: 2, knownContent: 12, effects: 4, prepared: 2,
    }));
    const groupCatalog = new Map(groupState.participants.map((actor, actorIndex) => [
      actor.actorRef,
      {
        attacks: Array.from({ length: 6 }, (_, index) => ({
          ...projectedAction(actorIndex * 100 + index, 'hero'), actionType: 'attack' as const,
        })),
        abilities: Array.from({ length: 8 }, (_, index) => projectedAction(actorIndex * 100 + 20 + index, 'hero')),
        items: Array.from({ length: 4 }, (_, index) => ({
          ...projectedAction(actorIndex * 100 + 40 + index, actor.actorRef), actionType: 'use_item' as const,
        })),
      },
    ] satisfies [string, EncounterActionCatalog]));
    const group = measure(
      'group_2_allies_4_enemies',
      groupState,
      groupCatalog,
      ['two controlled action catalogs', 'effects and known content', 'NPC catalog summaries'],
    );
    expect(Buffer.byteLength(JSON.stringify(group), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(group.participants.filter((actor) => actor.sideRef === 'hostile')
      .every((actor) => actor.usableActions.catalogMode === 'summary')).toBe(true);

    const largerState = enrichCapsuleState(sizedState(8, 3), () => ({
      equipment: 3, knownContent: 24, effects: 8, prepared: 5,
    }));
    const largerCatalog = new Map(largerState.participants.map((actor, actorIndex) => [
      actor.actorRef,
      {
        attacks: Array.from({ length: 10 }, (_, index) => ({
          ...projectedAction(actorIndex * 1_000 + index, 'hero'), actionType: 'attack' as const,
        })),
        abilities: Array.from({ length: 16 }, (_, index) => projectedAction(actorIndex * 1_000 + 100 + index, 'hero')),
        items: Array.from({ length: 8 }, (_, index) => ({
          ...projectedAction(actorIndex * 1_000 + 200 + index, actor.actorRef), actionType: 'use_item' as const,
        })),
      },
    ] satisfies [string, EncounterActionCatalog]));
    const larger = measure(
      'larger_8_participants',
      largerState,
      largerCatalog,
      ['three controlled action catalogs', 'known content and effects', 'prepared action references'],
    );
    expect(Buffer.byteLength(JSON.stringify(larger), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(larger.participants.filter((actor) => actor.sideRef === 'hostile')
      .every((actor) => actor.usableActions.catalogMode === 'summary')).toBe(true);

    const maximumState = enrichCapsuleState(sizedState(64, 1), () => ({
      equipment: 8, knownContent: 128, effects: 128, prepared: 5,
    }));
    const maximumCatalog = new Map(maximumState.participants.map((actor, actorIndex) => [
      actor.actorRef,
      {
        attacks: Array.from({ length: actorIndex === 0 ? 96 : 32 }, (_, index) => ({
          ...projectedAction(actorIndex * 10_000 + index, 'hero'), actionType: 'attack' as const,
        })),
        abilities: Array.from({ length: actorIndex === 0 ? 96 : 32 }, (_, index) => (
          projectedAction(actorIndex * 10_000 + 1_000 + index, 'hero')
        )),
        items: Array.from({ length: actorIndex === 0 ? 64 : 16 }, (_, index) => ({
          ...projectedAction(actorIndex * 10_000 + 2_000 + index, actor.actorRef), actionType: 'use_item' as const,
        })),
      },
    ] satisfies [string, EncounterActionCatalog]));
    let maximumBytes = 0;
    expect(() => {
      try {
        encounterScenePackage(maximumState, new Map(), { actionCatalog: maximumCatalog });
      } catch (error) {
        const message = (
          error !== null && typeof error === 'object' && 'issues' in error && Array.isArray(error.issues)
            ? (error.issues[0] as { message?: unknown } | undefined)?.message : undefined
        );
        const match = typeof message === 'string' ? message.match(/is (\d+) UTF-8 bytes/) : null;
        maximumBytes = Number(match?.[1] ?? 0);
        throw error;
      }
    }).toThrowError(expect.objectContaining({
      code: 'ENCOUNTER_CORE_REJECTED',
      issues: [expect.objectContaining({ code: 'SCENE_RESPONSE_LIMIT' })],
    }));
    expect(maximumBytes).toBeGreaterThan(ENCOUNTER_MAX_SCENE_RESPONSE_BYTES);
    reports.push({
      scenario: 'maximum_current_input_contract',
      participants: maximumState.participants.length,
      projectedActions: actionCount(maximumCatalog),
      jsonBytesBeforeHardCapRejection: maximumBytes,
      approximateFieldsBeforeProjection: jsonFieldCount(maximumState),
      dominantData: ['128 effects and 128 known contents per actor', '64 participant relation sets', 'NPC catalog summaries'],
      truncation: 'closed rejection at 256 KiB; no silent truncation',
    });

    if (process.env.REPORT_ENCOUNTER_PAYLOADS === '1') {
      console.info(`ENCOUNTER_PAYLOAD_METRICS=${JSON.stringify(reports)}`);
    }
  });

  it('marks partial catalogs explicitly, preserves every usable protagonist action and summarizes NPC details', () => {
    const encounter = sizedState(2, 1);
    const protagonistActions = [
      ...Array.from({ length: 40 }, (_, index) => projectedAction(index, 'actor-1')),
      ...Array.from({ length: 300 }, (_, index) => projectedAction(1_000 + index, 'actor-1', false)),
    ];
    const npcActions = Array.from({ length: 80 }, (_, index) => projectedAction(2_000 + index, 'hero'));
    const scene = encounterScenePackage(encounter, new Map(), {
      actionCatalog: new Map([
        ['hero', { attacks: [], abilities: protagonistActions, items: [] }],
        ['actor-1', { attacks: npcActions, abilities: [], items: [] }],
      ]),
    });
    const protagonist = scene.participants.find((actor) => actor.actorRef === 'hero');
    const npc = scene.participants.find((actor) => actor.actorRef === 'actor-1');
    expect(scene.catalogProjection).toMatchObject({
      status: 'partial',
      sourceActionCount: 420,
      omittedBlockedActionCount: 292,
      summarizedActorRefs: ['actor-1'],
    });
    expect(protagonist?.usableActions.abilities.filter((action) => action.canUse)).toHaveLength(40);
    expect(npc?.usableActions).toMatchObject({
      catalogMode: 'summary',
      attacks: [],
      summary: { attacks: { total: 80, usable: 80 } },
    });
    expect(JSON.stringify(scene)).not.toContain('"blockers":[]');
  });

  it('enforces the 256 KiB public hard cap instead of silently dropping usable protagonist actions', () => {
    const encounter = sizedState(8, 8);
    const oversizedName = 'A'.repeat(200);
    const catalog = new Map(encounter.participants.map((actor, actorIndex) => [
      actor.actorRef,
      {
        attacks: [],
        abilities: Array.from({ length: 300 }, (_, index) => ({
          ...projectedAction(actorIndex * 1_000 + index, actor.actorRef),
          name: oversizedName,
        })),
        items: [],
      },
    ] satisfies [string, EncounterActionCatalog]));
    expect(() => encounterScenePackage(encounter, new Map(), { actionCatalog: catalog }))
      .toThrowError(expect.objectContaining({
        code: 'ENCOUNTER_CORE_REJECTED',
        issues: [expect.objectContaining({ code: 'SCENE_RESPONSE_LIMIT' })],
      }));
  });

  it('projects inventory actions with one content query and one inventory query, without per-action N+1', async () => {
    const encounter = state();
    const weaponProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'weapon', code: 'test-sword', name: 'Test sword',
      tier: 1, rarity: 'common', activation: { type: 'active' },
      cost: { type: 'none' }, actionProfile: 'quick',
      targeting: { type: 'weapon_attack', rangeBand: 'far', maxTargets: 1 },
      damageComponents: [{
        id: 'test-hit', channel: 'physical', element: null,
        baseDamage: 4, scaling: 'full', canCrit: true,
      }],
      handedness: 'one_handed', weaponTags: ['sword'],
    } as const;
    const inventory = {
      entries: ['sword-a', 'sword-b'].map((entryRef) => ({
        entryKind: 'instance' as const,
        entryRef,
        contentVersion: {
          scope: 'campaign' as const, contentType: 'weapon' as const,
          code: entryRef, versionNumber: 1,
        },
        inventorySpec: {
          schemaVersion: 1 as const, rulesetCode: 'core-v1' as const,
          inventoryRulesCode: 'core-v1-inventory-v1' as const,
          unitWeight: 1, stacking: { mode: 'unique' as const },
          equipmentSlots: ['main_hand' as const], handedness: 'one_handed' as const,
        },
        profile: { ...weaponProfile, code: entryRef, name: entryRef },
        state: 'equipped' as const,
      })),
    };
    const authority = {
      actor: { id: 'actor-id', code: 'hero' },
      inventory: {
        inventory,
        loadout: {
          slots: createCoreV1EmptyEquipmentLoadout().slots.map((slot) => (
            slot.slotRef === 'main_hand' ? { ...slot, entryRef: 'sword-a' } : slot
          )),
        },
      },
    } as unknown as PersistedEncounterAuthority;
    const findMany = vi.fn().mockResolvedValue([]);
    const inventoryFindMany = vi.fn().mockResolvedValue([{
      actor: { code: 'hero' },
      entryRef: 'sword-a',
      equipmentSlots: [{}],
      contentVersion: {
        profile: weaponProfile,
        contentDefinition: { status: 'ACTIVE', contentType: 'WEAPON', campaignId: 'campaign', code: 'sword-a' },
        sourceEffectBindings: [],
      },
    }]);
    const catalog = await loadEncounterActionCatalog(
      { actorContent: { findMany }, inventoryEntry: { findMany: inventoryFindMany } } as never,
      { state: encounter, authorities: new Map([['hero', authority]]) },
    );
    expect(findMany).toHaveBeenCalledOnce();
    expect(inventoryFindMany).toHaveBeenCalledOnce();
    const contentQuery = findMany.mock.calls[0]?.[0] as unknown;
    expect(contentQuery).not.toHaveProperty('take');
    expect(catalog.get('hero')?.attacks).toHaveLength(1);
    expect(catalog.get('hero')?.attacks[0]).toMatchObject({
      inventoryEntryRef: 'sword-a', range: 'far', validTargetRefs: ['enemy'], canUse: true,
    });
  });

  it('recomputes projected cost and availability locally when an in-memory effect changes', () => {
    const base = state();
    const statusProfile = {
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      profileMode: 'mechanical',
      contentKind: 'status_effect',
      code: 'mana-tax',
      name: 'Mana Tax',
      tier: 1,
      rarity: 'common',
      activation: { type: 'passive' },
      cost: { type: 'none' },
      duration: { type: 'actions', value: 2 },
      stacking: { type: 'refresh' },
      passiveModifiers: [{ target: 'manaCostBps', amount: 10_000, sourceRule: 'status_effect' }],
    } as const;
    const spellProfile = {
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      profileMode: 'mechanical',
      contentKind: 'spell',
      code: 'costly-spell',
      name: 'Costly Spell',
      tier: 1,
      rarity: 'common',
      activation: { type: 'active' },
      cost: { type: 'mana', amount: 5 },
      actionProfile: 'quick',
      effects: [{
        type: 'damage',
        targeting: { type: 'single_target', rangeBand: 'far', maxTargets: 1 },
        damageComponents: [{
          id: 'costly-hit', channel: 'magical', element: 'fire',
          baseDamage: 4, scaling: 'full', canCrit: true,
        }],
      }],
    } as const;
    const taxed = {
      ...base,
      participants: base.participants.map((entry) => entry.actorRef !== 'hero' ? entry : {
        ...entry,
        resources: { ...entry.resources, mana: { ...entry.resources.mana, current: 7 } },
        activeEffects: [{
          effectRef: 'mana-tax-effect',
          sourceActorRef: 'enemy',
          targetActorRef: 'hero',
          sourceContent: {
            scope: 'campaign' as const,
            contentType: 'spell' as const,
            code: 'apply-mana-tax',
            versionNumber: 1,
          },
          effectIndex: 0,
          kind: 'status' as const,
          stacks: 1,
          appliedAtTick: base.currentTick,
          durationState: { type: 'actions' as const, remainingActions: 2 },
          payload: {
            type: 'status' as const,
            contentVersion: {
              scope: 'campaign' as const,
              contentType: 'status_effect' as const,
              code: 'mana-tax',
              versionNumber: 1,
            },
            profile: statusProfile,
            stacking: statusProfile.stacking,
            baseDuration: statusProfile.duration,
          },
        }],
      }),
    };
    const source = {
      contentActions: [{
        actorRef: 'hero',
        version: {
          profile: spellProfile,
          versionNumber: 1,
          rulesetVersionId: 'ruleset',
          contentDefinition: {
            campaignId: 'campaign',
            contentType: 'SPELL',
            code: 'costly-spell',
            status: 'ACTIVE',
          },
          sourceEffectBindings: [],
        },
      }],
      inventoryActions: [],
    } as unknown as EncounterActionCatalogSource;
    const spellValidation = validateCoreV1ContentProfile(spellProfile);
    if (!spellValidation.ok) throw new Error(JSON.stringify(spellValidation.issues));
    const authority = {
      actor: { id: 'hero-id', code: 'hero' },
      inventory: { modifiers: [], inventory: { entries: [] } },
    } as unknown as PersistedEncounterAuthority;
    const authorities = new Map([['hero', authority]]);
    const taxedAction = projectEncounterActionCatalog(source, {
      state: taxed,
      authorities,
    }).get('hero')?.abilities[0];
    const untaxedAction = projectEncounterActionCatalog(source, {
      state: {
        ...taxed,
        participants: taxed.participants.map((entry) => entry.actorRef === 'hero'
          ? { ...entry, activeEffects: [] } : entry),
      },
      authorities,
    }).get('hero')?.abilities[0];

    expect(taxedAction).toMatchObject({
      cost: { type: 'mana', amount: 10 },
      canUse: false,
      blockers: ['insufficient_mana'],
    });
    expect(untaxedAction).toMatchObject({
      cost: { type: 'mana', amount: 5 },
      canUse: true,
    });
  });
});
