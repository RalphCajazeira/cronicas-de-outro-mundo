import { describe, expect, it } from 'vitest';
import {
  calculateSecondaryAttributes,
  createCoreV1EmptyEquipmentLoadout,
  createCoreV1EncounterActionSlots,
  createCoreV1EncounterState,
  getInitialAttributePreset,
  type CoreV1EncounterParticipantInput,
} from '../rules/core-v1/index.js';
import {
  applyBeatGuardCapabilities,
  automaticReactionResolver,
  beatComponentRejectionReason,
  encounterScenePackage,
  genericEncounterAction,
  normalizeBeatComponent,
  selectNpcBeatComponent,
} from './encounter-beat.js';
import type { PersistedEncounterAuthority } from './encounter-state-loader.js';

const attributes = getInitialAttributePreset('balanced');
const secondary = calculateSecondaryAttributes({
  attributes, weaponFamilyRank: 0, magicSchoolRank: 0,
  accuracyRank: 0, evasionRank: 0, encumbrancePenalty: 0,
});

function participant(actorRef: string, sideRef: string, zone: 'engaged' | 'near' | 'medium' | 'far'): CoreV1EncounterParticipantInput {
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

function state() {
  const created = createCoreV1EncounterState({
    encounterRef: 'beat-test', partySideRef: 'party', currentTick: 0n, status: 'active',
    participants: [participant('hero', 'party', 'near'), participant('ally', 'party', 'near'), participant('enemy', 'hostile', 'far')],
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
        component: { type: 'flee', destination: 'out_of_range' },
        modification: { code: 'FLEE_DESTINATION_DEFAULTED', field: 'destination' },
      });
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
    expect(scene.participants.find((entry) => entry.actorRef === 'ally')).toMatchObject({
      role: 'guardian', tacticalProfile: {
        strategy: 'defensive', objective: 'protect hero', faction: 'party', traits: ['loyal'],
      },
    });
  });
});
