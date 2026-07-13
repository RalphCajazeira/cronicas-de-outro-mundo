import { describe, expect, it } from 'vitest';
import {
  calculateBaseInitiativeDelay,
  calculateFirstNextActionAtTick,
  calculateInitiativeScore,
  canScheduleInActionSlot,
  createActionSlot,
  createEventQueue,
  executeActionPlan,
  processNextEventBatch,
  retargetAction,
  scheduleAction,
  transitionActionState,
  validateActionPlan,
} from './index.js';
import type {
  ActionPlan, ActionPlanStopCondition, ResolvedPlanStep, TimelineEvent,
} from './index.js';

const event = (overrides: Partial<TimelineEvent> & Pick<TimelineEvent, 'eventId' | 'sequence'>): TimelineEvent => {
  const { eventId, sequence, ...rest } = overrides;
  return {
  eventId,
  sequence,
  type: 'action_effect',
  tick: 100n,
  actorRef: `actor-${overrides.eventId}`,
  initiativeScore: 30,
  agility: 10,
  perception: 10,
  luck: 10,
  rngTieBreak: 0,
  stableRef: overrides.eventId,
  reactionDepth: 0,
  ...rest,
  };
};

describe('core-v1 initiative and deterministic event queue', () => {
  it('calculates balanced, fast, slow and surprise initiative', () => {
    expect(calculateInitiativeScore(10, 10)).toBe(30);
    expect(calculateBaseInitiativeDelay(30)).toBe(500n);
    expect(calculateBaseInitiativeDelay(60)).toBe(200n);
    expect(calculateBaseInitiativeDelay(-20)).toBe(1000n);
    expect(calculateFirstNextActionAtTick(30, true)).toBe(1500n);
  });

  it('orders same-tick priorities and all injected tie-breakers deterministically', () => {
    const queue = createEventQueue([
      event({ eventId: 'ready', sequence: 6, type: 'actor_ready' }),
      event({ eventId: 'effect', sequence: 5 }),
      event({ eventId: 'reaction', sequence: 4, type: 'reaction_resolution' }),
      event({ eventId: 'invalid', sequence: 3, type: 'invalidation' }),
      event({ eventId: 'rng-low', sequence: 2, initiativeScore: 31, rngTieBreak: 1 }),
      event({ eventId: 'rng-high', sequence: 1, initiativeScore: 31, rngTieBreak: 2 }),
    ], 0n);
    expect(queue.map((item) => item.eventId)).toEqual(['invalid', 'reaction', 'rng-high', 'rng-low', 'effect', 'ready']);
    expect(createEventQueue(queue, 0n)).toEqual(queue);
  });

  it('uses agility, perception, luck, injected RNG and stable ref only as ordered tie-breakers', () => {
    const queue = createEventQueue([
      event({ eventId: 'stable-b', sequence: 6, stableRef: 'b' }),
      event({ eventId: 'stable-a', sequence: 5, stableRef: 'a' }),
      event({ eventId: 'rng', sequence: 4, rngTieBreak: 1 }),
      event({ eventId: 'luck', sequence: 3, luck: 11 }),
      event({ eventId: 'per', sequence: 2, perception: 11 }),
      event({ eventId: 'agi', sequence: 1, agility: 11 }),
    ], 0n);
    expect(queue.map((item) => item.eventId)).toEqual(['agi', 'per', 'luck', 'rng', 'stable-a', 'stable-b']);
  });

  it('jumps to the next event and sequentially cancels invalidated later events', () => {
    const input = Object.freeze([
      Object.freeze(event({ eventId: 'invalidate', sequence: 1, type: 'invalidation', tick: 500n })),
      Object.freeze(event({ eventId: 'effect', sequence: 2, tick: 500n })),
      Object.freeze(event({ eventId: 'future', sequence: 3, tick: 900n })),
    ]);
    const result = processNextEventBatch(input, 0n, (candidate, processed) => (
      candidate.eventId !== 'effect' || !processed.some((item) => item.eventId === 'invalidate')
    ));
    expect(result.combatTickAfter).toBe(500n);
    expect(result.processed.map((item) => item.eventId)).toEqual(['invalidate']);
    expect(result.cancelled.map((item) => item.eventId)).toEqual(['effect']);
    expect(result.remaining.map((item) => item.eventId)).toEqual(['future']);
    expect(input[0]?.tick).toBe(500n);
  });

  it('handles empty queues and rejects duplicates and past events', () => {
    expect(processNextEventBatch([], 10n, () => true)).toMatchObject({ combatTickAfter: 10n, processed: [] });
    expect(() => createEventQueue([event({ eventId: 'a', sequence: 1 }), event({ eventId: 'a', sequence: 2 })], 0n)).toThrow('duplicate event id');
    expect(() => createEventQueue([event({ eventId: 'a', sequence: 1 }), event({ eventId: 'b', sequence: 1 })], 0n)).toThrow('duplicate event sequence');
    expect(() => createEventQueue([event({ eventId: 'past', sequence: 1, tick: 9n })], 10n)).toThrow('past');
    expect(() => createEventQueue(Array.from({ length: 257 }, (_, index) => event({
      eventId: `event-${index}`, sequence: index,
    })), 0n)).toThrow('maximum size');
  });
});

describe('core-v1 action state machine and slots', () => {
  const action = scheduleAction({
    actionRef: 'slash', actorRef: 'hero', slotRef: 'primary', actionKind: 'physical', targetMode: 'single',
    targetRefs: ['enemy'], startTick: 0n, basePreparationTime: 550n, baseRecoveryTime: 450n,
    effectivePreparationTime: 550n, effectiveRecoveryTime: 450n, resourceReservations: [],
    reactionDepth: 0, canRetargetBeforeEffect: true, interruptible: true,
  });

  it('schedules immutable timings and only allows declared transitions', () => {
    expect(action).toMatchObject({ effectTick: 550n, nextActionAtTick: 1000n, state: 'scheduled' });
    const preparing = transitionActionState(action, 'preparing');
    const resolved = transitionActionState(preparing, 'resolved');
    expect(transitionActionState(resolved, 'recovering').state).toBe('recovering');
    expect(() => transitionActionState(action, 'ready')).toThrow('not allowed');
  });

  it('retargets only before effect when the action explicitly allows it', () => {
    expect(retargetAction(action, 100n, ['other-enemy']).targetRefs).toEqual(['other-enemy']);
    expect(action.targetRefs).toEqual(['enemy']);
    expect(() => retargetAction(action, 550n, ['other-enemy'])).toThrow('before its effect');
    expect(() => retargetAction({ ...action, canRetargetBeforeEffect: false }, 100n, ['other-enemy'])).toThrow('cannot retarget');
  });

  it('enforces reaction depth and active action time', () => {
    expect(() => scheduleAction({ ...action, reactionDepth: 3 } as never)).toThrow('between 0 and 2');
    expect(() => scheduleAction({
      ...action, effectTick: undefined as never, nextActionAtTick: undefined as never,
      effectivePreparationTime: 0n, effectiveRecoveryTime: 0n,
    } as never)).toThrow('non-zero phase');
  });

  it('keeps primary and restricted secondary timelines explicit', () => {
    const primary = createActionSlot({
      slotRef: 'primary', slotType: 'primary', nextActionAtTick: 0n, lastActionAtTick: null,
      allowedActionTags: ['attack'], potencyMultiplierBps: 10000, stateVersion: 0,
    });
    const secondary = createActionSlot({
      slotRef: 'boss-secondary', slotType: 'secondary', nextActionAtTick: 200n, lastActionAtTick: null,
      allowedActionTags: ['minor'], potencyMultiplierBps: 5000, stateVersion: 1,
    });
    expect(canScheduleInActionSlot(primary, ['attack'], true)).toBe(true);
    expect(canScheduleInActionSlot(secondary, ['minor'], false)).toBe(true);
    expect(canScheduleInActionSlot(secondary, ['minor'], true)).toBe(false);
    expect(canScheduleInActionSlot(secondary, ['attack'], false)).toBe(false);
  });
});

describe('core-v1 limited action plans', () => {
  const makePlan = (count: number, stopConditions: readonly ActionPlanStopCondition[] = []): ActionPlan => ({
    actorRef: 'hero', maxPrimaryActions: Math.max(1, Math.min(5, count)),
    steps: Array.from({ length: count }, (_, index) => ({ actionRef: `action-${index}` })),
    stopConditions, expectedCombatTick: 0n, expectedStateVersion: 1,
  });
  const outcome = (ref: string, index: number, stopSignals: ResolvedPlanStep['stopSignals'] = []): ResolvedPlanStep => ({
    actionRef: ref, resolved: true, completionTick: BigInt((index + 1) * 100),
    events: [event({ eventId: `event-${index}`, sequence: index, tick: BigInt((index + 1) * 100) })], stopSignals,
  });

  it.each([1, 5])('executes a plan of %i primary actions', (count) => {
    const result = executeActionPlan(makePlan(count), { combatTick: 0n, stateVersion: 1, nextReadyActors: [] }, (ref, _tick, index) => outcome(ref, index));
    expect(result.resolvedActions).toHaveLength(count);
    expect(result.continuationRequired).toBe(false);
  });

  it('rejects six actions and stops on state version changes', () => {
    expect(() => validateActionPlan(makePlan(6))).toThrow('maxPrimaryActions');
    expect(executeActionPlan(makePlan(1), { combatTick: 0n, stateVersion: 2, nextReadyActors: [] }, () => { throw new Error('not called'); }))
      .toMatchObject({ stopReason: 'stateVersionChanged', continuationRequired: true });
  });

  it.each([
    'actorIncapacitated', 'hostileBecomesReady', 'targetSetChangedMaterially', 'resourceBelowRequired',
    'zoneChanged', 'newThreatDetected', 'stateVersionChanged',
  ] as const)('stops when %s is observed', (condition) => {
    const result = executeActionPlan(makePlan(2, [condition]), { combatTick: 0n, stateVersion: 1, nextReadyActors: ['enemy'] }, (ref, _tick, index) => outcome(ref, index, index === 0 ? [condition] : []));
    expect(result).toMatchObject({ stopReason: condition, continuationRequired: true });
    expect(result.resolvedActions).toHaveLength(1);
  });

  it('stops for no target/defeated target signals and processing event/tick limits', () => {
    const targetStop = executeActionPlan(makePlan(1, ['targetSetChangedMaterially']), { combatTick: 0n, stateVersion: 1, nextReadyActors: [] }, (ref) => ({
      actionRef: ref, resolved: false, completionTick: 0n, events: [], stopSignals: ['targetSetChangedMaterially'],
    }));
    expect(targetStop.stopReason).toBe('targetSetChangedMaterially');

    const eventLimit = executeActionPlan(makePlan(1), { combatTick: 0n, stateVersion: 1, nextReadyActors: [] }, (ref) => ({
      actionRef: ref, resolved: true, completionTick: 100n,
      events: Array.from({ length: 33 }, (_, index) => event({ eventId: `many-${index}`, sequence: index, tick: 100n })), stopSignals: [],
    }));
    expect(eventLimit.stopReason).toBe('processingLimit');

    const tickLimit = executeActionPlan(makePlan(1), { combatTick: 0n, stateVersion: 1, nextReadyActors: [] }, (ref) => ({
      actionRef: ref, resolved: true, completionTick: 5001n, events: [], stopSignals: [],
    }));
    expect(tickLimit.stopReason).toBe('processingLimit');
  });
});
