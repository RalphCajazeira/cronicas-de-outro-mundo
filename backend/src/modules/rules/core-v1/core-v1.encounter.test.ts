import { describe, expect, it } from 'vitest';
import {
  applyCoreV1EncounterActionPlan,
  applyCoreV1EncounterIntent,
  calculateSecondaryAttributes,
  compareTimelineEvents,
  compileCoreV1EncounterAction,
  createCoreV1EmptyEquipmentLoadout,
  createCoreV1EncounterState,
  getInitialAttributePreset,
  processCoreV1EncounterBatch,
  processNextCoreV1EncounterEvent,
  resolveCoreV1EncounterTargets,
  scheduleCoreV1EncounterAction,
  validateCoreV1EncounterState,
} from './index.js';
import type {
  CoreV1CreateEncounterInput,
  CoreV1EncounterActionDefinition,
  CoreV1EncounterEvent,
  CoreV1EncounterActionIntent,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterParticipantRelation,
  CoreV1EncounterResult,
  CoreV1EncounterRuntime,
  CoreV1EncounterState,
  CoreV1EncounterTargetCandidate,
  CoreV1EncounterTargetingContext,
  CoreV1MechanicalContentProfile,
  PrimaryAttributes,
} from './index.js';

const balanced = getInitialAttributePreset('balanced');
const physicalSpeed = {
  attributes: balanced,
  weaponFamilyRank: 0,
  weaponWeightUnits: 10,
  twoHanded: false,
  carriedWeightUnits: 0,
  carryingCapacityUnits: 100,
} as const;

function expectOk<T>(result: CoreV1EncounterResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(
    result.issues,
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value,
  ));
  return result.value;
}

function expectInvalid<T>(result: CoreV1EncounterResult<T>, rule?: string): void {
  expect(result).toMatchObject({
    ok: false,
    code: 'INVALID_CORE_V1_ENCOUNTER_OPERATION',
    retryable: true,
  });
  if (!result.ok && rule !== undefined) {
    expect(result.issues.some((entry) => entry.rule === rule)).toBe(true);
  }
}

function participant(
  actorRef: string,
  sideRef: string,
  overrides: Partial<CoreV1EncounterParticipantInput> = {},
): CoreV1EncounterParticipantInput {
  const primaryAttributes: PrimaryAttributes = overrides.primaryAttributes ?? balanced;
  return {
    actorRef,
    sideRef,
    actorStateVersion: 1,
    mechanicsStateVersion: 1,
    inventoryStateVersion: 1,
    effectsStateVersion: 1,
    zone: 'engaged',
    combatState: 'ready',
    primaryAttributes,
    resources: {
      hp: { current: 100, maximum: 100 },
      mana: { current: 100, maximum: 100 },
      sp: { current: 100, maximum: 100 },
      customResources: [],
    },
    secondaryAttributes: calculateSecondaryAttributes({
      attributes: primaryAttributes,
      weaponFamilyRank: 0,
      magicSchoolRank: 0,
      accuracyRank: 0,
      evasionRank: 0,
      encumbrancePenalty: 0,
    }),
    activeEffects: [],
    actionSlots: [{
      slotRef: 'primary',
      slotType: 'primary',
      nextActionAtTick: 0n,
      lastActionAtTick: null,
      allowedActionTags: ['attack', 'spell', 'item', 'movement', 'wait'],
      potencyMultiplierBps: 10_000,
      stateVersion: 1,
    }],
    reactionCapabilities: [],
    equipmentContext: {
      inventory: { entries: [] },
      loadout: createCoreV1EmptyEquipmentLoadout(),
      requirements: {
        level: 1,
        primaryAttributes,
        knownContentRefs: [],
        equippedWeaponTags: [],
        equippedEquipmentTags: [],
        rulesetCode: 'core-v1',
      },
    },
    initiative: { tieBreak: actorRef.charCodeAt(0), surprised: false },
    ...overrides,
  };
}

function allRelations(participants: readonly CoreV1EncounterParticipantInput[]): CoreV1EncounterParticipantRelation[] {
  const values: CoreV1EncounterParticipantRelation[] = [];
  for (let left = 0; left < participants.length; left += 1) {
    for (let right = left; right < participants.length; right += 1) {
      const a = participants[left];
      const b = participants[right];
      if (a === undefined || b === undefined) continue;
      values.push({
        leftActorRef: a.actorRef,
        rightActorRef: b.actorRef,
        relation: left === right ? 'self' : a.sideRef === b.sideRef ? 'ally' : 'hostile',
      });
    }
  }
  return values;
}

function encounterInput(
  participants: readonly CoreV1EncounterParticipantInput[],
  overrides: Partial<CoreV1CreateEncounterInput> = {},
): CoreV1CreateEncounterInput {
  return {
    encounterRef: 'encounter-test',
    partySideRef: 'party',
    currentTick: 0n,
    status: 'active',
    participants,
    relations: allRelations(participants),
    ...overrides,
  };
}

const runtime: CoreV1EncounterRuntime = {
  rolls: {
    tieBreak: ({ actorRef }) => actorRef.charCodeAt(0),
    effectRolls: () => ({ hitRollBps: 1, criticalRollBps: 10_000, concentrationRoll: 1 }),
  },
  reactionOutcomes: {
    resolve: ({ reactionKind }) => reactionKind === 'block'
      ? { kind: 'block', success: true, blockValue: 3, completeBlock: false }
      : reactionKind === 'active_dodge'
        ? { kind: 'active_dodge', success: true }
        : reactionKind === 'interrupt'
          ? { kind: 'interrupt', success: true }
          : { kind: 'counter_attack', success: true },
  },
};

function readyEncounter(inputs: readonly CoreV1EncounterParticipantInput[]): CoreV1EncounterState {
  const created = expectOk(createCoreV1EncounterState(encounterInput(inputs)));
  return expectOk(processCoreV1EncounterBatch(created, runtime)).encounterAfter;
}

function candidates(
  state: CoreV1EncounterState,
  ranges: Readonly<Record<string, CoreV1EncounterTargetCandidate['rangeBand']>> = {},
  sourceActorRef = 'hero',
): CoreV1EncounterTargetCandidate[] {
  const source = state.participants.find((entry) => entry.actorRef === sourceActorRef);
  if (source === undefined) return [];
  return state.participants.map((entry, stableOrder) => ({
    actorRef: entry.actorRef,
    relation: entry.actorRef === source.actorRef
      ? 'self'
      : entry.sideRef === source.sideRef ? 'ally' : 'hostile',
    rangeBand: ranges[entry.actorRef] ?? (entry.actorRef === source.actorRef ? 'engaged' : entry.zone),
    targetable: entry.combatState !== 'removed',
    active: entry.combatState !== 'removed' && entry.resources.hp.current > 0,
    hpCurrent: entry.resources.hp.current,
    hpMaximum: entry.resources.hp.maximum,
    stableOrder,
  }));
}

const strikeProfile: CoreV1MechanicalContentProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'skill',
  code: 'strike',
  name: 'Strike',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'sp', amount: 4 },
  actionProfile: 'normal',
  effects: [{
    type: 'damage',
    targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
    damageComponents: [{
      id: 'strike-hit', channel: 'physical', element: null,
      baseDamage: 8, scaling: 'full', canCrit: true,
    }],
  }],
};

function definition(
  profile: CoreV1MechanicalContentProfile = strikeProfile,
  overrides: Partial<CoreV1EncounterActionDefinition> = {},
): CoreV1EncounterActionDefinition {
  return {
    actionSource: 'content',
    actionKind: 'physical',
    profile,
    contentRef: { scope: 'world', contentType: profile.contentKind, code: profile.code, versionNumber: 1 },
    actionTags: ['attack'],
    fullPrimaryAction: true,
    allowedRelations: ['hostile'],
    effectRefs: ['effect-hit'],
    physicalSpeed,
    interruptible: true,
    blockable: true,
    dodgeable: true,
    canRetargetBeforeEffect: false,
    ...overrides,
  };
}

function intent(overrides: Partial<CoreV1EncounterActionIntent> = {}): CoreV1EncounterActionIntent {
  return {
    intentRef: 'intent-one',
    sourceActorRef: 'hero',
    slotRef: 'primary',
    actionSource: 'content',
    targetSelector: 'explicit',
    requestedTargetRefs: ['enemy'],
    contentRef: { scope: 'world', contentType: 'skill', code: 'strike', versionNumber: 1 },
    ...overrides,
  };
}

function sourceInvalidationWithRemainingEffects(includeAlly: boolean) {
  const state = readyEncounter([
    participant('hero', 'party'),
    ...(includeAlly ? [participant('ally', 'party')] : []),
    participant('enemy', 'hostile'),
    participant('enemy-two', 'hostile'),
    participant('enemy-three', 'hostile'),
  ]);
  const profile: CoreV1MechanicalContentProfile = {
    ...strikeProfile,
    code: 'triple-strike',
    name: 'Triple Strike',
    effects: [{
      type: 'damage',
      targeting: {
        type: 'multi_target', rangeBand: 'engaged', maxTargets: 3,
        damageMultiplierPerTargetBps: [3400, 3300, 3300],
      },
      damageComponents: [{
        id: 'triple-hit', channel: 'physical', element: null,
        baseDamage: 8, scaling: 'full', canCrit: true,
      }],
    }],
  };
  const compiled = expectOk(compileCoreV1EncounterAction({
    encounter: state,
    intent: intent({
      contentRef: { scope: 'world', contentType: 'skill', code: 'triple-strike', versionNumber: 1 },
      requestedTargetRefs: ['enemy', 'enemy-two', 'enemy-three'],
    }),
    definition: definition(profile),
    targetingContext: { candidates: candidates(state) },
  }));
  const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
  const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
  const firstEffect = expectOk(processNextCoreV1EncounterEvent(started.encounterAfter, runtime));
  const sourceRemoved = {
    ...firstEffect.encounterAfter,
    participants: firstEffect.encounterAfter.participants.map((entry) => entry.actorRef === 'hero'
      ? { ...entry, combatState: 'removed' as const }
      : entry),
  };
  return { actionRef: compiled.actionRef, firstEffect, sourceRemoved };
}

function remainingExecutionEvents(state: CoreV1EncounterState, actionRef: string) {
  return state.scheduledEvents.filter((event) => event.actionRef === actionRef
    && ['action_effect', 'movement_effect', 'channel_pulse', 'upkeep_due'].includes(event.type));
}

function mandatoryAndOptionalInvalidation(
  order: 'mandatory_first' | 'optional_first',
) {
  const mandatorySourceRef = order === 'mandatory_first' ? 'z-hero' : 'a-hero';
  const optionalSourceRef = order === 'mandatory_first' ? 'a-enemy' : 'z-enemy';
  const optionalTargetRef = 'target-party';
  const state = readyEncounter([
    participant(mandatorySourceRef, 'party'),
    participant('ally', 'party'),
    participant(optionalTargetRef, 'party'),
    participant(optionalSourceRef, 'hostile'),
    participant('planner', 'hostile'),
  ]);
  const mandatoryAction = expectOk(compileCoreV1EncounterAction({
    encounter: state,
    intent: intent({
      intentRef: 'mandatory-action', sourceActorRef: mandatorySourceRef,
      requestedTargetRefs: [optionalSourceRef],
    }),
    definition: definition(),
    targetingContext: { candidates: candidates(state, {}, mandatorySourceRef) },
  }));
  const mandatoryScheduled = expectOk(scheduleCoreV1EncounterAction(state, mandatoryAction));
  const mandatoryStarted = expectOk(processNextCoreV1EncounterEvent(mandatoryScheduled, runtime));
  const optionalAction = expectOk(compileCoreV1EncounterAction({
    encounter: mandatoryStarted.encounterAfter,
    intent: intent({
      intentRef: 'optional-action', sourceActorRef: optionalSourceRef,
      requestedTargetRefs: [optionalTargetRef],
    }),
    definition: definition(),
    targetingContext: { candidates: candidates(mandatoryStarted.encounterAfter, {}, optionalSourceRef) },
  }));
  const optionalScheduled = expectOk(scheduleCoreV1EncounterAction(
    mandatoryStarted.encounterAfter,
    optionalAction,
  ));
  const optionalStarted = expectOk(processNextCoreV1EncounterEvent(optionalScheduled, runtime));
  const encounter = {
    ...optionalStarted.encounterAfter,
    participants: optionalStarted.encounterAfter.participants.map((entry) => (
      entry.actorRef === mandatorySourceRef || entry.actorRef === optionalTargetRef
        ? { ...entry, combatState: 'removed' as const }
        : entry
    )),
  };
  return {
    encounter,
    mandatoryActionRef: mandatoryAction.actionRef,
    optionalActionRef: optionalAction.actionRef,
    plannerActorRef: 'planner',
  };
}

describe('core-v1 encounter state and initiative', () => {
  it('creates an empty pure encounter with versioned identity and defensive copies', () => {
    const input = encounterInput([]);
    const created = expectOk(createCoreV1EncounterState(input));
    expect(created).toMatchObject({
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      encounterRulesCode: 'core-v1-encounter-v1',
      currentTick: 0n,
      stateVersion: 1,
      actionSequence: 1,
    });
    expect(created.participants).toEqual([]);
    expect(created).not.toBe(input);
    expect(input).toEqual(encounterInput([]));
  });

  it('accepts 64 participants, rejects 65, duplicate refs, negative and over-limit ticks', () => {
    const sixtyFour = Array.from({ length: 64 }, (_, index) => participant(`actor-${index}`, index < 32 ? 'party' : 'hostile'));
    expect(createCoreV1EncounterState(encounterInput(sixtyFour)).ok).toBe(true);
    const sixtyFive = [...sixtyFour, participant('actor-64', 'hostile')];
    expectInvalid(createCoreV1EncounterState(encounterInput(sixtyFive)), 'PARTICIPANT_LIMIT');
    expectInvalid(createCoreV1EncounterState(encounterInput([
      participant('same', 'party'), participant('same', 'hostile'),
    ])), 'DUPLICATE_ACTOR_REF');
    expectInvalid(createCoreV1EncounterState(encounterInput([], { currentTick: -1n })), 'INVALID_ENCOUNTER_INPUT');
    expect(createCoreV1EncounterState(encounterInput([], { currentTick: 1_000_000_000n })).ok).toBe(true);
    expectInvalid(createCoreV1EncounterState(encounterInput([], { currentTick: 1_000_000_001n })), 'INVALID_ENCOUNTER_INPUT');
  });

  it('rejects invalid refs, stale state versions and incomplete/asymmetric relation composition', () => {
    expectInvalid(createCoreV1EncounterState(encounterInput([participant('BAD REF', 'party')])), 'PUBLIC_REF');
    const state = expectOk(createCoreV1EncounterState(encounterInput([participant('hero', 'party')])));
    expectInvalid(validateCoreV1EncounterState({ ...state, stateVersion: 0 }), 'POSITIVE_STATE_VERSION');
    expectInvalid(validateCoreV1EncounterState({ ...state, metadata: { free: true } }), 'UNKNOWN_FIELD');
    expectInvalid(createCoreV1EncounterState({
      ...encounterInput([participant('hero', 'party'), participant('enemy', 'hostile')]),
      relations: [{ leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' }],
    }), 'RELATION_COVERAGE');
  });

  it('calculates balanced, fast, slow and surprise initiative and orders same-tick ties deterministically', () => {
    const fast = { ...balanced, agility: 15, perception: 15 };
    const slow = { ...balanced, agility: 6, perception: 6 };
    const created = expectOk(createCoreV1EncounterState(encounterInput([
      participant('balanced', 'party'),
      participant('fast', 'party', { primaryAttributes: fast }),
      participant('slow', 'hostile', { primaryAttributes: slow }),
      participant('surprised', 'hostile', { initiative: { tieBreak: 9, surprised: true } }),
    ])));
    const byRef = new Map(created.participants.map((entry) => [entry.actorRef, entry.initiative]));
    expect(byRef.get('fast')?.score).toBeGreaterThan(byRef.get('balanced')?.score ?? 0);
    expect(byRef.get('slow')?.score).toBeLessThan(byRef.get('balanced')?.score ?? 0);
    expect(byRef.get('surprised')?.firstReadyTick).toBeGreaterThan(byRef.get('balanced')?.firstReadyTick ?? 0n);
    const firstTick = created.scheduledEvents[0]?.timelineEvent.tick;
    const sameTick = created.scheduledEvents.filter((event) => event.timelineEvent.tick === firstTick);
    expect(sameTick.map((event) => event.eventRef)).toEqual(
      [...sameTick].sort((a, b) => b.timelineEvent.initiativeScore - a.timelineEvent.initiativeScore
        || b.timelineEvent.rngTieBreak - a.timelineEvent.rngTieBreak
      || a.timelineEvent.stableRef.localeCompare(b.timelineEvent.stableRef)).map((event) => event.eventRef),
    );
    const injected = expectOk(createCoreV1EncounterState(
      encounterInput([participant('hero', 'party')]),
      { tieBreak: () => 777 },
    ));
    expect(injected.participants[0]?.initiative.tieBreak).toBe(777);
  });

  it('caps batches at 32 events and 5000 ticks without iterating tick by tick', () => {
    const inputs = Array.from({ length: 64 }, (_, index) => participant(
      `batch-${index}`,
      index < 32 ? 'party' : 'hostile',
    ));
    const state = expectOk(createCoreV1EncounterState(encounterInput(inputs)));
    const capped = expectOk(processCoreV1EncounterBatch(state, runtime));
    expect(capped.processedEvents).toHaveLength(32);
    expect(capped).toMatchObject({ stopReason: 'processing_limit', continuationRequired: true });

    const one = expectOk(createCoreV1EncounterState(encounterInput([participant('hero', 'party')])));
    const delayed: CoreV1EncounterState = {
      ...one,
      scheduledEvents: one.scheduledEvents.map((event) => ({
        ...event,
        timelineEvent: { ...event.timelineEvent, tick: 5001n },
      })),
    };
    const timeCapped = expectOk(processCoreV1EncounterBatch(delayed, runtime));
    expect(timeCapped.processedEvents).toEqual([]);
    expect(timeCapped).toMatchObject({ stopReason: 'processing_limit', continuationRequired: true });
  });
});

describe('core-v1 encounter targeting', () => {
  const state = readyEncounter([
    participant('hero', 'party'),
    participant('ally', 'party', { resources: { hp: { current: 30, maximum: 100 }, mana: { current: 100, maximum: 100 }, sp: { current: 100, maximum: 100 }, customResources: [] } }),
    participant('enemy', 'hostile', { resources: { hp: { current: 40, maximum: 100 }, mana: { current: 100, maximum: 100 }, sp: { current: 100, maximum: 100 }, customResources: [] } }),
    participant('enemy-two', 'hostile', { zone: 'near', resources: { hp: { current: 1, maximum: 4 }, mana: { current: 100, maximum: 100 }, sp: { current: 100, maximum: 100 }, customResources: [] } }),
    participant('enemy-three', 'hostile', { zone: 'medium' }),
  ]);
  const context: CoreV1EncounterTargetingContext = { candidates: candidates(state) };

  it('resolves self, explicit single and weapon attack without accepting duplicate refs', () => {
    expect(expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'self', rangeBand: 'self' },
      selector: 'self', requestedTargetRefs: ['enemy'], allowedRelations: ['self'], context,
    }))).toEqual([{ targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000, effectTickOffset: 0n }]);
    for (const type of ['single_target', 'weapon_attack'] as const) {
      expect(expectOk(resolveCoreV1EncounterTargets({
        encounter: state, sourceActorRef: 'hero', targeting: { type, rangeBand: 'engaged', ...(type === 'single_target' ? { maxTargets: 1 } : {}) },
        selector: 'explicit', requestedTargetRefs: ['enemy'], allowedRelations: ['hostile'], context,
      }))[0]?.targetRef).toBe('enemy');
    }
    expectInvalid(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
      selector: 'explicit', requestedTargetRefs: ['enemy', 'enemy'], allowedRelations: ['hostile'], context,
    }), 'DUPLICATE_TARGET_REF');
  });

  it('uses zone/stable order for nearest and exact integer ratios for lowest HP', () => {
    const nearest = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'medium', maxTargets: 1 },
      selector: 'nearest_hostile', requestedTargetRefs: [], allowedRelations: ['hostile'], context,
    }));
    expect(nearest[0]?.targetRef).toBe('enemy');
    const lowest = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'medium', maxTargets: 1 },
      selector: 'lowest_hp_hostile', requestedTargetRefs: [], allowedRelations: ['hostile'], context,
    }));
    expect(lowest[0]?.targetRef).toBe('enemy-two');
    const ally = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
      selector: 'nearest_ally', requestedTargetRefs: [], allowedRelations: ['ally'], context,
    }));
    expect(ally[0]?.targetRef).toBe('ally');
  });

  it('resolves multi-target and area with independent ordered targets and a 150% budget', () => {
    const multiTarget = {
      type: 'multi_target', rangeBand: 'medium', maxTargets: 3,
      damageMultiplierPerTargetBps: [6000, 4500, 4500],
    } as const;
    const multi = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: multiTarget,
      selector: 'explicit', requestedTargetRefs: ['enemy-three', 'enemy', 'enemy-two'],
      allowedRelations: ['hostile'], context,
    }));
    expect(multi.map((target) => target.damageMultiplierBps)).toEqual([6000, 4500, 4500]);
    expect(multi.reduce((total, target) => total + target.damageMultiplierBps, 0)).toBe(15_000);
    const area = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: {
        type: 'area', rangeBand: 'medium', maxTargets: 3, areaShape: 'burst',
        damageMultiplierPerTargetBps: [5000, 5000, 5000],
      },
      selector: 'explicit', requestedTargetRefs: [], allowedRelations: ['hostile'],
      context: { ...context, spatialCandidateRefs: ['enemy-two', 'enemy', 'enemy-three'] },
    }));
    expect(area.map((target) => target.targetRef)).toEqual(['enemy', 'enemy-two', 'enemy-three']);
    expectInvalid(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: {
        type: 'area', rangeBand: 'medium', maxTargets: 3, areaShape: 'burst',
        damageMultiplierPerTargetBps: [5000, 5000, 5000],
      },
      selector: 'explicit', requestedTargetRefs: [], allowedRelations: ['hostile'], context,
    }), 'REQUIRES_SPATIAL_ADAPTER');
  });

  it('resolves chain intervals and closed ranges, and cleave keeps the primary at ordinal zero', () => {
    const chain = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: {
        type: 'chain', rangeBand: 'medium', maxTargets: 3, chainCount: 3,
        chainInterval: 50, targetFalloffBps: 1000, damageMultiplierPerTargetBps: [6000, 5000, 4000],
      },
      selector: 'explicit', requestedTargetRefs: ['enemy'], allowedRelations: ['hostile'],
      context: {
        ...context,
        candidateRanges: [
          { fromActorRef: 'enemy', toActorRef: 'enemy-two', rangeBand: 'near' },
          { fromActorRef: 'enemy-two', toActorRef: 'enemy-three', rangeBand: 'near' },
        ],
      },
    }));
    expect(chain.map((target) => target.effectTickOffset)).toEqual([0n, 50n, 100n]);
    expect(new Set(chain.map((target) => target.targetRef)).size).toBe(3);
    const cleave = expectOk(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: {
        type: 'cleave', rangeBand: 'medium', maxTargets: 3,
        damageMultiplierPerTargetBps: [10_000, 2500, 2500],
      }, selector: 'explicit', requestedTargetRefs: ['enemy-three'], allowedRelations: ['hostile'],
      context: { ...context, spatialCandidateRefs: ['enemy-two', 'enemy'] },
    }));
    expect(cleave[0]).toMatchObject({ targetRef: 'enemy-three', targetOrdinal: 0, damageMultiplierBps: 10_000 });
  });

  it('rejects removed, zero-HP, out-of-range and empty target sets', () => {
    const removedState = {
      ...state,
      participants: state.participants.map((entry) => entry.actorRef === 'enemy'
        ? { ...entry, combatState: 'removed' as const } : entry),
    };
    const badContext = { candidates: candidates(removedState, { 'enemy-two': 'out_of_range' }) };
    for (const ref of ['enemy', 'enemy-two'] as const) {
      expectInvalid(resolveCoreV1EncounterTargets({
        encounter: removedState, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
        selector: 'explicit', requestedTargetRefs: [ref], allowedRelations: ['hostile'], context: badContext,
      }), 'NO_VALID_TARGET');
    }
    expectInvalid(resolveCoreV1EncounterTargets({
      encounter: state, sourceActorRef: 'hero', targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
      selector: 'explicit', requestedTargetRefs: [], allowedRelations: ['hostile'], context,
    }), 'NO_VALID_TARGET');
  });
});

describe('core-v1 action compile, timeline and effects composition', () => {
  function setup() {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    return { state, context: { candidates: candidates(state) } };
  }

  function terminalSourceInvalidation(includeAlly: boolean) {
    const state = readyEncounter([
      participant('hero', 'party'),
      ...(includeAlly ? [participant('ally', 'party')] : []),
      participant('enemy', 'hostile'),
      participant('enemy-two', 'hostile'),
    ]);
    const profile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'double-strike',
      name: 'Double Strike',
      effects: [{
        type: 'damage',
        targeting: {
          type: 'multi_target', rangeBand: 'engaged', maxTargets: 2,
          damageMultiplierPerTargetBps: [5000, 5000],
        },
        damageComponents: [{
          id: 'double-hit', channel: 'physical', element: null,
          baseDamage: 8, scaling: 'full', canCrit: true,
        }],
      }],
    };
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({
        contentRef: { scope: 'world', contentType: 'skill', code: 'double-strike', versionNumber: 1 },
        requestedTargetRefs: ['enemy', 'enemy-two'],
      }),
      definition: definition(profile),
      targetingContext: { candidates: candidates(state) },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    const firstEffect = expectOk(processNextCoreV1EncounterEvent(started.encounterAfter, runtime));
    const sourceRemoved = {
      ...firstEffect.encounterAfter,
      participants: firstEffect.encounterAfter.participants.map((entry) => entry.actorRef === 'hero'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
    };
    return {
      actionRef: compiled.actionRef,
      firstEffect,
      sourceRemoved,
      invalidated: expectOk(processNextCoreV1EncounterEvent(sourceRemoved, runtime)),
    };
  }

  it('compiles preparation/effect/recovery without rolls and schedules through the existing queue', () => {
    const { state, context } = setup();
    const before = structuredClone(state);
    const compiled = expectOk(compileCoreV1EncounterAction({ encounter: state, intent: intent(), definition: definition(), targetingContext: context }));
    expect(compiled.startTick).toBe(state.currentTick);
    expect(compiled.effectTick).toBe(compiled.startTick + compiled.preparationTicks);
    expect(compiled.nextActionAtTick).toBe(compiled.effectTick + compiled.recoveryTicks);
    expect(compiled.internalEvents.map((event) => event.type)).toEqual(['action_started', 'action_effect', 'actor_ready']);
    expect(state).toEqual(before);
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    expect(scheduled.scheduledEvents.length).toBe(3);
    expectInvalid(scheduleCoreV1EncounterAction(scheduled, compiled), 'ACTION_SEQUENCE');
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state,
      intent: { ...intent(), damage: 999 } as never,
      definition: definition(),
      targetingContext: context,
    }), 'UNKNOWN_FIELD');
  });

  it('matches authoritative content refs by identity instead of property insertion order', () => {
    const { state, context } = setup();
    const reorderedContentRef = {
      versionNumber: 1,
      code: 'strike',
      contentType: 'skill' as const,
      scope: 'world' as const,
    };
    expect(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ contentRef: reorderedContentRef }),
      definition: definition(),
      targetingContext: context,
    }).ok).toBe(true);
  });

  it('jumps to events, processes same-tick sequentially and rejects past/duplicate queue sequences', () => {
    const { state, context } = setup();
    const compiled = expectOk(compileCoreV1EncounterAction({ encounter: state, intent: intent(), definition: definition(), targetingContext: context }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    expect(started.encounterAfter.currentTick).toBe(compiled.startTick);
    const effect = expectOk(processNextCoreV1EncounterEvent(started.encounterAfter, runtime));
    expect(effect.encounterAfter.currentTick).toBe(compiled.effectTick);
    const duplicate = { ...scheduled, scheduledEvents: [scheduled.scheduledEvents[0], scheduled.scheduledEvents[0]] } as CoreV1EncounterState;
    expectInvalid(validateCoreV1EncounterState(duplicate), 'EVENT_QUEUE');
    const past = { ...scheduled, currentTick: compiled.effectTick + 1n };
    expectInvalid(validateCoreV1EncounterState(past), 'EVENT_QUEUE');
  });

  it('terminalizes an action when its last effect is invalidated before resolution', () => {
    const { state, context } = setup();
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state, intent: intent(), definition: definition(), targetingContext: context,
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    const targetRemoved = {
      ...started.encounterAfter,
      participants: started.encounterAfter.participants.map((entry) => entry.actorRef === 'enemy'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
    };
    const invalidated = expectOk(processNextCoreV1EncounterEvent(targetRemoved, runtime));
    expect(invalidated.invalidatedEvents.some((entry) => entry.event.type === 'action_effect')).toBe(true);
    expect(invalidated.stopReason).toBe('encounter_completed');
    expect(invalidated.continuationRequired).toBe(false);
    expect(invalidated.encounterAfter.activeActions[0]?.state).toBe('invalidated');
    const readied = expectOk(processNextCoreV1EncounterEvent(invalidated.encounterAfter, runtime));
    expect(readied.encounterAfter.activeActions).toEqual([]);
    expect(readied.resolvedActions).toEqual([]);
  });

  it('prioritizes encounter completion when a partially applied action loses its source', () => {
    const { actionRef, firstEffect, sourceRemoved, invalidated } = terminalSourceInvalidation(false);
    expect(firstEffect.effectResolutions).toHaveLength(1);
    expect(invalidated.invalidatedEvents[0]?.reason).toBe('STATE_CHANGED');
    expect(invalidated.stopReason).toBe('encounter_completed');
    expect(invalidated.continuationRequired).toBe(false);
    expect(invalidated.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(invalidated.encounterAfter.activeActions[0]?.state).toBe('invalidated');
    expect(invalidated.resolvedActions).not.toContain(actionRef);
    const batch = expectOk(processCoreV1EncounterBatch(sourceRemoved, runtime));
    expect(batch.stopReason).toBe('encounter_completed');
    expect(batch.continuationRequired).toBe(false);
    expect(batch.resolvedActions).not.toContain(actionRef);
  });

  it('requires a new intent when terminal source invalidation leaves an actionable ally', () => {
    const { actionRef, firstEffect, sourceRemoved, invalidated } = terminalSourceInvalidation(true);
    expect(firstEffect.effectResolutions).toHaveLength(1);
    expect(invalidated.invalidatedEvents[0]?.reason).toBe('STATE_CHANGED');
    expect(invalidated.stopReason).toBe('new_intent_required');
    expect(invalidated.continuationRequired).toBe(true);
    expect(invalidated.encounterAfter.completionCandidate).toBeNull();
    expect(invalidated.encounterAfter.activeActions[0]?.state).toBe('invalidated');
    expect(invalidated.resolvedActions).not.toContain(actionRef);
    const batch = expectOk(processCoreV1EncounterBatch(sourceRemoved, runtime));
    expect(batch.stopReason).toBe('new_intent_required');
    expect(batch.continuationRequired).toBe(true);
    expect(batch.resolvedActions).not.toContain(actionRef);
  });

  it('defers encounter completion while an invalidated source still has execution events', () => {
    const { actionRef, firstEffect, sourceRemoved } = sourceInvalidationWithRemainingEffects(false);
    const intermediate = expectOk(processNextCoreV1EncounterEvent(sourceRemoved, runtime));
    expect(firstEffect.effectResolutions).toHaveLength(1);
    expect(intermediate.invalidatedEvents[0]?.reason).toBe('STATE_CHANGED');
    expect(intermediate.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(intermediate.stopReason).not.toBe('encounter_completed');
    expect(intermediate.stopReason).toBeNull();
    expect(intermediate.continuationRequired).toBe(false);
    expect(intermediate.resolvedActions).not.toContain(actionRef);
    expect(intermediate.encounterAfter.activeActions.find((action) => action.actionRef === actionRef)?.state)
      .toBe('active');
    expect(remainingExecutionEvents(intermediate.encounterAfter, actionRef)).toHaveLength(1);
  });

  it('terminalizes the action before promoting completion on its final invalid event', () => {
    const { actionRef, sourceRemoved } = sourceInvalidationWithRemainingEffects(false);
    const intermediate = expectOk(processNextCoreV1EncounterEvent(sourceRemoved, runtime));
    const terminal = expectOk(processNextCoreV1EncounterEvent(intermediate.encounterAfter, runtime));
    expect(terminal.invalidatedEvents[0]?.reason).toBe('STATE_CHANGED');
    expect(terminal.encounterAfter.activeActions.find((action) => action.actionRef === actionRef)?.state)
      .toBe('invalidated');
    expect(terminal.resolvedActions).not.toContain(actionRef);
    expect(terminal.stopReason).toBe('encounter_completed');
    expect(terminal.continuationRequired).toBe(false);
    expect(terminal.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(remainingExecutionEvents(terminal.encounterAfter, actionRef)).toEqual([]);
  });

  it('drains all invalid execution events before a completed batch is reported', () => {
    const { actionRef, sourceRemoved } = sourceInvalidationWithRemainingEffects(false);
    const batch = expectOk(processCoreV1EncounterBatch(sourceRemoved, runtime));
    expect(batch.invalidatedEvents.filter((entry) => entry.reason === 'STATE_CHANGED')).toHaveLength(2);
    expect(batch.encounterAfter.activeActions.find((action) => action.actionRef === actionRef)?.state)
      .toBe('invalidated');
    expect(batch.resolvedActions).not.toContain(actionRef);
    expect(batch.stopReason).toBe('encounter_completed');
    expect(batch.continuationRequired).toBe(false);
    expect(batch.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(remainingExecutionEvents(batch.encounterAfter, actionRef)).toEqual([]);
  });

  it('requires a new intent only after draining invalid execution events when an ally remains', () => {
    const { actionRef, sourceRemoved } = sourceInvalidationWithRemainingEffects(true);
    const batch = expectOk(processCoreV1EncounterBatch(sourceRemoved, runtime));
    expect(batch.invalidatedEvents.filter((entry) => entry.reason === 'STATE_CHANGED')).toHaveLength(2);
    expect(batch.resolvedActions).not.toContain(actionRef);
    expect(batch.stopReason).toBe('new_intent_required');
    expect(batch.continuationRequired).toBe(true);
    expect(batch.encounterAfter.completionCandidate).toBeNull();
    expect(remainingExecutionEvents(batch.encounterAfter, actionRef)).toEqual([]);
  });

  it('reports no_valid_target when an untouched target is removed while the encounter stays open', () => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('ally', 'party'),
      participant('enemy', 'hostile'),
      participant('enemy-two', 'hostile'),
    ]);
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent(),
      definition: definition(),
      targetingContext: { candidates: candidates(state) },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    const targetRemoved = {
      ...started.encounterAfter,
      participants: started.encounterAfter.participants.map((entry) => entry.actorRef === 'enemy'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
    };
    const invalidated = expectOk(processNextCoreV1EncounterEvent(targetRemoved, runtime));
    expect(invalidated.invalidatedEvents[0]?.reason).toBe('NO_VALID_TARGET');
    expect(invalidated.encounterAfter.activeActions[0]?.state).toBe('invalidated');
    expect(invalidated.resolvedActions).not.toContain(compiled.actionRef);
    expect(invalidated.stopReason).toBe('no_valid_target');
    expect(invalidated.stopReason).not.toBe('new_intent_required');
    expect(invalidated.encounterAfter.completionCandidate).toBeNull();
  });

  it('clears intermediate continuation when a later event completes the batch', () => {
    const state = readyEncounter([
      participant('a-hero', 'party'),
      participant('ally', 'party', {
        resources: {
          hp: { current: 1, maximum: 100 }, mana: { current: 100, maximum: 100 },
          sp: { current: 100, maximum: 100 }, customResources: [],
        },
      }),
      participant('z-enemy', 'hostile'),
    ]);
    const heroAction = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ intentRef: 'hero-intent', sourceActorRef: 'a-hero', requestedTargetRefs: ['z-enemy'] }),
      definition: definition(),
      targetingContext: { candidates: candidates(state, {}, 'a-hero') },
    }));
    const heroScheduled = expectOk(scheduleCoreV1EncounterAction(state, heroAction));
    const heroStarted = expectOk(processNextCoreV1EncounterEvent(heroScheduled, runtime));
    const enemyAction = expectOk(compileCoreV1EncounterAction({
      encounter: heroStarted.encounterAfter,
      intent: intent({ intentRef: 'enemy-intent', sourceActorRef: 'z-enemy', requestedTargetRefs: ['ally'] }),
      definition: definition(),
      targetingContext: { candidates: candidates(heroStarted.encounterAfter, {}, 'z-enemy') },
    }));
    const enemyScheduled = expectOk(scheduleCoreV1EncounterAction(heroStarted.encounterAfter, enemyAction));
    const sourceRemoved = {
      ...enemyScheduled,
      participants: enemyScheduled.participants.map((entry) => entry.actorRef === 'a-hero'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
      scheduledEvents: enemyScheduled.scheduledEvents.map((event) => event.actionRef === heroAction.actionRef
        && event.type === 'action_effect'
        ? { ...event, timelineEvent: { ...event.timelineEvent, tick: enemyScheduled.currentTick } }
        : event).sort((left, right) => compareTimelineEvents(left.timelineEvent, right.timelineEvent)),
    };
    const enemyStarted = expectOk(processNextCoreV1EncounterEvent(sourceRemoved, runtime));
    const intermediate = expectOk(processNextCoreV1EncounterEvent(enemyStarted.encounterAfter, runtime));
    expect(intermediate.stopReason).toBe('new_intent_required');
    expect(intermediate.continuationRequired).toBe(true);
    const batch = expectOk(processCoreV1EncounterBatch(enemyStarted.encounterAfter, runtime));
    expect(batch.invalidatedEvents.some((entry) => entry.reason === 'STATE_CHANGED')).toBe(true);
    expect(batch.stopReason).toBe('encounter_completed');
    expect(batch.continuationRequired).toBe(false);
    expect(batch.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
  });

  it.each([
    ['mandatory_first', ['STATE_CHANGED', 'NO_VALID_TARGET']],
    ['optional_first', ['NO_VALID_TARGET', 'STATE_CHANGED']],
  ] as const)('preserves new_intent_required across %s batch ordering', (order, reasons) => {
    const fixture = mandatoryAndOptionalInvalidation(order);
    const batch = expectOk(processCoreV1EncounterBatch(fixture.encounter, runtime));
    expect(batch.invalidatedEvents.map((entry) => entry.reason)).toEqual(reasons);
    expect(batch.invalidatedEvents.map((entry) => entry.event.actionRef)).toEqual(order === 'mandatory_first'
      ? [fixture.mandatoryActionRef, fixture.optionalActionRef]
      : [fixture.optionalActionRef, fixture.mandatoryActionRef]);
    expect(batch.stopReason).toBe('new_intent_required');
    expect(batch.continuationRequired).toBe(true);
  });

  it('keeps processing_limit authoritative after an optional target loss', () => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('ally', 'party'),
      participant('enemy', 'hostile'),
      participant('enemy-two', 'hostile'),
    ]);
    const action = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent(),
      definition: definition(),
      targetingContext: { candidates: candidates(state) },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, action));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    const delayed = {
      ...started.encounterAfter,
      participants: started.encounterAfter.participants.map((entry) => entry.actorRef === 'enemy'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
      scheduledEvents: started.encounterAfter.scheduledEvents.map((event) => (
        event.actionRef === action.actionRef && event.type === 'actor_ready'
          ? { ...event, timelineEvent: { ...event.timelineEvent, tick: started.encounterAfter.currentTick + 5001n } }
          : event
      )).sort((left, right) => compareTimelineEvents(left.timelineEvent, right.timelineEvent)),
    };
    const batch = expectOk(processCoreV1EncounterBatch(delayed, runtime));
    expect(batch.invalidatedEvents[0]?.reason).toBe('NO_VALID_TARGET');
    expect(batch.stopReason).toBe('processing_limit');
    expect(batch.continuationRequired).toBe(true);
  });

  it('applies single-target damage and action cost once with deterministic rolls', () => {
    const { state, context } = setup();
    const report = expectOk(applyCoreV1EncounterIntent({
      encounter: state, intent: intent(), definition: definition(), targetingContext: context, runtime,
    }));
    const final = expectOk(processCoreV1EncounterBatch(report.encounterAfter, runtime));
    const hero = final.encounterAfter.participants.find((entry) => entry.actorRef === 'hero');
    const enemy = final.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy');
    expect(hero?.resources.sp.current).toBe(96);
    expect(enemy?.resources.hp.current).toBeLessThan(100);
    expect(final.effectResolutions).toHaveLength(1);
    expect(final.readyActors).toContain('hero');
  });

  it('executes Whirlwind against three targets with one cost, separate rolls and target invalidation isolation', () => {
    const inputs = [participant('hero', 'party'), participant('enemy', 'hostile'), participant('enemy-two', 'hostile'), participant('enemy-three', 'hostile')];
    const state = readyEncounter(inputs);
    const profile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'whirlwind', name: 'Golpe Giratório', actionProfile: 'whirlwind', cost: { type: 'sp', amount: 6 },
      effects: [{
        type: 'damage',
        targeting: { type: 'multi_target', rangeBand: 'engaged', maxTargets: 3, damageMultiplierPerTargetBps: [6000, 4500, 4500] },
        damageComponents: [{ id: 'spin', channel: 'physical', element: null, baseDamage: 8, scaling: 'full', canCrit: true }],
      }],
    };
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ contentRef: { scope: 'world', contentType: 'skill', code: 'whirlwind', versionNumber: 1 }, requestedTargetRefs: ['enemy', 'enemy-two', 'enemy-three'] }),
      definition: definition(profile),
      targetingContext: { candidates: candidates(state) },
    }));
    let scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    scheduled = {
      ...scheduled,
      participants: scheduled.participants.map((entry) => entry.actorRef === 'enemy-two'
        ? { ...entry, combatState: 'removed' as const } : entry),
    };
    const report = expectOk(processCoreV1EncounterBatch(scheduled, runtime));
    expect(report.effectResolutions).toHaveLength(2);
    expect(report.invalidatedEvents.some((entry) => entry.event.targetRef === 'enemy-two')).toBe(true);
    expect(report.encounterAfter.participants.find((entry) => entry.actorRef === 'hero')?.resources.sp.current).toBe(94);
  });

  it('executes chain offsets in order with one recovery and invalidates a removed middle target only', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile'), participant('enemy-two', 'hostile'), participant('enemy-three', 'hostile')]);
    const profile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'chain', name: 'Chain', actionProfile: 'normal',
      effects: [{
        type: 'damage',
        targeting: { type: 'chain', rangeBand: 'medium', maxTargets: 3, chainCount: 3, chainInterval: 50, targetFalloffBps: 1000, damageMultiplierPerTargetBps: [6000, 5000, 4000] },
        damageComponents: [{ id: 'chain-hit', channel: 'magical', element: 'lightning', baseDamage: 6, scaling: 'full', canCrit: true }],
      }],
    };
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ contentRef: { scope: 'world', contentType: 'skill', code: 'chain', versionNumber: 1 } }),
      definition: definition(profile),
      targetingContext: {
        candidates: candidates(state),
        candidateRanges: [
          { fromActorRef: 'enemy', toActorRef: 'enemy-two', rangeBand: 'near' },
          { fromActorRef: 'enemy-two', toActorRef: 'enemy-three', rangeBand: 'near' },
        ],
      },
    }));
    expect(compiled.internalEvents.filter((event) => event.type === 'actor_ready')).toHaveLength(1);
    expect(compiled.internalEvents.filter((event) => event.type === 'action_effect').map((event) => event.timelineEvent.tick))
      .toEqual([compiled.effectTick, compiled.effectTick + 50n, compiled.effectTick + 100n]);
  });

  it('uses a consumable on self exactly once through the pure inventory/effects adapter', () => {
    const potionProfile: CoreV1MechanicalContentProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'consumable', code: 'healing-potion', name: 'Healing Potion',
      tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'none' },
      actionProfile: 'potion', consumable: true,
      effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
    };
    const contentVersion = { scope: 'world' as const, contentType: 'consumable' as const, code: 'healing-potion', versionNumber: 1 };
    const hero = participant('hero', 'party', {
      resources: {
        hp: { current: 80, maximum: 100 }, mana: { current: 100, maximum: 100 },
        sp: { current: 100, maximum: 100 }, customResources: [],
      },
      equipmentContext: {
        inventory: { entries: [{
          entryKind: 'stack', entryRef: 'potion-stack', contentVersion,
          inventorySpec: {
            schemaVersion: 1, rulesetCode: 'core-v1', inventoryRulesCode: 'core-v1-inventory-v1',
            unitWeight: 1, stacking: { mode: 'stackable', maxStack: 20 },
          },
          profile: potionProfile, quantity: 1,
        }] },
        loadout: createCoreV1EmptyEquipmentLoadout(),
        requirements: {
          level: 1, primaryAttributes: balanced, knownContentRefs: [],
          equippedWeaponTags: [], equippedEquipmentTags: [], rulesetCode: 'core-v1',
        },
      },
    });
    const state = readyEncounter([hero, participant('enemy', 'hostile')]);
    const potionDefinition = definition(potionProfile, {
      actionSource: 'consumable', actionKind: 'item', contentRef: contentVersion,
      actionTags: ['item'], allowedRelations: ['self'], physicalSpeed,
      interruptible: false, blockable: false, dodgeable: false,
    });
    const potionIntent = intent({
      actionSource: 'consumable', targetSelector: 'self', requestedTargetRefs: [],
      contentRef: contentVersion, weaponEntryRef: 'potion-stack',
    });
    const applied = expectOk(applyCoreV1EncounterIntent({
      encounter: state, intent: potionIntent, definition: potionDefinition,
      targetingContext: { candidates: candidates(state) }, runtime,
    }));
    const report = expectOk(processCoreV1EncounterBatch(applied.encounterAfter, runtime));
    expect(report.invalidatedEvents).toEqual([]);
    expect(report.effectResolutions[0]?.sourceAfter.resources.hp.current).toBe(90);
    const finalHero = report.encounterAfter.participants.find((entry) => entry.actorRef === 'hero');
    expect(finalHero?.resources.hp.current).toBe(90);
    expect(finalHero?.equipmentContext.inventory.entries).toEqual([]);
  });

  it('preserves action cost on miss, injects critical independently and carries updated actors', () => {
    const { state, context } = setup();
    const missRuntime: CoreV1EncounterRuntime = {
      rolls: { ...runtime.rolls, effectRolls: () => ({ hitRollBps: 10_000, criticalRollBps: 1 }) },
    };
    const missed = expectOk(applyCoreV1EncounterIntent({
      encounter: state, intent: intent(), definition: definition(), targetingContext: context, runtime: missRuntime,
    }));
    const missReport = expectOk(processCoreV1EncounterBatch(missed.encounterAfter, missRuntime));
    expect(missReport.encounterAfter.participants.find((entry) => entry.actorRef === 'hero')?.resources.sp.current).toBe(96);
    expect(missReport.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy')?.resources.hp.current).toBe(100);

    const criticalRuntime: CoreV1EncounterRuntime = {
      rolls: { ...runtime.rolls, effectRolls: () => ({ hitRollBps: 1, criticalRollBps: 1 }) },
    };
    const critical = expectOk(applyCoreV1EncounterIntent({
      encounter: state, intent: intent(), definition: definition(), targetingContext: context, runtime: criticalRuntime,
    }));
    const criticalReport = expectOk(processCoreV1EncounterBatch(critical.encounterAfter, criticalRuntime));
    expect(criticalReport.effectResolutions[0]?.damageResults[0]?.critical).toBe(true);
    expect(criticalReport.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy')?.resources.hp.current)
      .toBeLessThan(100);
  });

  it('applies status and temporary modifiers through the existing effect sequence', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const profile: CoreV1MechanicalContentProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'skill', code: 'debilitate', name: 'Debilitate', tier: 1, rarity: 'rare',
      activation: { type: 'active' }, cost: { type: 'sp', amount: 4 }, actionProfile: 'normal',
      targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
      effects: [
        { type: 'apply_status', statusRef: 'burning', duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' } },
        { type: 'modify_secondary_attribute', secondaryCode: 'evasion', amount: -1, duration: { type: 'actions', value: 2 } },
      ],
    };
    const statusProfile: CoreV1MechanicalContentProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'status_effect', code: 'burning', name: 'Burning', tier: 1, rarity: 'common',
      activation: { type: 'passive' }, cost: { type: 'none' },
      duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' },
      passiveModifiers: [{ target: 'physicalDefense', amount: -2, sourceRule: 'status_effect' }],
    };
    const actionDefinition = definition(profile, {
      effectRefs: ['burning-effect', 'evasion-effect'],
      statusDefinitions: [{
        effectIndex: 0,
        effectRef: 'burning-effect',
        contentVersion: { scope: 'world', contentType: 'status_effect', code: 'burning', versionNumber: 1 },
        profile: statusProfile,
      }],
    });
    const applied = expectOk(applyCoreV1EncounterIntent({
      encounter: state,
      intent: intent({ contentRef: { scope: 'world', contentType: 'skill', code: 'debilitate', versionNumber: 1 } }),
      definition: actionDefinition, targetingContext: { candidates: candidates(state) }, runtime,
    }));
    const report = expectOk(processCoreV1EncounterBatch(applied.encounterAfter, runtime));
    expect(report.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy')?.activeEffects
      .map((effect) => effect.kind)).toEqual(['status', 'secondary_modifier']);
  });

  it('fails structurally and for insufficient resources without changing encounter input', () => {
    const low = participant('hero', 'party', {
      resources: {
        hp: { current: 100, maximum: 100 }, mana: { current: 100, maximum: 100 },
        sp: { current: 3, maximum: 100 }, customResources: [],
      },
    });
    const state = readyEncounter([low, participant('enemy', 'hostile')]);
    const before = structuredClone(state);
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state, intent: intent(), definition: definition(),
      targetingContext: { candidates: candidates(state) },
    }), 'INSUFFICIENT_RESOURCE');
    expect(state).toEqual(before);
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state, intent: intent(), definition: { ...definition(), effectRefs: [] },
      targetingContext: { candidates: candidates(state) },
    }), 'EFFECT_REF_COUNT');
    expect(state).toEqual(before);
  });
});

describe('core-v1 reactions, casting, movement, combos and plans', () => {
  function reactive(kind: 'block' | 'active_dodge' | 'interrupt' | 'counter_attack') {
    return {
      capabilityRef: `${kind}-capability`,
      kind,
      tier: 1,
      cost: kind === 'active_dodge' ? { type: 'special_dodge' as const, sp: 3 } : { type: 'active_defense' as const, sp: 2 },
      ...(kind === 'block' ? { blockValue: 3 } : {}),
    };
  }

  function interleavedPlan(
    mode: 'target_invalidated' | 'source_invalidated',
    stopConditions: readonly ('noValidTarget' | 'targetSetChangedMaterially')[] = [],
  ) {
    const heroAttributes = getInitialAttributePreset('physical');
    const auxiliaryAttributes = getInitialAttributePreset('magical');
    const hero = participant('hero', 'party', {
      primaryAttributes: heroAttributes,
      ...(mode === 'source_invalidated' ? {
        resources: {
          hp: { current: 1, maximum: 100 }, mana: { current: 100, maximum: 100 },
          sp: { current: 100, maximum: 100 }, customResources: [],
        },
      } : {}),
    });
    const auxiliary = participant(
      'late-actor',
      mode === 'target_invalidated' ? 'party' : 'hostile',
      { primaryAttributes: auxiliaryAttributes },
    );
    const firstTargetRef = mode === 'target_invalidated' ? 'enemy' : 'late-actor';
    const secondTarget = participant('enemy-two', 'hostile', mode === 'target_invalidated' ? {
      resources: {
        hp: { current: 1, maximum: 100 }, mana: { current: 100, maximum: 100 },
        sp: { current: 100, maximum: 100 }, customResources: [],
      },
    } : {});
    const state = readyEncounter([
      hero,
      participant('ally', 'party'),
      auxiliary,
      ...(firstTargetRef === 'enemy' ? [participant('enemy', 'hostile')] : []),
      secondTarget,
    ]);
    const auxiliaryTargetRef = mode === 'target_invalidated' ? 'enemy-two' : 'hero';
    const auxiliaryIntent = intent({
      intentRef: 'auxiliary-intent', sourceActorRef: 'late-actor',
      requestedTargetRefs: [auxiliaryTargetRef],
    });
    const auxiliaryAction = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: auxiliaryIntent,
      definition: definition(),
      targetingContext: { candidates: candidates(state, {}, 'late-actor') },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, auxiliaryAction));
    const chainProfile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'plan-chain',
      name: 'Plan Chain',
      effects: [{
        type: 'damage',
        targeting: {
          type: 'chain', rangeBand: 'medium', maxTargets: 2, chainCount: 2,
          chainInterval: 50, targetFalloffBps: 1000,
          damageMultiplierPerTargetBps: [6000, 4000],
        },
        damageComponents: [{
          id: 'plan-chain-hit', channel: 'physical', element: null,
          baseDamage: 8, scaling: 'full', canCrit: true,
        }],
      }],
    };
    const firstIntent = intent({
      intentRef: 'plan-chain-intent',
      contentRef: { scope: 'world', contentType: 'skill', code: 'plan-chain', versionNumber: 1 },
      requestedTargetRefs: [firstTargetRef],
    });
    const secondIntent = intent({ intentRef: 'plan-followup-intent', requestedTargetRefs: [firstTargetRef] });
    const intents = mode === 'target_invalidated' ? [firstIntent, secondIntent] : [firstIntent];
    return expectOk(applyCoreV1EncounterActionPlan({
      encounter: scheduled,
      plan: {
        planRef: mode === 'target_invalidated' ? 'plan-target' : 'plan-source',
        actorRef: 'hero', expectedStateVersion: scheduled.stateVersion,
        intents, stopConditions,
      },
      definitions: {
        [firstIntent.intentRef]: definition(chainProfile),
        [secondIntent.intentRef]: definition(),
      },
      targetingContexts: {
        [firstIntent.intentRef]: {
          candidates: candidates(scheduled),
          candidateRanges: [{
            fromActorRef: firstTargetRef, toActorRef: 'enemy-two', rangeBand: 'near',
          }],
        },
        [secondIntent.intentRef]: { candidates: candidates(scheduled) },
      },
      runtime,
    }));
  }

  function planAfterUntouchedTargetLoss(
    stopConditions: readonly 'noValidTarget'[] = [],
  ) {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('z-ally', 'party'),
      participant('enemy', 'hostile', {
        resources: {
          hp: { current: 1, maximum: 100 }, mana: { current: 100, maximum: 100 },
          sp: { current: 100, maximum: 100 }, customResources: [],
        },
      }),
      participant('enemy-two', 'hostile'),
    ]);
    const auxiliaryIntent = intent({
      intentRef: 'target-loss-auxiliary', sourceActorRef: 'z-ally', requestedTargetRefs: ['enemy'],
    });
    const auxiliaryAction = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: auxiliaryIntent,
      definition: definition(),
      targetingContext: { candidates: candidates(state, {}, 'z-ally') },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, auxiliaryAction));
    const interleaved = {
      ...scheduled,
      scheduledEvents: scheduled.scheduledEvents.map((event) => event.actionRef === auxiliaryAction.actionRef
        && event.type === 'action_effect'
        ? { ...event, timelineEvent: { ...event.timelineEvent, tick: scheduled.currentTick } }
        : event),
    };
    const firstIntent = intent({ intentRef: 'target-loss-first', requestedTargetRefs: ['enemy'] });
    const secondIntent = intent({ intentRef: 'target-loss-second', requestedTargetRefs: ['enemy-two'] });
    return expectOk(applyCoreV1EncounterActionPlan({
      encounter: interleaved,
      plan: {
        planRef: 'plan-target-loss', actorRef: 'hero', expectedStateVersion: interleaved.stateVersion,
        intents: [firstIntent, secondIntent], stopConditions,
      },
      definitions: {
        [firstIntent.intentRef]: definition(),
        [secondIntent.intentRef]: definition(),
      },
      targetingContexts: {
        [firstIntent.intentRef]: { candidates: candidates(interleaved) },
        [secondIntent.intentRef]: { candidates: candidates(interleaved) },
      },
      runtime,
    }));
  }

  it.each([
    ['block', 1000n, 150n],
    ['active_dodge', 1200n, 250n],
    ['interrupt', 1500n, 200n],
  ] as const)('runs %s at depth one, applies RC1.1 cooldown and ready penalty', (kind, cooldown, penalty) => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('enemy', 'hostile', { reactionCapabilities: [reactive(kind)] }),
    ]);
    const applied = expectOk(applyCoreV1EncounterIntent({
      encounter: state,
      intent: intent({ reactionPolicy: { mode: 'require', preferredReaction: kind, allowCounterAttack: false } }),
      definition: definition(), targetingContext: { candidates: candidates(state) }, runtime,
    }));
    const report = expectOk(processCoreV1EncounterBatch(applied.encounterAfter, runtime));
    expect(report.reactionResolutions[0]?.kind).toBe(kind);
    expect(report.cooldownChanges[0]?.readyAtTick).toBe(report.reactionResolutions.length > 0
      ? applied.encounterAfter.currentTick + (kind === 'block' ? 100n : 150n) + cooldown
      : 0n);
    const enemy = report.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy');
    expect(enemy?.actionSlots[0]?.nextActionAtTick).toBeGreaterThanOrEqual(state.currentTick + penalty);
  });

  it('keeps reaction cooldown after a lost trigger, rejects a second defense and requires an outcome resolver', () => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('enemy', 'hostile', { reactionCapabilities: [reactive('block')] }),
    ]);
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ reactionPolicy: { mode: 'require', preferredReaction: 'block', allowCounterAttack: false } }),
      definition: definition(), targetingContext: { candidates: candidates(state) },
    }));
    const reactionEvents = compiled.internalEvents.filter((event) => event.type.startsWith('reaction_'));
    expect(reactionEvents).toHaveLength(2);
    expect(compiled.reactionDepth).toBe(0);
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, compiled));
    const withoutResolver: CoreV1EncounterRuntime = { rolls: runtime.rolls };
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, withoutResolver));
    const reserved = expectOk(processNextCoreV1EncounterEvent(started.encounterAfter, withoutResolver));
    expectInvalid(processNextCoreV1EncounterEvent(reserved.encounterAfter, withoutResolver), 'REACTION_OUTCOME_REQUIRED');
  });

  it('models a successful terminal counter at depth two without creating a third reaction', () => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('enemy', 'hostile', { reactionCapabilities: [reactive('block'), reactive('counter_attack')] }),
    ]);
    const applied = expectOk(applyCoreV1EncounterIntent({
      encounter: state,
      intent: intent({ reactionPolicy: { mode: 'require', preferredReaction: 'block', allowCounterAttack: true } }),
      definition: definition(), targetingContext: { candidates: candidates(state) }, runtime,
    }));
    const report = expectOk(processCoreV1EncounterBatch(applied.encounterAfter, runtime));
    expect(report.reactionResolutions.map((entry) => entry.kind)).toEqual(['block', 'counter_attack']);
    const counterEvent = report.processedEvents
      .find((event) => event.type === 'counter_attack_started');
    expect(counterEvent?.timelineEvent.reactionDepth).toBe(2);
    const counterCooldown = report.cooldownChanges.find((entry) => entry.cooldownRef === 'reaction-counter_attack');
    expect(counterCooldown?.readyAtTick).toBe((counterEvent?.timelineEvent.tick ?? 0n) + 1600n);
    expect(report.encounterAfter.participants.find((entry) => entry.actorRef === 'enemy')?.actionSlots[0]?.nextActionAtTick)
      .toBeGreaterThanOrEqual((counterEvent?.timelineEvent.tick ?? 0n) + 400n);
    expect(report.processedEvents.every((event) => event.timelineEvent.reactionDepth <= 2)).toBe(true);
  });

  it('interrupts casting before/after 50%, reuses mana policy and starts recovery at interruption', () => {
    const magicProfile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      contentKind: 'spell', code: 'fireball', name: 'Bola de Fogo',
      cost: { type: 'mana', amount: 8 }, actionProfile: 'long_spell',
    };
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('enemy', 'hostile', { reactionCapabilities: [reactive('interrupt')] }),
    ]);
    const { physicalSpeed: _physicalSpeed, ...magicDefinition } = definition(magicProfile, {
      actionKind: 'magic', actionTags: ['spell'],
      magicalSpeed: { attributes: balanced, magicSchoolRank: 0, armorCastingPenaltyBps: 0 },
      casting: { reservedMana: 8, canMoveWhileCasting: false },
    });
    void _physicalSpeed;
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ contentRef: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 }, reactionPolicy: { mode: 'require', preferredReaction: 'interrupt', allowCounterAttack: false } }),
      definition: magicDefinition, targetingContext: { candidates: candidates(state) },
    }));
    expect(compiled.executionPlan.castingState?.phase).toBe('casting');
    const report = expectOk(processCoreV1EncounterBatch(expectOk(scheduleCoreV1EncounterAction(state, compiled)), runtime));
    expect(report.encounterAfter.participants.find((entry) => entry.actorRef === 'hero')?.resources.mana.current).toBe(100);
    expect(report.invalidatedEvents.some((entry) => entry.event.type === 'action_effect')).toBe(true);
    expect(report.readyActors).toContain('hero');

    const fastDefinition = {
      ...magicDefinition,
      profile: { ...magicProfile, actionProfile: 'normal' as const },
      magicalSpeed: {
        attributes: balanced, magicSchoolRank: 0, armorCastingPenaltyBps: 0,
        statusSpeedMultiplierBps: 20_000,
      },
    };
    const fastCompiled = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent({ contentRef: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 }, reactionPolicy: { mode: 'require', preferredReaction: 'interrupt', allowCounterAttack: false } }),
      definition: fastDefinition, targetingContext: { candidates: candidates(state) },
    }));
    const fastReport = expectOk(processCoreV1EncounterBatch(
      expectOk(scheduleCoreV1EncounterAction(state, fastCompiled)), runtime,
    ));
    expect(fastReport.encounterAfter.participants.find((entry) => entry.actorRef === 'hero')?.resources.mana.current).toBe(98);
  });

  it('rejects incomplete channel policy and schedules/cancels valid channel pulses with minimum interval', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const magicProfile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      contentKind: 'spell', code: 'channel', name: 'Channel',
      cost: { type: 'maintenance', resource: 'mana', activationCost: 8, amount: 2 },
    };
    const { physicalSpeed: _physicalSpeed, ...base } = definition(magicProfile, {
      actionKind: 'magic', actionTags: ['spell'],
      magicalSpeed: { attributes: balanced, magicSchoolRank: 0, armorCastingPenaltyBps: 0 },
    });
    void _physicalSpeed;
    const channelIntent = intent({ contentRef: { scope: 'world', contentType: 'spell', code: 'channel', versionNumber: 1 } });
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state, intent: channelIntent,
      definition: { ...base, casting: { reservedMana: 8, canMoveWhileCasting: false, channelInterval: 250n } },
      targetingContext: { candidates: candidates(state) },
    }), 'REQUIRES_UPKEEP_POLICY');
    const compiled = expectOk(compileCoreV1EncounterAction({
      encounter: state, intent: channelIntent,
      definition: { ...base, casting: { reservedMana: 8, canMoveWhileCasting: false, channelInterval: 250n, channelEndTick: state.currentTick + 2000n } },
      targetingContext: { candidates: candidates(state) },
    }));
    expect(compiled.internalEvents.some((event) => event.type === 'channel_pulse')).toBe(true);
    expect(compiled.internalEvents.some((event) => event.type === 'upkeep_due')).toBe(true);

    const lowManaState = readyEncounter([
      participant('hero', 'party', {
        resources: {
          hp: { current: 100, maximum: 100 }, mana: { current: 9, maximum: 100 },
          sp: { current: 100, maximum: 100 }, customResources: [],
        },
      }),
      participant('enemy', 'hostile'),
    ]);
    const lowManaCompiled = expectOk(compileCoreV1EncounterAction({
      encounter: lowManaState, intent: channelIntent,
      definition: {
        ...base,
        casting: {
          reservedMana: 8, canMoveWhileCasting: false, channelInterval: 250n,
          channelEndTick: lowManaState.currentTick + 2000n,
        },
      },
      targetingContext: { candidates: candidates(lowManaState) },
    }));
    const cancelled = expectOk(processCoreV1EncounterBatch(
      expectOk(scheduleCoreV1EncounterAction(lowManaState, lowManaCompiled)), runtime,
    ));
    expect(cancelled.stopReason).toBe('resource_below_required');
    expect(cancelled.invalidatedEvents.some((entry) => entry.event.type === 'channel_pulse')).toBe(true);
    expect(cancelled.readyActors).toContain('hero');
  });

  it.each([
    ['approach', 'near', 'engaged'],
    ['retreat', 'engaged', 'near'],
    ['run', 'far', 'near'],
    ['disengage', 'engaged', 'near'],
    ['move_and_act', 'near', 'engaged'],
  ] as const)('models %s movement with zones and terrain', (kind, from, to) => {
    const state = readyEncounter([participant('hero', 'party', { zone: from }), participant('enemy', 'hostile')]);
    const moveDefinition: CoreV1EncounterActionDefinition = {
      actionSource: 'movement', actionKind: 'movement',
      actionTags: ['movement'], allowedRelations: ['self'], effectRefs: [],
      movement: { kind, from, to, terrain: 'normal', combinedActionAllowed: kind === 'move_and_act' },
      fullPrimaryAction: true,
      interruptible: false, blockable: false, dodgeable: false, canRetargetBeforeEffect: false,
    };
    const moveIntent: CoreV1EncounterActionIntent = {
      intentRef: 'intent-one', sourceActorRef: 'hero', slotRef: 'primary',
      actionSource: 'movement', targetSelector: 'self', requestedTargetRefs: [],
    };
    const applied = expectOk(applyCoreV1EncounterIntent({
      encounter: state, intent: moveIntent, definition: moveDefinition,
      targetingContext: { candidates: candidates(state) }, runtime,
    }));
    const report = expectOk(processCoreV1EncounterBatch(applied.encounterAfter, runtime));
    expect(report.movementChanges[0]).toMatchObject({ actorRef: 'hero', from, to });
  });

  it('rejects overloaded movement and invalid combo caps while accepting five steps/eight events', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const overloaded: CoreV1EncounterActionDefinition = {
      actionSource: 'movement', actionKind: 'movement',
      actionTags: ['movement'], allowedRelations: ['self'], effectRefs: [],
      fullPrimaryAction: true,
      movement: { kind: 'approach', from: 'near', to: 'engaged', terrain: 'normal' },
      physicalSpeed: { ...physicalSpeed, carriedWeightUnits: 126, carryingCapacityUnits: 100 },
      interruptible: false, blockable: false, dodgeable: false, canRetargetBeforeEffect: false,
    };
    const overloadedIntent: CoreV1EncounterActionIntent = {
      intentRef: 'intent-one', sourceActorRef: 'hero', slotRef: 'primary',
      actionSource: 'movement', targetSelector: 'self', requestedTargetRefs: [],
    };
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state,
      intent: overloadedIntent,
      definition: overloaded, targetingContext: { candidates: candidates(state) },
    }), 'INVALID_ENCOUNTER_INPUT');
    const combo = {
      actionKind: 'combo' as const, maxTargets: 1, chainCount: 0, chainInterval: 0n,
      targetFalloffBps: 0, damageMultiplierPerTargetBps: [10_000],
      comboSteps: Array.from({ length: 5 }, (_, index) => ({ stepRef: `step-${index}`, offset: BigInt(index * 50) })),
      stopOnMiss: true, maxComboEvents: 8,
    };
    const comboBase = definition(strikeProfile, { combo });
    expect(compileCoreV1EncounterAction({ encounter: state, intent: intent(), definition: comboBase, targetingContext: { candidates: candidates(state) } }).ok).toBe(true);
    expectInvalid(compileCoreV1EncounterAction({
      encounter: state, intent: intent(),
      definition: { ...comboBase, combo: { ...combo, comboSteps: Array.from({ length: 6 }, (_, index) => ({ stepRef: `step-${index}`, offset: BigInt(index * 50) })) } },
      targetingContext: { candidates: candidates(state) },
    }), 'INVALID_ENCOUNTER_INPUT');
  });

  it('applies one- and five-action plans, rejects six, stale state and missing definitions', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const one = intent();
    const planInput = {
      encounter: state,
      plan: {
        planRef: 'plan-one', actorRef: 'hero', expectedStateVersion: state.stateVersion,
        intents: [one], stopConditions: ['processingLimit', 'noValidTarget', 'newPlayerIntentRequired'] as const,
      },
      definitions: { [one.intentRef]: definition() },
      targetingContexts: { [one.intentRef]: { candidates: candidates(state) } },
      runtime,
    };
    expect(expectOk(applyCoreV1EncounterActionPlan(planInput)).stopReason).toBe('plan_completed');
    expect(expectOk(applyCoreV1EncounterActionPlan({ ...planInput, plan: { ...planInput.plan, expectedStateVersion: 0 } })).stopReason)
      .toBe('state_version_changed');
    expect(expectOk(applyCoreV1EncounterActionPlan({ ...planInput, definitions: {} })).stopReason).toBe('new_intent_required');
    const five = Array.from({ length: 5 }, (_, index) => intent({ intentRef: `intent-${index}` }));
    const definitions = Object.fromEntries(five.map((entry) => [entry.intentRef, definition()]));
    const targetingContexts = Object.fromEntries(five.map((entry) => [entry.intentRef, { candidates: candidates(state) }]));
    expect(expectOk(applyCoreV1EncounterActionPlan({
      ...planInput,
      plan: { ...planInput.plan, planRef: 'plan-five', intents: five },
      definitions,
      targetingContexts,
    })).stopReason).toBe('plan_completed');
    const six = Array.from({ length: 6 }, (_, index) => intent({ intentRef: `intent-${index}` }));
    expectInvalid(applyCoreV1EncounterActionPlan({ ...planInput, plan: { ...planInput.plan, intents: six } }), 'PLAN_ACTION_LIMIT');
    expectInvalid(applyCoreV1EncounterActionPlan({
      ...planInput,
      plan: { ...planInput.plan, stopConditions: ['unknown-condition' as never] },
    }), 'STOP_CONDITION');
  });

  it('continues a plan after partial success when no target stop condition was selected', () => {
    const result = interleavedPlan('target_invalidated');
    expect(result.stopReason).toBe('plan_completed');
    expect(result.invalidatedEvents.some((entry) => entry.reason === 'NO_VALID_TARGET')).toBe(true);
    expect(result.resolvedActions).toContain('encounter-test-action-2');
    expect(result.resolvedActions).toContain('encounter-test-action-3');
    expect(result.effectResolutions.filter((entry) => entry.targetBefore.actorRef === 'enemy')).toHaveLength(2);
  });

  it('stops partial success on noValidTarget and targetSetChangedMaterially only when selected', () => {
    const noTarget = interleavedPlan('target_invalidated', ['noValidTarget']);
    expect(noTarget.stopReason).toBe('no_valid_target');
    expect(noTarget.resolvedActions).toContain('encounter-test-action-2');
    expect(noTarget.resolvedActions).not.toContain('encounter-test-action-3');
    expect(noTarget.effectResolutions.filter((entry) => entry.targetBefore.actorRef === 'enemy')).toHaveLength(1);

    const targetChanged = interleavedPlan('target_invalidated', ['targetSetChangedMaterially']);
    expect(targetChanged.stopReason).toBe('target_set_changed');
    expect(targetChanged.resolvedActions).toContain('encounter-test-action-2');
    expect(targetChanged.resolvedActions).not.toContain('encounter-test-action-3');
  });

  it('keeps untouched target loss conditional for action plans', () => {
    const stopped = planAfterUntouchedTargetLoss(['noValidTarget']);
    expect(stopped.stopReason).toBe('no_valid_target');
    expect(stopped.stopReason).not.toBe('new_intent_required');
    expect(stopped.invalidatedEvents.some((entry) => entry.reason === 'NO_VALID_TARGET')).toBe(true);
    expect(stopped.effectResolutions.some((entry) => entry.targetBefore.actorRef === 'enemy-two')).toBe(false);

    const continued = planAfterUntouchedTargetLoss();
    expect(continued.stopReason).toBe('plan_completed');
    expect(continued.stopReason).not.toBe('new_intent_required');
    expect(continued.continuationRequired).toBe(false);
    expect(continued.effectResolutions.some((entry) => entry.targetBefore.actorRef === 'enemy-two')).toBe(true);
  });

  it('preserves a terminally invalidated plan and requires a new intent', () => {
    const result = interleavedPlan('source_invalidated');
    expect(result.invalidatedEvents.some((entry) => entry.reason === 'STATE_CHANGED')).toBe(true);
    expect(result.stopReason).toBe('new_intent_required');
    expect(result.continuationRequired).toBe(true);
    expect(result.resolvedActions).not.toContain('encounter-test-action-2');
    expect(result.encounterAfter.actionPlans.map((plan) => plan.planRef)).toContain('plan-source');
  });

  it('stops an unconditional plan when a later optional reason follows new_intent_required', () => {
    const fixture = mandatoryAndOptionalInvalidation('mandatory_first');
    const firstIntent = intent({
      intentRef: 'planner-first', sourceActorRef: fixture.plannerActorRef,
      requestedTargetRefs: ['ally'],
    });
    const secondIntent = { ...firstIntent, intentRef: 'planner-followup' };
    const result = expectOk(applyCoreV1EncounterActionPlan({
      encounter: fixture.encounter,
      plan: {
        planRef: 'plan-mandatory-stop', actorRef: fixture.plannerActorRef,
        expectedStateVersion: fixture.encounter.stateVersion,
        intents: [firstIntent, secondIntent], stopConditions: [],
      },
      definitions: {
        [firstIntent.intentRef]: definition(),
        [secondIntent.intentRef]: definition(),
      },
      targetingContexts: {
        [firstIntent.intentRef]: {
          candidates: candidates(fixture.encounter, {}, fixture.plannerActorRef),
        },
        [secondIntent.intentRef]: {
          candidates: candidates(fixture.encounter, {}, fixture.plannerActorRef),
        },
      },
      runtime,
    }));
    expect(result.invalidatedEvents.map((entry) => entry.reason))
      .toEqual(['STATE_CHANGED', 'NO_VALID_TARGET']);
    expect(result.stopReason).toBe('new_intent_required');
    expect(result.stopReason).not.toBe('plan_completed');
    expect(result.continuationRequired).toBe(true);
    expect(result.encounterAfter.actionSequence).toBe(fixture.encounter.actionSequence + 1);
    expect(result.encounterAfter.actionPlans.map((plan) => plan.planRef)).toContain('plan-mandatory-stop');
    expect(result.encounterAfter.activeActions.some((action) => action.intentRef === secondIntent.intentRef))
      .toBe(false);
  });

  it('propagates encounter completion for a terminally invalidated plan without requesting continuation', () => {
    const state = readyEncounter([
      participant('hero', 'party'),
      participant('enemy', 'hostile'),
    ]);
    const heroAction = expectOk(compileCoreV1EncounterAction({
      encounter: state,
      intent: intent(),
      definition: definition(),
      targetingContext: { candidates: candidates(state) },
    }));
    const scheduled = expectOk(scheduleCoreV1EncounterAction(state, heroAction));
    const started = expectOk(processNextCoreV1EncounterEvent(scheduled, runtime));
    const sourceRemoved = {
      ...started.encounterAfter,
      participants: started.encounterAfter.participants.map((entry) => entry.actorRef === 'hero'
        ? { ...entry, combatState: 'removed' as const }
        : entry),
      scheduledEvents: started.encounterAfter.scheduledEvents.map((event) => event.type === 'action_effect'
        ? { ...event, timelineEvent: { ...event.timelineEvent, tick: started.encounterAfter.currentTick } }
        : event),
    };
    const selfProfile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'focus',
      name: 'Focus',
      cost: { type: 'none' },
      effects: [{
        type: 'restore_resource', resource: 'sp', amount: 1,
        targeting: { type: 'self', rangeBand: 'self' },
      }],
    };
    const enemyIntent = intent({
      intentRef: 'enemy-plan-intent', sourceActorRef: 'enemy',
      targetSelector: 'self', requestedTargetRefs: [],
      contentRef: { scope: 'world', contentType: 'skill', code: 'focus', versionNumber: 1 },
    });
    const result = expectOk(applyCoreV1EncounterActionPlan({
      encounter: sourceRemoved,
      plan: {
        planRef: 'enemy-plan-completion', actorRef: 'enemy',
        expectedStateVersion: sourceRemoved.stateVersion,
        intents: [enemyIntent], stopConditions: [],
      },
      definitions: {
        [enemyIntent.intentRef]: definition(selfProfile, { allowedRelations: ['self'] }),
      },
      targetingContexts: {
        [enemyIntent.intentRef]: { candidates: candidates(sourceRemoved, {}, 'enemy') },
      },
      runtime,
    }));
    expect(result.invalidatedEvents.some((entry) => entry.reason === 'STATE_CHANGED')).toBe(true);
    expect(result.stopReason).toBe('encounter_completed');
    expect(result.continuationRequired).toBe(false);
    expect(result.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(result.resolvedActions).not.toContain(heroAction.actionRef);
    expect(result.encounterAfter.activeActions.find((action) => action.actionRef === heroAction.actionRef)?.state)
      .toBe('invalidated');
  });

  it('completes an action plan only after a source-invalidated action drains all execution events', () => {
    const { actionRef, sourceRemoved } = sourceInvalidationWithRemainingEffects(false);
    const selfProfile: CoreV1MechanicalContentProfile = {
      ...strikeProfile,
      code: 'focus',
      name: 'Focus',
      cost: { type: 'none' },
      effects: [{
        type: 'restore_resource', resource: 'sp', amount: 1,
        targeting: { type: 'self', rangeBand: 'self' },
      }],
    };
    const firstIntent = intent({
      intentRef: 'enemy-plan-first', sourceActorRef: 'enemy',
      targetSelector: 'self', requestedTargetRefs: [],
      contentRef: { scope: 'world', contentType: 'skill', code: 'focus', versionNumber: 1 },
    });
    const secondIntent = { ...firstIntent, intentRef: 'enemy-plan-followup' };
    const result = expectOk(applyCoreV1EncounterActionPlan({
      encounter: sourceRemoved,
      plan: {
        planRef: 'enemy-plan-terminalization', actorRef: 'enemy',
        expectedStateVersion: sourceRemoved.stateVersion,
        intents: [firstIntent, secondIntent], stopConditions: [],
      },
      definitions: {
        [firstIntent.intentRef]: definition(selfProfile, { allowedRelations: ['self'] }),
        [secondIntent.intentRef]: definition(selfProfile, { allowedRelations: ['self'] }),
      },
      targetingContexts: {
        [firstIntent.intentRef]: { candidates: candidates(sourceRemoved, {}, 'enemy') },
        [secondIntent.intentRef]: { candidates: candidates(sourceRemoved, {}, 'enemy') },
      },
      runtime,
    }));
    const invalidatedAction = result.encounterAfter.activeActions
      .find((action) => action.actionRef === actionRef);
    expect(result.invalidatedEvents.filter((entry) => entry.reason === 'STATE_CHANGED')).toHaveLength(2);
    expect(result.stopReason).toBe('encounter_completed');
    expect(result.continuationRequired).toBe(false);
    expect(result.encounterAfter.completionCandidate).toBe('hostile_victory_candidate');
    expect(invalidatedAction?.state).toBe('invalidated');
    expect(result.resolvedActions).not.toContain(invalidatedAction?.actionRef);
    expect(remainingExecutionEvents(result.encounterAfter, invalidatedAction?.actionRef ?? '')).toEqual([]);
    expect(result.encounterAfter.activeActions.some((action) => action.intentRef === secondIntent.intentRef))
      .toBe(false);
  });

  it('always stops plans for processing limits, missing intents and encounter completion', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const hero = state.participants.find((entry) => entry.actorRef === 'hero');
    expect(hero).toBeDefined();
    const futureEvent: CoreV1EncounterEvent = {
      eventRef: 'future-cooldown', type: 'cooldown_expired', targetRef: 'hero',
      timelineEvent: {
        eventId: 'future-cooldown', sequence: 999, type: 'actor_ready',
        tick: state.currentTick + 5001n, actorRef: 'hero',
        initiativeScore: hero?.initiative.score ?? 0,
        agility: hero?.primaryAttributes.agility ?? 0,
        perception: hero?.primaryAttributes.perception ?? 0,
        luck: hero?.primaryAttributes.luck ?? 0,
        rngTieBreak: hero?.initiative.tieBreak ?? 0,
        stableRef: 'hero', reactionDepth: 0,
      },
    };
    const intents = [intent({ intentRef: 'limit-first' }), intent({ intentRef: 'limit-second' })];
    const limitResult = expectOk(applyCoreV1EncounterActionPlan({
      encounter: { ...state, scheduledEvents: [futureEvent] },
      plan: {
        planRef: 'plan-limit', actorRef: 'hero', expectedStateVersion: state.stateVersion,
        intents, stopConditions: [],
      },
      definitions: Object.fromEntries(intents.map((entry) => [entry.intentRef, definition()])),
      targetingContexts: Object.fromEntries(intents.map((entry) => [
        entry.intentRef, { candidates: candidates(state) },
      ])),
      runtime,
    }));
    expect(limitResult.stopReason).toBe('processing_limit');
    expect(limitResult.resolvedActions).not.toContain('encounter-test-action-2');

    const missingIntent = expectOk(applyCoreV1EncounterActionPlan({
      encounter: state,
      plan: {
        planRef: 'plan-missing', actorRef: 'hero', expectedStateVersion: state.stateVersion,
        intents: [intent()], stopConditions: [],
      },
      definitions: {}, targetingContexts: {}, runtime,
    }));
    expect(missingIntent.stopReason).toBe('new_intent_required');

    const vulnerableEnemy = participant('enemy', 'hostile', {
      resources: {
        hp: { current: 1, maximum: 100 }, mana: { current: 100, maximum: 100 },
        sp: { current: 100, maximum: 100 }, customResources: [],
      },
    });
    const completionState = readyEncounter([participant('hero', 'party'), vulnerableEnemy]);
    const completed = expectOk(applyCoreV1EncounterActionPlan({
      encounter: completionState,
      plan: {
        planRef: 'plan-completion', actorRef: 'hero', expectedStateVersion: completionState.stateVersion,
        intents: [intent()], stopConditions: [],
      },
      definitions: { 'intent-one': definition() },
      targetingContexts: { 'intent-one': { candidates: candidates(completionState) } },
      runtime,
    }));
    expect(completed.stopReason).toBe('encounter_completed');
  });

  it('stops a multi-action plan when the encounter state version changes', () => {
    const state = readyEncounter([participant('hero', 'party'), participant('enemy', 'hostile')]);
    const intents = [intent({ intentRef: 'intent-first' }), intent({ intentRef: 'intent-second' })];
    const result = expectOk(applyCoreV1EncounterActionPlan({
      encounter: state,
      plan: {
        planRef: 'plan-state-version', actorRef: 'hero', expectedStateVersion: state.stateVersion,
        intents, stopConditions: ['stateVersionChanged'],
      },
      definitions: Object.fromEntries(intents.map((entry) => [entry.intentRef, definition()])),
      targetingContexts: Object.fromEntries(intents.map((entry) => [
        entry.intentRef, { candidates: candidates(state) },
      ])),
      runtime,
    }));
    expect(result.stopReason).toBe('state_version_changed');
    expect(result.resolvedActions).toHaveLength(1);
    expect(result.continuationRequired).toBe(true);
  });
});

describe('core-v1 encounter RC1.1 approved timelines', () => {
  const scenarios = [
    ['balanced contra balanced', 2],
    ['adaga contra arma pesada', 2],
    ['espada curta contra arco', 2],
    ['rápido contra lento', 2],
    ['extremamente rápido contra cinco lentos', 6],
    ['sobrecarregado', 2],
    ['haste', 2],
    ['slow', 2],
    ['Bola de Fogo rápida', 2],
    ['magia longa', 2],
    ['conjuração interrompida', 2],
    ['troca de alvo', 3],
    ['Golpe Giratório', 4],
    ['chain contra três', 4],
    ['reação defensiva', 2],
    ['contra-ataque', 2],
    ['mesmo tick', 2],
    ['boss com slot secundário', 2],
    ['três contra três', 6],
    ['doze participantes', 12],
  ] as const;

  it.each(scenarios)('%s preserves deterministic initial queue for %i participants', (_name, count) => {
    const inputs = Array.from({ length: count }, (_, index) => participant(
      `actor-${index}`,
      index < Math.ceil(count / 2) ? 'party' : 'hostile',
      { initiative: { tieBreak: count - index, surprised: _name === 'conjuração interrompida' && index === count - 1 } },
    ));
    const first = expectOk(createCoreV1EncounterState(encounterInput(inputs, { encounterRef: `scenario-${count}` })));
    const second = expectOk(createCoreV1EncounterState(encounterInput(inputs, { encounterRef: `scenario-${count}` })));
    expect(first.scheduledEvents).toEqual(second.scheduledEvents);
    expect(first.scheduledEvents).toHaveLength(count);
    expect(first.scheduledEvents.every((event) => event.timelineEvent.tick >= 0n)).toBe(true);
    expect(first.scheduledEvents.map((event) => event.timelineEvent.sequence)).toEqual(
      [...new Set(first.scheduledEvents.map((event) => event.timelineEvent.sequence))],
    );
  });
});
