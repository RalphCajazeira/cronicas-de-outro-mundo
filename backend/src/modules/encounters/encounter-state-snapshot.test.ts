import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  calculateSecondaryAttributes,
  compareTimelineEvents,
  compileCoreV1EncounterAction,
  createCoreV1EmptyEquipmentLoadout,
  createCoreV1EncounterState,
  getInitialAttributePreset,
  processCoreV1EncounterBatch,
  scheduleCoreV1EncounterAction,
  validateCoreV1EncounterState,
} from '../rules/core-v1/index.js';
import type {
  CoreV1CreateEncounterInput,
  CoreV1EncounterActionDefinition,
  CoreV1EncounterActionIntent,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterResult,
  CoreV1EncounterRuntime,
  CoreV1EncounterState,
  CoreV1MechanicalContentProfile,
} from '../rules/core-v1/index.js';
import { CORE_V1_MAX_TECHNICAL_TICK } from '../rules/core-v1/core-v1.action-economy.config.js';
import { CORE_V1_MAX_ENCOUNTER_TICK } from '../rules/core-v1/index.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import {
  createCoreV1EncounterSnapshotHash,
  ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES,
  parseCoreV1EncounterSnapshot,
  serializeCoreV1EncounterState,
} from './encounter-state-snapshot.js';

const attributes = getInitialAttributePreset('balanced');

function expectOk<T>(result: CoreV1EncounterResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(
    result.issues,
    (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value,
  ));
  return result.value;
}

function participant(actorRef: string, sideRef: string): CoreV1EncounterParticipantInput {
  return {
    actorRef,
    sideRef,
    actorStateVersion: 1,
    mechanicsStateVersion: 2,
    inventoryStateVersion: 3,
    effectsStateVersion: 4,
    zone: 'engaged',
    combatState: 'ready',
    primaryAttributes: attributes,
    resources: {
      hp: { current: 100, maximum: 100 },
      mana: { current: 50, maximum: 50 },
      sp: { current: 40, maximum: 40 },
      customResources: [],
    },
    secondaryAttributes: calculateSecondaryAttributes({
      attributes,
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
      nextActionAtTick: 125n,
      lastActionAtTick: null,
      allowedActionTags: ['attack', 'spell', 'wait'],
      potencyMultiplierBps: 10_000,
      stateVersion: 1,
    }],
    reactionCapabilities: [{
      capabilityRef: 'basic-block',
      kind: 'block',
      tier: 1,
      cost: { type: 'active_defense', sp: 2 },
      blockValue: 3,
    }],
    equipmentContext: {
      inventory: { entries: [] },
      loadout: createCoreV1EmptyEquipmentLoadout(),
      requirements: {
        level: 1,
        primaryAttributes: attributes,
        knownContentRefs: [],
        equippedWeaponTags: [],
        equippedEquipmentTags: [],
        rulesetCode: 'core-v1',
      },
    },
    initiative: { tieBreak: actorRef.charCodeAt(0), surprised: false },
  };
}

function realEncounterState(): CoreV1EncounterState {
  const participants = [participant('hero', 'party'), participant('slime', 'hostile')];
  const input: CoreV1CreateEncounterInput = {
    encounterRef: 'snapshot-round-trip',
    partySideRef: 'party',
    currentTick: 125n,
    status: 'active',
    participants,
    relations: [
      { leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' },
      { leftActorRef: 'hero', rightActorRef: 'slime', relation: 'hostile' },
      { leftActorRef: 'slime', rightActorRef: 'slime', relation: 'self' },
    ],
  };
  return expectOk(createCoreV1EncounterState(input));
}

function mutableSnapshot(): Record<string, unknown> {
  return structuredClone(serializeCoreV1EncounterState(realEncounterState()));
}

function encounterWithStoredRuntimeStructures(manaCostModifierBps?: number): CoreV1EncounterState {
  const runtime: CoreV1EncounterRuntime = {
    rolls: {
      tieBreak: ({ actorRef }) => actorRef.charCodeAt(0),
      effectRolls: () => ({ hitRollBps: 1, criticalRollBps: 10_000, concentrationRoll: 1 }),
    },
  };
  const ready = expectOk(processCoreV1EncounterBatch(realEncounterState(), runtime)).encounterAfter;
  const profile: CoreV1MechanicalContentProfile = {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'spell',
    code: 'snapshot-channel',
    name: 'Snapshot Channel',
    tier: 1,
    rarity: 'common',
    activation: { type: 'active' },
    cost: { type: 'maintenance', resource: 'mana', activationCost: 8, amount: 2 },
    actionProfile: 'normal',
    effects: [{
      type: 'damage',
      targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
      damageComponents: [{
        id: 'snapshot-channel-hit', channel: 'magical', element: 'arcane',
        baseDamage: 8, scaling: 'full', canCrit: true,
      }],
    }],
  };
  const contentRef = { scope: 'world' as const, contentType: 'spell' as const, code: profile.code, versionNumber: 1 };
  const intent: CoreV1EncounterActionIntent = {
    intentRef: 'snapshot-intent',
    sourceActorRef: 'hero',
    slotRef: 'primary',
    actionSource: 'content',
    targetSelector: 'explicit',
    requestedTargetRefs: ['slime'],
    contentRef,
  };
  const definition: CoreV1EncounterActionDefinition = {
    actionSource: 'content',
    actionKind: 'magic',
    profile,
    contentRef,
    actionTags: ['spell'],
    fullPrimaryAction: true,
    allowedRelations: ['hostile'],
    effectRefs: ['snapshot-channel-effect'],
    magicalSpeed: { attributes, magicSchoolRank: 0, armorCastingPenaltyBps: 0 },
    casting: {
      reservedMana: 8,
      canMoveWhileCasting: false,
      preparedUntilTick: ready.currentTick + 3000n,
      channelInterval: 250n,
      channelEndTick: ready.currentTick + 2000n,
    },
    interruptible: true,
    blockable: true,
    dodgeable: true,
    canRetargetBeforeEffect: false,
    ...(manaCostModifierBps === undefined ? {} : {
      costModifiers: {
        manaCostBps: [{ source: { type: 'ruleset', ref: 'snapshot-upkeep-discount' }, value: manaCostModifierBps }],
      },
    }),
  };
  const candidates = ready.participants.map((entry, stableOrder) => ({
    actorRef: entry.actorRef,
    relation: entry.actorRef === 'hero' ? 'self' as const : 'hostile' as const,
    rangeBand: entry.zone,
    targetable: true,
    active: true,
    hpCurrent: entry.resources.hp.current,
    hpMaximum: entry.resources.hp.maximum,
    stableOrder,
  }));
  const compiled = expectOk(compileCoreV1EncounterAction({
    encounter: ready,
    intent,
    definition,
    targetingContext: { candidates },
  }));
  const scheduled = expectOk(scheduleCoreV1EncounterAction(ready, compiled));
  const appliedAtTick = scheduled.currentTick;
  const expiresAtTick = appliedAtTick + 500n;
  return {
    ...scheduled,
    participants: scheduled.participants.map((entry) => entry.actorRef !== 'hero' ? entry : {
      ...entry,
      activeEffects: [{
        effectRef: 'snapshot-active-effect',
        sourceActorRef: 'hero',
        targetActorRef: 'hero',
        sourceContent: contentRef,
        effectIndex: 0,
        kind: 'primary_modifier',
        stacks: 1,
        appliedAtTick,
        durationState: { type: 'ticks', expiresAtTick },
        payload: { type: 'primary_modifier', attributeCode: 'strength', amount: 1 },
      }],
    }),
    cooldowns: [{
      actorRef: 'hero', cooldownRef: 'snapshot-cooldown',
      readyAtTick: scheduled.currentTick + 3000n, sourceKind: 'content',
    }],
    actionPlans: [{
      planRef: 'snapshot-plan',
      actorRef: 'hero',
      expectedStateVersion: scheduled.stateVersion,
      intents: [intent],
      stopConditions: ['newPlayerIntentRequired'],
    }],
  };
}

function encounterWithTechnicalEffectTicks(
  appliedAtTick: bigint,
  expiresAtTick: bigint,
): CoreV1EncounterState {
  const state = encounterWithStoredRuntimeStructures();
  return {
    ...state,
    participants: state.participants.map((participant) => participant.actorRef !== 'hero' ? participant : {
      ...participant,
      activeEffects: participant.activeEffects.map((effect) => ({
        ...effect,
        appliedAtTick,
        durationState: effect.durationState.type === 'ticks'
          ? { ...effect.durationState, expiresAtTick }
          : effect.durationState,
      })),
    }),
  };
}

function mutableRuntimeSnapshot(): {
  activeActions: Array<Record<string, unknown>>;
  [key: string]: unknown;
} {
  return structuredClone(serializeCoreV1EncounterState(encounterWithStoredRuntimeStructures())) as unknown as {
    activeActions: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
}

describe('EncounterStateSnapshotV1', () => {
  it('round-trips a real Phase 1K state and converts every present bigint tick to canonical decimal strings', () => {
    const state = realEncounterState();
    const before = structuredClone(state);
    const snapshot = serializeCoreV1EncounterState(state);
    const json = canonicalJson(snapshot);

    expect(snapshot.snapshotSchemaVersion).toBe(1);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.rulesetCode).toBe('core-v1');
    expect(snapshot.currentTick).toBe('125');
    expect(snapshot.participants[0]?.actionSlots[0]?.nextActionAtTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(snapshot.participants[0]?.actionSlots[0]?.lastActionAtTick).toBeNull();
    expect(snapshot.scheduledEvents[0]?.timelineEvent.tick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(json).not.toMatch(/BigInt|\d+n/);
    expect(parseCoreV1EncounterSnapshot(snapshot)).toEqual(state);
    expect(state).toEqual(before);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES);
  });

  it('returns defensive copies in both directions', () => {
    const state = realEncounterState();
    const snapshot = serializeCoreV1EncounterState(state);
    const mutable = snapshot as unknown as { participants: Array<{ actorRef: string }> };
    mutable.participants[0]!.actorRef = 'changed-after-serialization';
    expect(state.participants[0]?.actorRef).toBe('hero');

    const freshSnapshot = serializeCoreV1EncounterState(state);
    const parsed = parseCoreV1EncounterSnapshot(freshSnapshot) as unknown as { participants: Array<{ actorRef: string }> };
    parsed.participants[0]!.actorRef = 'changed-after-parse';
    expect((freshSnapshot.participants[0] as { actorRef: string }).actorRef).toBe('hero');
  });

  it('round-trips bigint ticks in active effects, actions, internal events, casting, cooldowns and plans', () => {
    const state = encounterWithStoredRuntimeStructures();
    const snapshot = serializeCoreV1EncounterState(state);
    const participant = snapshot.participants.find((entry) => entry.actorRef === 'hero');
    const activeEffect = participant?.activeEffects[0];
    const action = snapshot.activeActions[0];
    const casting = action?.executionPlan.castingState;

    expect(activeEffect?.appliedAtTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(activeEffect?.durationState.type).toBe('ticks');
    if (activeEffect?.durationState.type !== 'ticks') throw new Error('Expected a tick-based active effect');
    expect(activeEffect.durationState.expiresAtTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.startTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.effectTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.nextActionAtTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.preparationTicks).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.recoveryTicks).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.targets[0]?.effectTickOffset).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(action?.internalEvents.every((event) => /^(0|[1-9][0-9]*)$/.test(event.timelineEvent.tick))).toBe(true);
    expect(casting?.startTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(casting?.completionTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(casting?.preparedUntilTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(casting?.channelNextPulseTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(snapshot.cooldowns[0]?.readyAtTick).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(snapshot.actionPlans[0]).toMatchObject({ planRef: 'snapshot-plan' });
    expect(snapshot.actionPlans[0]?.intents).toEqual(state.actionPlans[0]?.intents);
    expect(parseCoreV1EncounterSnapshot(snapshot)).toEqual(state);
  });

  it.each([
    ['action kind', (action: Record<string, unknown>) => { action.actionKind = 'unknown'; }],
    ['action state', (action: Record<string, unknown>) => { action.state = 'unknown'; }],
    ['reaction depth', (action: Record<string, unknown>) => { action.reactionDepth = 3; }],
    ['direct flag', (action: Record<string, unknown>) => { action.interruptible = 'true'; }],
    ['stable ref', (action: Record<string, unknown>) => { action.sourceActorRef = 'BAD REF'; }],
    ['dodged target ref', (action: Record<string, unknown>) => { action.dodgedTargetRefs = ['BAD REF']; }],
    ['target ordinal', (action: Record<string, unknown>) => {
      const targets = action.targets as Array<Record<string, unknown>>;
      targets[0]!.targetOrdinal = -1;
    }],
    ['reservation affordability', (action: Record<string, unknown>) => {
      const plan = action.resourceReservationPlan as Record<string, unknown>;
      plan.affordable = 1;
    }],
    ['execution reaction policy', (action: Record<string, unknown>) => {
      (action.executionPlan as Record<string, unknown>).reactionPolicy = {
        mode: 'sometimes', allowCounterAttack: false,
      };
    }],
    ['execution runtime duration', (action: Record<string, unknown>) => {
      (action.executionPlan as Record<string, unknown>).runtimeDurations = [{
        effectIndex: 0, duration: { type: 'actions', value: 0 },
      }];
    }],
    ['internal event cross-reference', (action: Record<string, unknown>) => {
      const events = action.internalEvents as Array<Record<string, unknown>>;
      events[0]!.actionRef = 'other-action';
      (events[0]!.timelineEvent as Record<string, unknown>).actionRef = 'other-action';
    }],
  ] as const)('rejects a snapshot with an invalid active action %s', (_label, mutate) => {
    const snapshot = mutableRuntimeSnapshot();
    mutate(snapshot.activeActions[0]!);

    expect(() => parseCoreV1EncounterSnapshot(snapshot)).toThrow(/valid core-v1 state/i);
  });

  it('uses core validation as the shared serializer and parser authority for active actions', () => {
    const invalidState = structuredClone(encounterWithStoredRuntimeStructures()) as unknown as {
      activeActions: Array<Record<string, unknown>>;
    };
    invalidState.activeActions[0]!.state = 'unknown';
    expect(() => serializeCoreV1EncounterState(invalidState as unknown as CoreV1EncounterState)).toThrow(/state is invalid/i);

    const invalidSnapshot = mutableRuntimeSnapshot();
    invalidSnapshot.activeActions[0]!.state = 'unknown';
    expect(() => parseCoreV1EncounterSnapshot(invalidSnapshot)).toThrow(/valid core-v1 state/i);
  });

  it('rejects a snapshot whose stored action plan has an impossible closed value', () => {
    const snapshot = mutableRuntimeSnapshot() as unknown as {
      actionPlans: Array<{ intents: Array<Record<string, unknown>> }>;
    };
    snapshot.actionPlans[0]!.intents[0]!.actionSource = 'unknown';

    expect(() => parseCoreV1EncounterSnapshot(snapshot)).toThrow(/valid core-v1 state/i);
  });

  it('round-trips a compiled maintenance action with fully discounted zero upkeep', () => {
    const state = encounterWithStoredRuntimeStructures(-10_000);
    expect(state.activeActions[0]?.upkeepPlan).toEqual([{ resource: 'mana', amount: 0 }]);
    expect(validateCoreV1EncounterState(state).ok).toBe(true);

    const snapshot = serializeCoreV1EncounterState(state);
    expect(snapshot.activeActions[0]?.upkeepPlan).toEqual([{ resource: 'mana', amount: 0 }]);
    expect(parseCoreV1EncounterSnapshot(snapshot)).toEqual(state);
  });

  it('rejects a snapshot with negative upkeep', () => {
    const snapshot = mutableRuntimeSnapshot();
    snapshot.activeActions[0]!.upkeepPlan = [{ resource: 'mana', amount: -1 }];

    expect(() => parseCoreV1EncounterSnapshot(snapshot)).toThrow(/valid core-v1 state/i);
  });

  it('round-trips active-effect ticks through the technical cap without expanding encounter ticks', () => {
    const state = encounterWithTechnicalEffectTicks(
      CORE_V1_MAX_ENCOUNTER_TICK + 1n,
      CORE_V1_MAX_TECHNICAL_TICK,
    );
    const snapshot = serializeCoreV1EncounterState(state);
    const effect = snapshot.participants.find((participant) => participant.actorRef === 'hero')?.activeEffects[0];

    expect(effect?.appliedAtTick).toBe((CORE_V1_MAX_ENCOUNTER_TICK + 1n).toString());
    expect(effect?.durationState).toEqual({ type: 'ticks', expiresAtTick: CORE_V1_MAX_TECHNICAL_TICK.toString() });
    expect(parseCoreV1EncounterSnapshot(snapshot)).toEqual(state);
  });

  it('rejects active-effect ticks above the technical cap', () => {
    const snapshot = serializeCoreV1EncounterState(encounterWithTechnicalEffectTicks(
      CORE_V1_MAX_TECHNICAL_TICK - 1n,
      CORE_V1_MAX_TECHNICAL_TICK,
    )) as unknown as {
      participants: Array<{ activeEffects: Array<{ appliedAtTick: string; durationState: { type: string; expiresAtTick?: string } }> }>;
    };
    const effect = snapshot.participants.find((participant) => participant.activeEffects.length > 0)!.activeEffects[0]!;
    effect.appliedAtTick = (CORE_V1_MAX_TECHNICAL_TICK + 1n).toString();

    expect(() => parseCoreV1EncounterSnapshot(snapshot)).toThrow(/tick limit/i);
  });

  it('hashes canonical content deterministically regardless of object key insertion order', () => {
    const snapshot = serializeCoreV1EncounterState(realEncounterState());
    const reversed = Object.fromEntries(Object.entries(snapshot).reverse());
    const first = createCoreV1EncounterSnapshotHash(snapshot);

    expect(createCoreV1EncounterSnapshotHash(reversed)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    null,
    'party_victory_candidate',
    'hostile_victory_candidate',
    'stalemate_candidate',
    'cancelled',
  ])('accepts the closed completion candidate %j and preserves snapshot round-tripping', (completionCandidate) => {
    const snapshot = mutableSnapshot();
    snapshot.completionCandidate = completionCandidate;

    expect(parseCoreV1EncounterSnapshot(snapshot)).toMatchObject({ completionCandidate });
  });

  it.each([
    ['unknown string', 'victory_candidate'],
    ['different case', 'PARTY_VICTORY_CANDIDATE'],
    ['number', 1],
    ['object', { candidate: 'party_victory_candidate' }],
    ['array', ['party_victory_candidate']],
  ] as const)('rejects a %s completion candidate before returning an Encounter state', (_label, completionCandidate) => {
    const snapshot = mutableSnapshot();
    snapshot.completionCandidate = completionCandidate;
    let parsed: CoreV1EncounterState | undefined;

    expect(() => { parsed = parseCoreV1EncounterSnapshot(snapshot); }).toThrow(/\$\.completionCandidate.*supported completion candidate/i);
    expect(parsed).toBeUndefined();
  });

  it('keeps canonical hashing and the 1 MiB snapshot limit unchanged', () => {
    const snapshot = mutableSnapshot();
    const hash = createCoreV1EncounterSnapshotHash(snapshot);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES).toBe(1024 * 1024);
    expect(Buffer.byteLength(canonicalJson(snapshot), 'utf8')).toBeLessThan(ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES);
  });

  it.each(['-1', '+1', '01', '1 ', '1.0', '', (CORE_V1_MAX_ENCOUNTER_TICK + 1n).toString()])('rejects invalid canonical tick %j', (tick) => {
    const snapshot = mutableSnapshot();
    snapshot.currentTick = tick;
    expect(() => parseCoreV1EncounterSnapshot(snapshot)).toThrow(/tick/i);
  });

  it('keeps timeline events and cooldowns within the encounter tick cap', () => {
    const timeline = mutableSnapshot() as unknown as {
      scheduledEvents: Array<{ timelineEvent: { tick: string } }>;
    };
    timeline.scheduledEvents[0]!.timelineEvent.tick = (CORE_V1_MAX_ENCOUNTER_TICK + 1n).toString();
    expect(() => parseCoreV1EncounterSnapshot(timeline)).toThrow(/tick limit/i);

    const cooldown = serializeCoreV1EncounterState(encounterWithStoredRuntimeStructures()) as unknown as {
      cooldowns: Array<{ readyAtTick: string }>;
    };
    cooldown.cooldowns[0]!.readyAtTick = (CORE_V1_MAX_ENCOUNTER_TICK + 1n).toString();
    expect(() => parseCoreV1EncounterSnapshot(cooldown)).toThrow(/tick limit/i);
  });

  it('rejects non-string ticks, open objects and sparse arrays', () => {
    const numericTick = mutableSnapshot();
    numericTick.currentTick = 125;
    expect(() => parseCoreV1EncounterSnapshot(numericTick)).toThrow(/tick/i);

    const openRoot = mutableSnapshot();
    openRoot.unexpected = true;
    expect(() => parseCoreV1EncounterSnapshot(openRoot)).toThrow(/not part of snapshot schema/i);

    const openParticipant = mutableSnapshot();
    const participants = openParticipant.participants as Array<Record<string, unknown>>;
    participants[0]!.unexpected = true;
    expect(() => parseCoreV1EncounterSnapshot(openParticipant)).toThrow(/not part of snapshot schema/i);

    const openEffectPayload = structuredClone(serializeCoreV1EncounterState(encounterWithStoredRuntimeStructures())) as unknown as {
      participants: Array<{ activeEffects: Array<{ payload: Record<string, unknown> }> }>;
    };
    openEffectPayload.participants.find((participant) => participant.activeEffects.length > 0)!
      .activeEffects[0]!.payload.unexpected = true;
    expect(() => parseCoreV1EncounterSnapshot(openEffectPayload)).toThrow(/not part of snapshot schema/i);

    const sparse = mutableSnapshot();
    sparse.participants = new Array(1);
    expect(() => parseCoreV1EncounterSnapshot(sparse)).toThrow(/sparse/i);
  });

  it('rejects a serialized snapshot above the explicit 1 MiB UTF-8 limit before accepting its shape', () => {
    const oversized = { ...mutableSnapshot(), oversized: '😀'.repeat(ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES) };
    expect(() => parseCoreV1EncounterSnapshot(oversized)).toThrow(/1 MiB UTF-8 limit/);
  });

  it('fits the core-v1 structural caps of 64 participants, complete relations and 256 events in 1 MiB', () => {
    const participants = Array.from({ length: 64 }, (_, index) => participant(
      `actor-${index.toString().padStart(2, '0')}`,
      index % 2 === 0 ? 'party' : 'hostile',
    ));
    const relations = participants.flatMap((left, leftIndex) => participants
      .slice(leftIndex)
      .map((right) => ({
        leftActorRef: left.actorRef,
        rightActorRef: right.actorRef,
        relation: left.actorRef === right.actorRef
          ? 'self' as const
          : left.sideRef === right.sideRef ? 'ally' as const : 'hostile' as const,
      })));
    const created = expectOk(createCoreV1EncounterState({
      encounterRef: 'snapshot-core-caps',
      partySideRef: 'party',
      currentTick: 0n,
      status: 'active',
      participants,
      relations,
    }));
    const scheduledEvents = Array.from({ length: 256 }, (_, index) => {
      const source = structuredClone(created.scheduledEvents[index % created.scheduledEvents.length]!);
      const eventRef = `snapshot-cap-event-${index.toString().padStart(3, '0')}`;
      return {
        ...source,
        eventRef,
        timelineEvent: { ...source.timelineEvent, eventId: eventRef, sequence: index + 1, stableRef: eventRef },
      };
    }).sort((left, right) => compareTimelineEvents(left.timelineEvent, right.timelineEvent));
    const snapshot = serializeCoreV1EncounterState({ ...created, scheduledEvents });

    expect(Buffer.byteLength(canonicalJson(snapshot), 'utf8')).toBeLessThanOrEqual(ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES);
    expect(parseCoreV1EncounterSnapshot(snapshot)).toEqual({ ...created, scheduledEvents });
  });
});
