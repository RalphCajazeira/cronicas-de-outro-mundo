import {
  CORE_V1_MAX_EVENT_QUEUE_SIZE, CORE_V1_MAX_PLAN_ACTIONS,
  CORE_V1_MAX_PROCESSING_ADVANCE, CORE_V1_MAX_PROCESSING_EVENTS,
} from './core-v1.action-economy.config.js';
import type {
  ActionPlan, ActionPlanContext, ActionPlanResult, ActionSlot, ActionState, EventBatchResult,
  EventResolution, PureAction, ResolvedPlanStep, ResourceReservation, TimelineEvent,
  TimelineEventType,
} from './core-v1.action-economy.types.js';
import { assertInteger, assertIntegerInRange, clamp, safeIntegerSum } from './core-v1.math.js';
import { addTicks, advanceCombatTick, assertCombatTick, assertTick } from './core-v1.ticks.js';

const eventPriority: Readonly<Record<TimelineEventType, number>> = Object.freeze({
  invalidation: 1,
  reaction_resolution: 2,
  action_effect: 3,
  channel_pulse: 4,
  upkeep: 4,
  actor_ready: 5,
});

const actionKinds = new Set<PureAction['actionKind']>([
  'physical', 'magic', 'hybrid', 'movement', 'item', 'equipment', 'single', 'multi_target',
  'area', 'chain', 'cleave', 'combo', 'reaction', 'extra_action',
]);
const targetModes = new Set<PureAction['targetMode']>(['self', 'single', 'multiple', 'area', 'zone', 'none']);
const planStopConditions = new Set<ActionPlan['stopConditions'][number]>([
  'actorIncapacitated', 'hostileBecomesReady', 'targetSetChangedMaterially',
  'resourceBelowRequired', 'zoneChanged', 'newThreatDetected', 'stateVersionChanged', 'processingLimit',
]);

const transitionStates = <T extends readonly ActionState[]>(...states: T): Readonly<T> => Object.freeze(states);

const allowedTransitions = Object.freeze({
  scheduled: transitionStates('preparing', 'casting', 'moving', 'cancelled', 'invalidated'),
  preparing: transitionStates('resolved', 'interrupted', 'cancelled', 'invalidated'),
  casting: transitionStates('resolved', 'interrupted', 'cancelled', 'invalidated'),
  moving: transitionStates('resolved', 'interrupted', 'cancelled', 'invalidated'),
  resolved: transitionStates('recovering', 'ready'),
  interrupted: transitionStates('recovering', 'ready'),
  cancelled: transitionStates('ready'),
  invalidated: transitionStates('ready'),
  recovering: transitionStates('ready'),
  ready: transitionStates('scheduled'),
}) satisfies Readonly<Record<ActionState, readonly ActionState[]>>;

function assertRef(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
}

function cloneEvent(event: TimelineEvent): TimelineEvent {
  return { ...event };
}

function assertTimelineEvent(event: TimelineEvent, currentTick?: bigint): void {
  assertRef(event.eventId, 'eventId');
  assertRef(event.actorRef, 'actorRef');
  assertRef(event.stableRef, 'stableRef');
  if (event.actionRef !== undefined) assertRef(event.actionRef, 'actionRef');
  if (!Object.hasOwn(eventPriority, event.type)) throw new TypeError('event type is invalid');
  assertIntegerInRange(event.sequence, 0, Number.MAX_SAFE_INTEGER, 'event sequence');
  assertInteger(event.initiativeScore, 'initiativeScore');
  assertInteger(event.agility, 'agility');
  assertInteger(event.perception, 'perception');
  assertInteger(event.luck, 'luck');
  assertInteger(event.rngTieBreak, 'rngTieBreak');
  assertIntegerInRange(event.reactionDepth, 0, 2, 'reactionDepth');
  assertCombatTick(event.tick, 'event tick');
  if (currentTick !== undefined && event.tick < currentTick) throw new RangeError('event must not be in the past');
}

export function calculateInitiativeScore(
  perception: number,
  agility: number,
  readinessModifier = 0,
  statusModifier = 0,
): number {
  [perception, agility, readinessModifier, statusModifier].forEach((value, index) => {
    assertInteger(value, ['perception', 'agility', 'readinessModifier', 'statusModifier'][index] ?? 'initiative input');
  });
  return safeIntegerSum([2 * perception, agility, readinessModifier, statusModifier], 'initiative score');
}

export function calculateBaseInitiativeDelay(initiativeScore: number): bigint {
  assertInteger(initiativeScore, 'initiativeScore');
  return BigInt(clamp(0, 1000, 500 - 10 * (initiativeScore - 30)));
}

export function calculateFirstNextActionAtTick(initiativeScore: number, surprised = false): bigint {
  if (typeof surprised !== 'boolean') throw new TypeError('surprised must be boolean');
  return addTicks(calculateBaseInitiativeDelay(initiativeScore), surprised ? 1000n : 0n, 'first ready tick');
}

export function compareTimelineEvents(left: TimelineEvent, right: TimelineEvent): number {
  assertTimelineEvent(left);
  assertTimelineEvent(right);
  if (left.tick !== right.tick) return left.tick < right.tick ? -1 : 1;
  const priorityDifference = eventPriority[left.type] - eventPriority[right.type];
  if (priorityDifference !== 0) return priorityDifference;
  const descendingPairs = [
    [left.initiativeScore, right.initiativeScore],
    [left.agility, right.agility],
    [left.perception, right.perception],
    [left.luck, right.luck],
    [left.rngTieBreak, right.rngTieBreak],
  ] as const;
  for (const [leftValue, rightValue] of descendingPairs) {
    if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1;
  }
  const stable = left.stableRef < right.stableRef ? -1 : left.stableRef > right.stableRef ? 1 : 0;
  return stable !== 0 ? stable : left.sequence - right.sequence;
}

export function createEventQueue(events: readonly TimelineEvent[], currentTick: bigint): readonly TimelineEvent[] {
  const runtimeEvents: unknown = events;
  if (!Array.isArray(runtimeEvents)) throw new TypeError('events must be an array');
  assertCombatTick(currentTick);
  if (events.length > CORE_V1_MAX_EVENT_QUEUE_SIZE) throw new RangeError('event queue exceeds its maximum size');
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const event of events) {
    assertTimelineEvent(event, currentTick);
    if (ids.has(event.eventId)) throw new RangeError(`duplicate event id: ${event.eventId}`);
    if (sequences.has(event.sequence)) throw new RangeError(`duplicate event sequence: ${event.sequence}`);
    ids.add(event.eventId);
    sequences.add(event.sequence);
  }
  return events.map(cloneEvent).sort(compareTimelineEvents);
}

export function processNextEventBatch(
  events: readonly TimelineEvent[],
  currentTick: bigint,
  isStillValid: (event: TimelineEvent, processed: readonly TimelineEvent[]) => boolean,
  resolve: (event: TimelineEvent, processed: readonly TimelineEvent[]) => EventResolution = () => ({}),
): EventBatchResult {
  const queue = createEventQueue(events, currentTick);
  if (queue.length === 0) {
    return { combatTickBefore: currentTick, combatTickAfter: currentTick, processed: [], cancelled: [], remaining: [] };
  }
  const nextTick = queue[0]?.tick;
  if (nextTick === undefined) throw new RangeError('event queue is inconsistent');
  const combatTickAfter = advanceCombatTick(currentTick, nextTick);
  const batch = queue.filter((event) => event.tick === nextTick);
  const remaining = queue.filter((event) => event.tick !== nextTick).map(cloneEvent);
  const processed: TimelineEvent[] = [];
  const cancelled: TimelineEvent[] = [];
  const cancelledIds = new Set<string>();
  const scheduled: TimelineEvent[] = [];
  for (const event of batch) {
    if (cancelledIds.has(event.eventId) || !isStillValid(cloneEvent(event), processed.map(cloneEvent))) {
      cancelled.push(cloneEvent(event));
      continue;
    }
    processed.push(cloneEvent(event));
    const resolution = resolve(cloneEvent(event), processed.map(cloneEvent));
    resolution.cancelEventIds?.forEach((id) => {
      if (processed.some((item) => item.eventId === id)) {
        throw new RangeError('an event resolution cannot cancel an event already processed');
      }
      cancelledIds.add(id);
    });
    resolution.scheduledEvents?.forEach((newEvent) => scheduled.push(cloneEvent(newEvent)));
  }
  for (const event of batch) {
    if (cancelledIds.has(event.eventId) && !cancelled.some((item) => item.eventId === event.eventId)) {
      cancelled.push(cloneEvent(event));
    }
  }
  const processedIds = new Set(processed.map((event) => event.eventId));
  const finalProcessed = processed;
  const later = [...remaining, ...scheduled].filter((event) => !cancelledIds.has(event.eventId));
  const finalRemaining = createEventQueue(later, combatTickAfter);
  return {
    combatTickBefore: currentTick,
    combatTickAfter,
    processed: finalProcessed,
    cancelled: cancelled.filter((event, index, all) => all.findIndex((item) => item.eventId === event.eventId) === index),
    remaining: finalRemaining.filter((event) => !processedIds.has(event.eventId)),
  };
}

export function transitionActionState(action: PureAction, nextState: ActionState): PureAction {
  const transitions: readonly ActionState[] = allowedTransitions[action.state];
  if (transitions === undefined) throw new TypeError('current action state is invalid');
  if (!transitions.includes(nextState)) {
    throw new RangeError(`action state transition ${action.state} -> ${nextState} is not allowed`);
  }
  return { ...action, targetRefs: [...action.targetRefs], resourceReservations: action.resourceReservations.map((item) => ({ ...item })), state: nextState };
}

export function retargetAction(
  action: PureAction,
  currentTick: bigint,
  targetRefs: readonly string[],
): PureAction {
  assertCombatTick(currentTick, 'currentTick');
  if (!action.canRetargetBeforeEffect) throw new RangeError('action cannot retarget');
  if (currentTick >= action.effectTick) throw new RangeError('action can only retarget before its effect tick');
  const runtimeTargets: unknown = targetRefs;
  if (!Array.isArray(runtimeTargets) || targetRefs.length === 0 || new Set(targetRefs).size !== targetRefs.length) {
    throw new RangeError('retargeting requires unique targets');
  }
  targetRefs.forEach((ref) => assertRef(ref, 'targetRef'));
  return {
    ...action,
    targetRefs: [...targetRefs],
    resourceReservations: action.resourceReservations.map((reservation) => ({ ...reservation })),
  };
}

export interface ScheduleActionInput extends Omit<PureAction, 'effectTick' | 'nextActionAtTick' | 'state'> {
  readonly state?: Extract<ActionState, 'scheduled' | 'preparing' | 'casting' | 'moving'>;
}

export function scheduleAction(input: ScheduleActionInput): PureAction {
  [input.actionRef, input.actorRef, input.slotRef].forEach((value, index) => assertRef(value, ['actionRef', 'actorRef', 'slotRef'][index] ?? 'ref'));
  assertCombatTick(input.startTick, 'startTick');
  if (!actionKinds.has(input.actionKind)) throw new TypeError('actionKind is invalid');
  if (!targetModes.has(input.targetMode)) throw new TypeError('targetMode is invalid');
  if (typeof input.canRetargetBeforeEffect !== 'boolean') throw new TypeError('canRetargetBeforeEffect must be boolean');
  if (typeof input.interruptible !== 'boolean') throw new TypeError('interruptible must be boolean');
  assertTick(input.basePreparationTime, 'basePreparationTime');
  assertTick(input.baseRecoveryTime, 'baseRecoveryTime');
  assertTick(input.effectivePreparationTime, 'effectivePreparationTime');
  assertTick(input.effectiveRecoveryTime, 'effectiveRecoveryTime');
  if (input.effectivePreparationTime === 0n && input.effectiveRecoveryTime === 0n) {
    throw new RangeError('an active action must have at least one non-zero phase');
  }
  const effectiveCycle = input.effectivePreparationTime + input.effectiveRecoveryTime;
  if (effectiveCycle < 100n || effectiveCycle > 40000n) {
    throw new RangeError('effective action cycle must be between 100 and 40000 ticks');
  }
  assertIntegerInRange(input.reactionDepth, 0, 2, 'reactionDepth');
  const runtimeTargetRefs: unknown = input.targetRefs;
  if (!Array.isArray(runtimeTargetRefs) || new Set(input.targetRefs).size !== input.targetRefs.length) {
    throw new RangeError('targetRefs must be a unique array');
  }
  input.targetRefs.forEach((ref) => assertRef(ref, 'targetRef'));
  const runtimeReservations: unknown = input.resourceReservations;
  if (!Array.isArray(runtimeReservations)) throw new TypeError('resourceReservations must be an array');
  input.resourceReservations.forEach((reservation: ResourceReservation) => {
    if (reservation.resource !== 'mana' && reservation.resource !== 'sp' && reservation.resource !== 'custom') {
      throw new TypeError('reservation resource is invalid');
    }
    if (reservation.resource === 'custom'
      && (reservation.resourceRef === undefined || reservation.resourceRef.trim().length === 0)) {
      throw new TypeError('custom reservation requires resourceRef');
    }
    assertIntegerInRange(reservation.amount, 0, Number.MAX_SAFE_INTEGER, 'reservation amount');
  });
  if (input.state !== undefined && !['scheduled', 'preparing', 'casting', 'moving'].includes(input.state)) {
    throw new TypeError('initial action state is invalid');
  }
  const effectTick = addTicks(input.startTick, input.effectivePreparationTime, 'effect tick');
  const nextActionAtTick = addTicks(effectTick, input.effectiveRecoveryTime, 'next action tick');
  assertCombatTick(effectTick, 'effectTick');
  assertCombatTick(nextActionAtTick, 'nextActionAtTick');
  return {
    ...input,
    targetRefs: [...input.targetRefs],
    resourceReservations: input.resourceReservations.map((item) => ({ ...item })),
    effectTick,
    nextActionAtTick,
    state: input.state ?? 'scheduled',
  };
}

export function createActionSlot(input: ActionSlot): ActionSlot {
  assertRef(input.slotRef, 'slotRef');
  if (input.slotType !== 'primary' && input.slotType !== 'secondary') throw new TypeError('slotType is invalid');
  assertCombatTick(input.nextActionAtTick, 'nextActionAtTick');
  if (input.lastActionAtTick !== null) assertCombatTick(input.lastActionAtTick, 'lastActionAtTick');
  assertIntegerInRange(input.potencyMultiplierBps, 1, input.slotType === 'primary' ? 20000 : 10000, 'potencyMultiplierBps');
  assertIntegerInRange(input.stateVersion, 0, Number.MAX_SAFE_INTEGER, 'stateVersion');
  const runtimeAllowedTags: unknown = input.allowedActionTags;
  if (!Array.isArray(runtimeAllowedTags)) throw new TypeError('allowedActionTags must be an array');
  input.allowedActionTags.forEach((tag) => assertRef(tag, 'allowedActionTag'));
  return { ...input, allowedActionTags: [...input.allowedActionTags] };
}

export function canScheduleInActionSlot(
  slot: ActionSlot,
  actionTags: readonly string[],
  isFullPrimaryAction: boolean,
): boolean {
  const checked = createActionSlot(slot);
  if (checked.slotType === 'secondary' && isFullPrimaryAction) return false;
  return actionTags.every((tag) => checked.allowedActionTags.includes(tag));
}

export function validateActionPlan(plan: ActionPlan): ActionPlan {
  assertRef(plan.actorRef, 'actorRef');
  assertIntegerInRange(plan.maxPrimaryActions, 1, CORE_V1_MAX_PLAN_ACTIONS, 'maxPrimaryActions');
  assertCombatTick(plan.expectedCombatTick, 'expectedCombatTick');
  assertIntegerInRange(plan.expectedStateVersion, 0, Number.MAX_SAFE_INTEGER, 'expectedStateVersion');
  const runtimeSteps: unknown = plan.steps;
  if (!Array.isArray(runtimeSteps) || plan.steps.length === 0 || plan.steps.length > plan.maxPrimaryActions) {
    throw new RangeError('action plan steps must fit maxPrimaryActions');
  }
  if (plan.steps.length > CORE_V1_MAX_PLAN_ACTIONS) throw new RangeError('action plan supports at most 5 actions');
  plan.steps.forEach((step) => assertRef(step.actionRef, 'actionRef'));
  if (new Set(plan.steps.map((step) => step.actionRef)).size !== plan.steps.length) {
    throw new RangeError('action plan actionRefs must be unique');
  }
  const runtimeStopConditions: unknown = plan.stopConditions;
  if (!Array.isArray(runtimeStopConditions)) throw new TypeError('stopConditions must be an array');
  plan.stopConditions.forEach((condition) => {
    if (!planStopConditions.has(condition)) throw new TypeError('action plan stop condition is invalid');
  });
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })), stopConditions: [...plan.stopConditions] };
}

export function executeActionPlan(
  sourcePlan: ActionPlan,
  context: ActionPlanContext,
  resolveStep: (stepRef: string, currentTick: bigint, resolvedCount: number) => ResolvedPlanStep,
): ActionPlanResult {
  const plan = validateActionPlan(sourcePlan);
  assertCombatTick(context.combatTick, 'combatTick');
  assertIntegerInRange(context.stateVersion, 0, Number.MAX_SAFE_INTEGER, 'stateVersion');
  const baseResult = {
    resolvedActions: [] as string[], events: [] as TimelineEvent[], combatTickBefore: context.combatTick,
    combatTickAfter: context.combatTick, nextReadyActors: [...context.nextReadyActors],
  };
  if (context.combatTick !== plan.expectedCombatTick || context.stateVersion !== plan.expectedStateVersion) {
    return { ...baseResult, stopReason: 'stateVersionChanged', continuationRequired: true };
  }
  let currentTick = context.combatTick;
  for (const step of plan.steps) {
    const outcome = resolveStep(step.actionRef, currentTick, baseResult.resolvedActions.length);
    if (outcome.actionRef !== step.actionRef) throw new RangeError('resolved action does not match the plan step');
    assertCombatTick(outcome.completionTick, 'completionTick');
    if (outcome.completionTick < currentTick) throw new RangeError('plan step completion must not be in the past');
    if (!outcome.resolved) {
      const signal = outcome.stopSignals.find((item) => plan.stopConditions.includes(item));
      return { ...baseResult, combatTickAfter: currentTick, stopReason: signal ?? 'targetSetChangedMaterially', continuationRequired: true };
    }
    const prospectiveEvents = baseResult.events.length + outcome.events.length;
    const prospectiveAdvance = outcome.completionTick - context.combatTick;
    if (prospectiveEvents > CORE_V1_MAX_PROCESSING_EVENTS || prospectiveAdvance > CORE_V1_MAX_PROCESSING_ADVANCE) {
      return { ...baseResult, combatTickAfter: currentTick, stopReason: 'processingLimit', continuationRequired: true };
    }
    outcome.events.forEach((event) => {
      assertTimelineEvent(event, currentTick);
      if (event.tick > outcome.completionTick) throw new RangeError('plan step event cannot occur after completion');
    });
    createEventQueue([...baseResult.events, ...outcome.events], context.combatTick);
    baseResult.resolvedActions.push(outcome.actionRef);
    baseResult.events.push(...outcome.events.map(cloneEvent));
    currentTick = outcome.completionTick;
    const stopReason = outcome.stopSignals.find((item) => plan.stopConditions.includes(item));
    if (stopReason !== undefined) {
      return { ...baseResult, combatTickAfter: currentTick, stopReason, continuationRequired: true };
    }
  }
  return { ...baseResult, combatTickAfter: currentTick, stopReason: null, continuationRequired: false };
}
