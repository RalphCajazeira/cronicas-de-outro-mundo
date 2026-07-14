import {
  CORE_V1_MAX_COMBO_EVENTS,
  CORE_V1_MAX_COMBO_STEPS,
  CORE_V1_MAX_EVENT_QUEUE_SIZE,
  CORE_V1_MAX_PROCESSING_ADVANCE,
  CORE_V1_MAX_PROCESSING_EVENTS,
} from './core-v1.action-economy.config.js';
import {
  calculateMovement,
  calculateMobileCastTime,
  completeCasting,
  getReactionDefinition,
  interruptCasting,
  resolveReaction,
  scheduleChannelPulseEvents,
  startCasting,
  validateMultiTargetAction,
  zoneDistance,
} from './core-v1.action-mechanics.js';
import type {
  CombatZone,
  TimelineEvent,
  TimelineEventType,
} from './core-v1.action-economy.types.js';
import {
  calculateHybridSpeedBps,
  calculateMagicalActionTimes,
  calculateMagicalSpeed,
  calculatePhysicalActionTimes,
  calculatePhysicalSpeed,
  getRepresentativeTemporalProfile,
  getTemporalProfile,
} from './core-v1.temporal.js';
import {
  calculateFirstNextActionAtTick,
  calculateInitiativeScore,
  canScheduleInActionSlot,
  createActionSlot,
  createEventQueue,
} from './core-v1.timeline.js';
import {
  CORE_V1_ENCOUNTER_RULESET_CODE,
  CORE_V1_ENCOUNTER_RULES_CODE,
  CORE_V1_ENCOUNTER_SCHEMA_VERSION,
  CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE,
  CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
  CORE_V1_MAX_ENCOUNTER_COMBO_EVENTS,
  CORE_V1_MAX_ENCOUNTER_EVENTS,
  CORE_V1_MAX_ENCOUNTER_PARTICIPANTS,
  CORE_V1_MAX_ENCOUNTER_PLAN_ACTIONS,
  CORE_V1_MAX_ENCOUNTER_TARGETS,
} from './core-v1.encounter.config.js';
import type {
  CoreV1ApplyEncounterActionPlanInput,
  CoreV1ApplyEncounterIntentInput,
  CoreV1CompileEncounterActionInput,
  CoreV1CompiledEncounterAction,
  CoreV1CreateEncounterInput,
  CoreV1EncounterActionDefinition,
  CoreV1EncounterBatchResult,
  CoreV1EncounterCombatState,
  CoreV1EncounterCompletionCandidate,
  CoreV1EncounterCooldown,
  CoreV1EncounterEvent,
  CoreV1EncounterEventType,
  CoreV1EncounterParticipant,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterReactionPolicy,
  CoreV1EncounterRelation,
  CoreV1EncounterResult,
  CoreV1EncounterRuntime,
  CoreV1EncounterState,
  CoreV1EncounterStopReason,
  CoreV1EncounterTargetCandidate,
  CoreV1EncounterTargetRequest,
  CoreV1ReactionOutcome,
  CoreV1ResolvedEncounterTarget,
  EncounterRollProvider,
} from './core-v1.encounter.types.js';
import type {
  CoreV1Effect,
  CoreV1MechanicalContentProfile,
  CoreV1Targeting,
} from './core-v1.content-mechanics.types.js';
import { validateCoreV1ContentProfile } from './core-v1.content-mechanics.js';
import {
  isCoreV1ActorEffectContext,
  resolveCoreV1ConsumableUse,
  resolveCoreV1Cost,
  resolveCoreV1EffectSequence,
} from './core-v1.effects.js';
import type {
  CoreV1ActorEffectContext,
  CoreV1CostResolution,
  CoreV1EffectSequenceInput,
  CoreV1EffectSequenceResult,
  CoreV1InjectedRolls,
  CoreV1RuntimeDurationBinding,
  CoreV1StatusDefinitionBinding,
} from './core-v1.effects.types.js';
import type { CoreV1ContentVersionReference } from './core-v1.inventory.types.js';
import { validateCoreV1InventoryState } from './core-v1.inventory.js';
import { validateEquipmentLoadout } from './core-v1.equipment.js';
import {
  assertIntegerInRange,
  isPlainRecord,
  safeIntegerAdd,
} from './core-v1.math.js';
import { addTicks, assertCombatTick, validateCooldown } from './core-v1.ticks.js';
import type { ValidationIssue } from './core-v1.types.js';

const stableRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cloneValue: <T>(value: T) => T = structuredClone;
const combatStates = new Set<CoreV1EncounterCombatState>([
  'ready', 'preparing', 'casting', 'moving', 'recovering',
  'incapacitated_candidate', 'removed',
]);
const relations = new Set<CoreV1EncounterRelation>(['ally', 'hostile', 'neutral', 'self']);
const targetSelectors = new Set(['self', 'explicit', 'nearest_hostile', 'lowest_hp_hostile', 'nearest_ally']);
const actionPlanStopConditions = new Set([
  'actorIncapacitated', 'hostileBecomesReady', 'targetSetChangedMaterially',
  'resourceBelowRequired', 'zoneChanged', 'newThreatDetected', 'stateVersionChanged',
  'processingLimit', 'noValidTarget', 'reactionRequired', 'newPlayerIntentRequired',
]);
const zones = ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const;
const eventTypes = new Set<CoreV1EncounterEventType>([
  'action_started', 'action_effect', 'action_invalidated', 'action_interrupted',
  'reaction_started', 'reaction_resolved', 'counter_attack_started', 'channel_pulse',
  'upkeep_due', 'movement_effect', 'actor_ready', 'cooldown_expired',
  'participant_incapacitated_candidate',
]);

function issue(
  path: string,
  rule: string,
  message: string,
  expected?: unknown,
  received?: unknown,
): ValidationIssue {
  const result: ValidationIssue = { path, rule, message };
  if (expected !== undefined) result.expected = expected;
  if (received !== undefined) result.received = received;
  return result;
}

function failure<T>(issues: readonly ValidationIssue[]): CoreV1EncounterResult<T> {
  return {
    ok: false,
    code: 'INVALID_CORE_V1_ENCOUNTER_OPERATION',
    retryable: true,
    issues: cloneValue(issues),
  };
}

function success<T>(value: T): CoreV1EncounterResult<T> {
  return { ok: true, value: cloneValue(value) };
}

function caughtFailure<T>(error: unknown, path = '$'): CoreV1EncounterResult<T> {
  const message = error instanceof RangeError
    ? 'Encounter value is outside an approved range'
    : 'Encounter value has an invalid type or shape';
  return failure([issue(path, 'INVALID_ENCOUNTER_INPUT', message)]);
}

function isStableRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && stableRefPattern.test(value) && !uuidPattern.test(value);
}

function isDeterministicInternalRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && stableRefPattern.test(value) && !uuidPattern.test(value);
}

function isArrayValue(value: unknown): boolean {
  return Array.isArray(value);
}

function unknownFieldIssues(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): ValidationIssue[] {
  return Object.keys(value).filter((key) => !allowed.has(key)).map((key) => issue(
    path.length === 0 ? key : `${path}.${key}`,
    'UNKNOWN_FIELD',
    'Field is not part of the closed encounter contract',
  ));
}

function relationKey(left: string, right: string): string {
  return left <= right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function relationFor(
  encounter: CoreV1EncounterState,
  leftActorRef: string,
  rightActorRef: string,
): CoreV1EncounterRelation | null {
  return encounter.relations.find((entry) => relationKey(entry.leftActorRef, entry.rightActorRef)
    === relationKey(leftActorRef, rightActorRef))?.relation ?? null;
}

function participantActor(participant: CoreV1EncounterParticipant): CoreV1ActorEffectContext {
  return {
    actorRef: participant.actorRef,
    primaryAttributes: participant.primaryAttributes,
    resources: participant.resources,
    secondaryAttributes: participant.secondaryAttributes,
    activeEffects: participant.activeEffects,
    stateVersion: participant.effectsStateVersion,
  };
}

function participantIssues(participant: unknown, path: string): ValidationIssue[] {
  if (!isPlainRecord(participant)) return [issue(path, 'PLAIN_OBJECT', 'Participant must be a plain object')];
  const result: ValidationIssue[] = unknownFieldIssues(participant, new Set([
    'actorRef', 'sideRef', 'actorStateVersion', 'mechanicsStateVersion', 'inventoryStateVersion',
    'effectsStateVersion', 'zone', 'combatState', 'primaryAttributes', 'resources',
    'secondaryAttributes', 'activeEffects', 'actionSlots', 'reactionCapabilities',
    'equipmentContext', 'initiative',
  ]), path);
  if (!isStableRef(participant.actorRef)) result.push(issue(`${path}.actorRef`, 'PUBLIC_REF', 'Actor ref must be stable and must not be a UUID'));
  if (!isStableRef(participant.sideRef)) result.push(issue(`${path}.sideRef`, 'PUBLIC_REF', 'Side ref must be stable and must not be a UUID'));
  for (const field of ['actorStateVersion', 'mechanicsStateVersion', 'inventoryStateVersion', 'effectsStateVersion']) {
    if (!Number.isSafeInteger(participant[field]) || (participant[field] as number) < 1) {
      result.push(issue(`${path}.${field}`, 'POSITIVE_STATE_VERSION', 'State version must be a positive safe integer'));
    }
  }
  if (typeof participant.combatState !== 'string'
    || !combatStates.has(participant.combatState as CoreV1EncounterCombatState)) {
    result.push(issue(`${path}.combatState`, 'ENUM', 'Combat state is not supported'));
  }
  if (typeof participant.zone !== 'string' || !(zones as readonly string[]).includes(participant.zone)) {
    result.push(issue(`${path}.zone`, 'ENUM', 'Combat zone is not supported'));
  }
  const actor = participant as unknown as CoreV1EncounterParticipant;
  if (!isCoreV1ActorEffectContext(participantActor(actor))) {
    result.push(issue(path, 'ACTOR_EFFECT_CONTEXT', 'Participant mechanics are not a valid core-v1 actor projection'));
  }
  if (!isArrayValue(participant.actionSlots)) result.push(issue(`${path}.actionSlots`, 'ARRAY', 'Action slots must be an array'));
  else {
    const refs = new Set<string>();
    actor.actionSlots.forEach((slot, index) => {
      try {
        const valid = createActionSlot(slot);
        if (refs.has(valid.slotRef)) result.push(issue(`${path}.actionSlots.${index}.slotRef`, 'DUPLICATE_SLOT', 'Action slot refs must be unique'));
        refs.add(valid.slotRef);
      } catch {
        result.push(issue(`${path}.actionSlots.${index}`, 'ACTION_SLOT', 'Action slot is invalid'));
      }
    });
  }
  if (!isArrayValue(participant.reactionCapabilities)) {
    result.push(issue(`${path}.reactionCapabilities`, 'ARRAY', 'Reaction capabilities must be an array'));
  } else {
    const refs = new Set<string>();
    actor.reactionCapabilities.forEach((capability, index) => {
      if (!isPlainRecord(capability) || !isStableRef(capability.capabilityRef)) {
        result.push(issue(`${path}.reactionCapabilities.${index}`, 'REACTION_CAPABILITY', 'Reaction capability is invalid'));
        return;
      }
      if (refs.has(capability.capabilityRef)) result.push(issue(`${path}.reactionCapabilities.${index}.capabilityRef`, 'DUPLICATE', 'Reaction capability refs must be unique'));
      refs.add(capability.capabilityRef);
      try {
        getReactionDefinition(capability.kind);
        assertIntegerInRange(capability.tier, 1, 10, 'reaction tier');
        if (capability.blockValue !== undefined) assertIntegerInRange(capability.blockValue, 0, Number.MAX_SAFE_INTEGER, 'blockValue');
      } catch {
        result.push(issue(`${path}.reactionCapabilities.${index}`, 'REACTION_CAPABILITY', 'Reaction capability uses invalid RC1.1 data'));
      }
    });
  }
  const inventory = validateCoreV1InventoryState(actor.equipmentContext.inventory);
  if (!inventory.ok) result.push(issue(`${path}.equipmentContext.inventory`, 'INVENTORY_STATE', 'Equipment inventory projection is invalid'));
  else if (!validateEquipmentLoadout(inventory.value, actor.equipmentContext.loadout).ok) {
    result.push(issue(`${path}.equipmentContext.loadout`, 'EQUIPMENT_STATE', 'Equipment loadout projection is invalid'));
  }
  if (!isPlainRecord(participant.initiative)
    || !Number.isSafeInteger(participant.initiative.score)
    || !Number.isSafeInteger(participant.initiative.tieBreak)
    || typeof participant.initiative.surprised !== 'boolean') {
    result.push(issue(`${path}.initiative`, 'INITIATIVE', 'Initiative projection is invalid'));
  } else {
    try { assertCombatTick(participant.initiative.firstReadyTick as bigint, 'firstReadyTick'); } catch {
      result.push(issue(`${path}.initiative.firstReadyTick`, 'TICK', 'First ready tick is invalid'));
    }
  }
  return result;
}

function queueType(type: CoreV1EncounterEventType): TimelineEventType {
  if (type === 'action_invalidated' || type === 'participant_incapacitated_candidate') return 'invalidation';
  if (type === 'reaction_resolved' || type === 'action_interrupted' || type === 'counter_attack_started') {
    return 'reaction_resolution';
  }
  if (type === 'channel_pulse') return 'channel_pulse';
  if (type === 'upkeep_due') return 'upkeep';
  if (type === 'actor_ready' || type === 'cooldown_expired') return 'actor_ready';
  return 'action_effect';
}

function sortedEncounterEvents(events: readonly CoreV1EncounterEvent[], currentTick: bigint): readonly CoreV1EncounterEvent[] {
  const byId = new Map(events.map((event) => [event.timelineEvent.eventId, event]));
  const ordered = createEventQueue(events.map((event) => event.timelineEvent), currentTick);
  return ordered.map((event) => {
    const wrapper = byId.get(event.eventId);
    if (wrapper === undefined) throw new RangeError('Encounter event wrapper is missing');
    return cloneValue(wrapper);
  });
}

export function validateCoreV1EncounterState(input: unknown): CoreV1EncounterResult<CoreV1EncounterState> {
  if (!isPlainRecord(input)) return failure([issue('$', 'PLAIN_OBJECT', 'Encounter state must be a plain object')]);
  const state = input as unknown as CoreV1EncounterState;
  try {
    const issues: ValidationIssue[] = unknownFieldIssues(input, new Set([
      'schemaVersion', 'rulesetCode', 'encounterRulesCode', 'encounterRef', 'partySideRef',
      'currentTick', 'stateVersion', 'actionSequence', 'status', 'participants', 'relations',
      'scheduledEvents', 'activeActions', 'cooldowns', 'actionPlans', 'completionCandidate',
    ]), '');
  if (state.schemaVersion !== CORE_V1_ENCOUNTER_SCHEMA_VERSION) issues.push(issue('schemaVersion', 'SCHEMA_VERSION', 'Encounter schema version must be 1'));
  if (state.rulesetCode !== CORE_V1_ENCOUNTER_RULESET_CODE) issues.push(issue('rulesetCode', 'RULESET_CODE', 'Encounter ruleset must be core-v1'));
  if (state.encounterRulesCode !== CORE_V1_ENCOUNTER_RULES_CODE) issues.push(issue('encounterRulesCode', 'ENCOUNTER_RULES_CODE', 'Encounter rules code is not supported'));
  if (!isStableRef(state.encounterRef)) issues.push(issue('encounterRef', 'PUBLIC_REF', 'Encounter ref must be stable and must not be a UUID'));
  if (state.partySideRef !== null && !isStableRef(state.partySideRef)) issues.push(issue('partySideRef', 'PUBLIC_REF', 'Party side ref must be stable when supplied'));
  try { assertCombatTick(state.currentTick, 'currentTick'); } catch { issues.push(issue('currentTick', 'TICK', 'Current tick must be a supported non-negative bigint')); }
  if (!Number.isSafeInteger(state.stateVersion) || state.stateVersion < 1) issues.push(issue('stateVersion', 'POSITIVE_STATE_VERSION', 'Encounter state version must be positive'));
  if (!Number.isSafeInteger(state.actionSequence) || state.actionSequence < 1) issues.push(issue('actionSequence', 'POSITIVE_SEQUENCE', 'Action sequence must be positive'));
  if (!['setup', 'active', 'paused', 'completed', 'cancelled', 'failed'].includes(state.status)) issues.push(issue('status', 'ENUM', 'Encounter status is not supported'));
  if (!isArrayValue(state.participants)) issues.push(issue('participants', 'ARRAY', 'Participants must be an array'));
  else if (state.participants.length > CORE_V1_MAX_ENCOUNTER_PARTICIPANTS) issues.push(issue('participants', 'PARTICIPANT_LIMIT', 'Encounter supports at most 64 participants'));
  else {
    const refs = new Set<string>();
    state.participants.forEach((participant, index) => {
      issues.push(...participantIssues(participant, `participants.${index}`));
      if (refs.has(participant.actorRef)) issues.push(issue(`participants.${index}.actorRef`, 'DUPLICATE_ACTOR_REF', 'Participant actor refs must be unique'));
      refs.add(participant.actorRef);
    });
    const sorted = [...state.participants].sort((left, right) => left.actorRef.localeCompare(right.actorRef));
    if (state.participants.some((participant, index) => participant.actorRef !== sorted[index]?.actorRef)) {
      issues.push(issue('participants', 'DETERMINISTIC_ORDER', 'Participants must be ordered by actor ref'));
    }
  }
  if (!isArrayValue(state.relations)) issues.push(issue('relations', 'ARRAY', 'Relations must be an array'));
  else if (isArrayValue(state.participants)) {
    const participantRefs = new Set(state.participants.map((participant) => participant.actorRef));
    const seen = new Set<string>();
    for (const [index, relation] of state.relations.entries()) {
      if (!participantRefs.has(relation.leftActorRef) || !participantRefs.has(relation.rightActorRef)) {
        issues.push(issue(`relations.${index}`, 'UNKNOWN_ACTOR_REF', 'Relation references an unknown participant'));
      }
      const key = relationKey(relation.leftActorRef, relation.rightActorRef);
      if (seen.has(key)) issues.push(issue(`relations.${index}`, 'DUPLICATE_RELATION', 'Each participant pair must have exactly one relation'));
      seen.add(key);
      if (!relations.has(relation.relation)) issues.push(issue(`relations.${index}.relation`, 'ENUM', 'Relation is not supported'));
      if (relation.leftActorRef === relation.rightActorRef && relation.relation !== 'self') issues.push(issue(`relations.${index}.relation`, 'SELF_RELATION', 'An actor relation to itself must be self'));
      if (relation.leftActorRef !== relation.rightActorRef && relation.relation === 'self') issues.push(issue(`relations.${index}.relation`, 'SELF_RELATION', 'Self relation is valid only for the same actor'));
    }
    const expected = state.participants.length * (state.participants.length + 1) / 2;
    if (seen.size !== expected) issues.push(issue('relations', 'RELATION_COVERAGE', 'Every unordered participant pair, including self, needs one relation', expected, seen.size));
  }
  if (!isArrayValue(state.scheduledEvents)) issues.push(issue('scheduledEvents', 'ARRAY', 'Scheduled events must be an array'));
  else if (state.scheduledEvents.length > Math.min(CORE_V1_MAX_ENCOUNTER_EVENTS, CORE_V1_MAX_EVENT_QUEUE_SIZE)) {
    issues.push(issue('scheduledEvents', 'EVENT_LIMIT', 'Encounter event queue exceeds 256 events'));
  } else {
    state.scheduledEvents.forEach((event, index) => {
      if (!isDeterministicInternalRef(event.eventRef) || event.eventRef !== event.timelineEvent.eventId) issues.push(issue(`scheduledEvents.${index}.eventRef`, 'EVENT_REF', 'Event ref must match the queue event id'));
      if (!eventTypes.has(event.type)) issues.push(issue(`scheduledEvents.${index}.type`, 'ENUM', 'Encounter event type is not supported'));
      if (event.timelineEvent.type !== queueType(event.type)) issues.push(issue(`scheduledEvents.${index}.timelineEvent.type`, 'EVENT_PRIORITY', 'Encounter event must use its canonical queue priority'));
    });
    try {
      const ordered = sortedEncounterEvents(state.scheduledEvents, state.currentTick);
      if (state.scheduledEvents.some((event, index) => event.eventRef !== ordered[index]?.eventRef)) issues.push(issue('scheduledEvents', 'DETERMINISTIC_ORDER', 'Scheduled events must use queue order'));
    } catch { issues.push(issue('scheduledEvents', 'EVENT_QUEUE', 'Scheduled events violate the core-v1 event queue contract')); }
  }
  if (!isArrayValue(state.activeActions)) issues.push(issue('activeActions', 'ARRAY', 'Active actions must be an array'));
  else if (new Set(state.activeActions.map((action) => action.actionRef)).size !== state.activeActions.length) issues.push(issue('activeActions', 'DUPLICATE_ACTION_REF', 'Active action refs must be unique'));
  if (!isArrayValue(state.cooldowns)) issues.push(issue('cooldowns', 'ARRAY', 'Cooldowns must be an array'));
  else {
    const refs = new Set<string>();
    state.cooldowns.forEach((cooldown, index) => {
      const key = `${cooldown.actorRef}\u0000${cooldown.cooldownRef}`;
      if (!isStableRef(cooldown.actorRef) || !isStableRef(cooldown.cooldownRef)
        || !state.participants.some((participant) => participant.actorRef === cooldown.actorRef)) {
        issues.push(issue(`cooldowns.${index}`, 'COOLDOWN_REF', 'Cooldown must use a known actor and stable ref'));
      }
      if (cooldown.sourceKind !== 'reaction' && cooldown.sourceKind !== 'content') {
        issues.push(issue(`cooldowns.${index}.sourceKind`, 'ENUM', 'Cooldown source kind is invalid'));
      }
      if (refs.has(key)) issues.push(issue(`cooldowns.${index}`, 'DUPLICATE_COOLDOWN', 'Cooldown refs must be unique per actor'));
      refs.add(key);
      try { assertCombatTick(cooldown.readyAtTick, 'readyAtTick'); } catch {
        issues.push(issue(`cooldowns.${index}.readyAtTick`, 'COOLDOWN_TICK', 'Cooldown ready tick is invalid'));
      }
    });
  }
  if (!isArrayValue(state.actionPlans)) issues.push(issue('actionPlans', 'ARRAY', 'Action plans must be an array'));
    if (issues.length > 0) return failure(issues);
    return success(state);
  } catch (error) {
    return caughtFailure(error);
  }
}

function createInitialParticipant(
  input: CoreV1EncounterParticipantInput,
  currentTick: bigint,
  tieBreak: number,
): CoreV1EncounterParticipant {
  const score = calculateInitiativeScore(
    input.primaryAttributes.perception,
    input.primaryAttributes.agility,
    input.initiative.readinessModifier ?? 0,
    input.initiative.statusModifier ?? 0,
  );
  const surprised = input.initiative.surprised ?? false;
  const firstReadyTick = addTicks(currentTick, calculateFirstNextActionAtTick(score, surprised), 'initial ready tick');
  const actionSlots = input.actionSlots.map((slot) => createActionSlot({
    ...slot,
    nextActionAtTick: slot.nextActionAtTick > firstReadyTick ? slot.nextActionAtTick : firstReadyTick,
  }));
  return {
    ...cloneValue(input),
    actionSlots,
    initiative: { score, tieBreak, firstReadyTick, surprised },
  };
}

function eventFor(
  participant: CoreV1EncounterParticipant,
  eventRef: string,
  sequence: number,
  type: CoreV1EncounterEventType,
  tick: bigint,
  additions: Omit<CoreV1EncounterEvent, 'eventRef' | 'type' | 'timelineEvent'> = {},
): CoreV1EncounterEvent {
  const timelineEvent: TimelineEvent = {
    eventId: eventRef,
    sequence,
    type: queueType(type),
    tick,
    actorRef: participant.actorRef,
    initiativeScore: participant.initiative.score,
    agility: participant.primaryAttributes.agility,
    perception: participant.primaryAttributes.perception,
    luck: participant.primaryAttributes.luck,
    rngTieBreak: participant.initiative.tieBreak,
    stableRef: participant.actorRef,
    reactionDepth: type === 'counter_attack_started' ? 2 : type.startsWith('reaction_') ? 1 : 0,
    ...(additions.actionRef === undefined ? {} : { actionRef: additions.actionRef }),
  };
  return { eventRef, type, timelineEvent, ...additions };
}

export function createCoreV1EncounterState(
  input: CoreV1CreateEncounterInput,
  rollProvider?: Pick<EncounterRollProvider, 'tieBreak'>,
): CoreV1EncounterResult<CoreV1EncounterState> {
  if (!isArrayValue(input.participants) || input.participants.length > CORE_V1_MAX_ENCOUNTER_PARTICIPANTS) {
    return failure([issue('participants', 'PARTICIPANT_LIMIT', 'Encounter supports at most 64 participants')]);
  }
  const actorRefs = input.participants.map((participant) => participant.actorRef);
  if (new Set(actorRefs).size !== actorRefs.length) {
    return failure([issue('participants', 'DUPLICATE_ACTOR_REF', 'Participant actor refs must be unique')]);
  }
  try {
    const currentTick = input.currentTick ?? 0n;
    assertCombatTick(currentTick, 'currentTick');
    const participants = input.participants.map((participant) => createInitialParticipant(
      participant,
      currentTick,
      rollProvider?.tieBreak({ encounterRef: input.encounterRef, actorRef: participant.actorRef })
        ?? participant.initiative.tieBreak,
    ))
      .sort((left, right) => left.actorRef.localeCompare(right.actorRef));
    const relationsInput = input.relations.map((relation) => ({
      ...relation,
      leftActorRef: relation.leftActorRef <= relation.rightActorRef ? relation.leftActorRef : relation.rightActorRef,
      rightActorRef: relation.leftActorRef <= relation.rightActorRef ? relation.rightActorRef : relation.leftActorRef,
    })).sort((left, right) => relationKey(left.leftActorRef, left.rightActorRef)
      .localeCompare(relationKey(right.leftActorRef, right.rightActorRef)));
    const initialEvents = participants.map((participant, index) => eventFor(
      participant,
      `${input.encounterRef}-initial-ready-${participant.actorRef}`,
      index + 1,
      'actor_ready',
      participant.initiative.firstReadyTick,
    ));
    const state: CoreV1EncounterState = {
      schemaVersion: CORE_V1_ENCOUNTER_SCHEMA_VERSION,
      rulesetCode: CORE_V1_ENCOUNTER_RULESET_CODE,
      encounterRulesCode: CORE_V1_ENCOUNTER_RULES_CODE,
      encounterRef: input.encounterRef,
      partySideRef: input.partySideRef ?? null,
      currentTick,
      stateVersion: 1,
      actionSequence: 1,
      status: input.status ?? 'setup',
      participants,
      relations: relationsInput,
      scheduledEvents: sortedEncounterEvents(initialEvents, currentTick),
      activeActions: [],
      cooldowns: [],
      actionPlans: [],
      completionCandidate: null,
    };
    return validateCoreV1EncounterState(state);
  } catch (error) {
    return caughtFailure(error);
  }
}

function candidateOrder(left: CoreV1EncounterTargetCandidate, right: CoreV1EncounterTargetCandidate): number {
  const range = zoneDistance('engaged', left.rangeBand) - zoneDistance('engaged', right.rangeBand);
  return range || left.stableOrder - right.stableOrder || left.actorRef.localeCompare(right.actorRef);
}

function ratioOrder(left: CoreV1EncounterTargetCandidate, right: CoreV1EncounterTargetCandidate): number {
  const leftScaled = BigInt(left.hpCurrent) * BigInt(right.hpMaximum);
  const rightScaled = BigInt(right.hpCurrent) * BigInt(left.hpMaximum);
  if (leftScaled !== rightScaled) return leftScaled < rightScaled ? -1 : 1;
  return left.stableOrder - right.stableOrder || left.actorRef.localeCompare(right.actorRef);
}

function rangeAllows(maximum: CoreV1Targeting['rangeBand'], actual: CombatZone): boolean {
  if (maximum === 'self') return actual === 'engaged';
  if (actual === 'out_of_range') return false;
  return zoneDistance('engaged', actual) <= zoneDistance('engaged', maximum);
}

function validateTargetingContext(
  request: CoreV1EncounterTargetRequest,
): CoreV1EncounterResult<readonly CoreV1EncounterTargetCandidate[]> {
  if (!isArrayValue(request.context.candidates)
    || request.context.candidates.length > CORE_V1_MAX_ENCOUNTER_PARTICIPANTS) {
    return failure([issue('context.candidates', 'CANDIDATE_LIMIT', 'Target candidates exceed the participant limit')]);
  }
  const candidates = request.context.candidates.map((candidate) => cloneValue(candidate));
  const refs = new Set<string>();
  const issues: ValidationIssue[] = isPlainRecord(request.context)
    ? unknownFieldIssues(request.context, new Set([
      'candidates', 'spatialCandidateRefs', 'candidateRanges',
    ]), 'context')
    : [issue('context', 'PLAIN_OBJECT', 'Targeting context must be a plain object')];
  candidates.forEach((candidate, index) => {
    issues.push(...unknownFieldIssues(candidate as unknown as Record<string, unknown>, new Set([
      'actorRef', 'relation', 'rangeBand', 'targetable', 'active',
      'hpCurrent', 'hpMaximum', 'stableOrder',
    ]), `context.candidates.${index}`));
    if (refs.has(candidate.actorRef)) issues.push(issue(`context.candidates.${index}.actorRef`, 'DUPLICATE_TARGET_REF', 'Target candidate refs must be unique'));
    refs.add(candidate.actorRef);
    const participant = request.encounter.participants.find((entry) => entry.actorRef === candidate.actorRef);
    if (participant === undefined) issues.push(issue(`context.candidates.${index}.actorRef`, 'UNKNOWN_ACTOR_REF', 'Target candidate must belong to the encounter'));
    const expectedRelation = relationFor(request.encounter, request.sourceActorRef, candidate.actorRef);
    if (expectedRelation !== candidate.relation) issues.push(issue(`context.candidates.${index}.relation`, 'RELATION_MATCH', 'Candidate relation must match encounter composition'));
    if (!Number.isSafeInteger(candidate.stableOrder) || candidate.stableOrder < 0) issues.push(issue(`context.candidates.${index}.stableOrder`, 'STABLE_ORDER', 'Stable order must be a non-negative safe integer'));
    if (typeof candidate.targetable !== 'boolean' || typeof candidate.active !== 'boolean') {
      issues.push(issue(`context.candidates.${index}`, 'BOOLEAN_FLAGS', 'Candidate targetable and active flags must be booleans'));
    }
    if (!Number.isSafeInteger(candidate.hpCurrent) || !Number.isSafeInteger(candidate.hpMaximum)
      || candidate.hpCurrent < 0 || candidate.hpMaximum < 1 || candidate.hpCurrent > candidate.hpMaximum) {
      issues.push(issue(`context.candidates.${index}`, 'HP_RANGE', 'Candidate HP projection is invalid'));
    }
    if (participant !== undefined && (participant.resources.hp.current !== candidate.hpCurrent
      || participant.resources.hp.maximum !== candidate.hpMaximum)) {
      issues.push(issue(`context.candidates.${index}`, 'STALE_ENCOUNTER_STATE', 'Candidate HP projection is stale'));
    }
  });
  if (request.context.candidateRanges !== undefined) {
    if (request.context.candidateRanges.length > CORE_V1_MAX_ENCOUNTER_PARTICIPANTS ** 2) {
      issues.push(issue('context.candidateRanges', 'RANGE_LIMIT', 'Candidate range matrix is too large'));
    } else {
      const pairs = new Set<string>();
      request.context.candidateRanges.forEach((range, index) => {
        issues.push(...unknownFieldIssues(range as unknown as Record<string, unknown>, new Set([
          'fromActorRef', 'toActorRef', 'rangeBand',
        ]), `context.candidateRanges.${index}`));
        const key = `${range.fromActorRef}\u0000${range.toActorRef}`;
        if (pairs.has(key)) issues.push(issue(`context.candidateRanges.${index}`, 'DUPLICATE_RANGE', 'Candidate range pairs must be unique'));
        pairs.add(key);
        if (!refs.has(range.fromActorRef) || !refs.has(range.toActorRef)) issues.push(issue(`context.candidateRanges.${index}`, 'UNKNOWN_TARGET_REF', 'Candidate range must use closed candidate refs'));
        if (!(zones as readonly string[]).includes(range.rangeBand)) issues.push(issue(`context.candidateRanges.${index}.rangeBand`, 'ENUM', 'Candidate range band is invalid'));
      });
    }
  }
  return issues.length > 0 ? failure(issues) : success(candidates);
}

function multiplierAt(targeting: CoreV1Targeting, ordinal: number): number {
  if (targeting.type === 'self' || targeting.type === 'single_target' || targeting.type === 'weapon_attack') return 10_000;
  return targeting.damageMultiplierPerTargetBps?.[ordinal] ?? 0;
}

export function resolveCoreV1EncounterTargets(
  request: CoreV1EncounterTargetRequest,
): CoreV1EncounterResult<readonly CoreV1ResolvedEncounterTarget[]> {
  const encounter = validateCoreV1EncounterState(request.encounter);
  if (!encounter.ok) return encounter;
  if (!targetSelectors.has(request.selector)) {
    return failure([issue('selector', 'ENUM', 'Target selector is not supported')]);
  }
  if (!isArrayValue(request.requestedTargetRefs)
    || !isArrayValue(request.allowedRelations)
    || request.allowedRelations.some((relation) => !relations.has(relation))) {
    return failure([issue('targeting', 'TARGET_POLICY', 'Target refs and allowed relations must use closed arrays')]);
  }
  const requestedMaximum = request.targeting.maxTargets ?? 1;
  if (!Number.isSafeInteger(requestedMaximum) || requestedMaximum < 1
    || requestedMaximum > CORE_V1_MAX_ENCOUNTER_TARGETS) {
    return failure([issue('targeting.maxTargets', 'TARGET_LIMIT', 'Targeting supports between one and sixteen targets')]);
  }
  if (new Set(request.requestedTargetRefs).size !== request.requestedTargetRefs.length) {
    return failure([issue('requestedTargetRefs', 'DUPLICATE_TARGET_REF', 'Requested target refs must be unique')]);
  }
  if (request.requestedTargetRefs.length > requestedMaximum) {
    return failure([issue('requestedTargetRefs', 'TARGET_LIMIT', 'Requested target refs exceed the targeting profile limit')]);
  }
  const source = encounter.value.participants.find((participant) => participant.actorRef === request.sourceActorRef);
  if (source === undefined) return failure([issue('sourceActorRef', 'UNKNOWN_ACTOR_REF', 'Source must belong to the encounter')]);
  const validated = validateTargetingContext({ ...request, encounter: encounter.value });
  if (!validated.ok) return validated;
  const eligible = validated.value.filter((candidate) => {
    const participant = encounter.value.participants.find((entry) => entry.actorRef === candidate.actorRef);
    return participant !== undefined && participant.combatState !== 'removed'
      && participant.combatState !== 'incapacitated_candidate'
      && candidate.targetable && candidate.active && candidate.hpCurrent > 0
      && request.allowedRelations.includes(candidate.relation)
      && rangeAllows(request.targeting.rangeBand, candidate.rangeBand);
  });
  let selected: CoreV1EncounterTargetCandidate[] = [];
  const maximum = Math.min(request.targeting.maxTargets ?? 1, CORE_V1_MAX_ENCOUNTER_TARGETS);
  if (request.targeting.type === 'self' || request.selector === 'self') {
    const self = validated.value.find((candidate) => candidate.actorRef === source.actorRef);
    if (self !== undefined) selected = [self];
  } else if (request.selector === 'explicit') {
    selected = request.requestedTargetRefs.map((ref) => eligible.find((candidate) => candidate.actorRef === ref))
      .filter((candidate): candidate is CoreV1EncounterTargetCandidate => candidate !== undefined);
    if (selected.length !== request.requestedTargetRefs.length) return failure([issue('requestedTargetRefs', 'NO_VALID_TARGET', 'One or more explicit targets are not valid')]);
  } else if (request.selector === 'lowest_hp_hostile') {
    selected = eligible.filter((candidate) => candidate.relation === 'hostile').sort(ratioOrder).slice(0, maximum);
  } else {
    const relation: CoreV1EncounterRelation = request.selector === 'nearest_hostile' ? 'hostile' : 'ally';
    selected = eligible.filter((candidate) => candidate.relation === relation).sort(candidateOrder).slice(0, maximum);
  }

  if (request.targeting.type === 'area' || request.targeting.type === 'cleave') {
    const spatialCandidateRefs = request.context.spatialCandidateRefs;
    if (spatialCandidateRefs === undefined || !isArrayValue(spatialCandidateRefs)) {
      return failure([issue('context.spatialCandidateRefs', 'REQUIRES_SPATIAL_ADAPTER', 'Area and cleave require pre-resolved spatial candidates')]);
    }
    if (spatialCandidateRefs.length > CORE_V1_MAX_ENCOUNTER_PARTICIPANTS
      || new Set(spatialCandidateRefs).size !== spatialCandidateRefs.length
      || spatialCandidateRefs.some((ref) => !validated.value.some((candidate) => candidate.actorRef === ref))) {
      return failure([issue('context.spatialCandidateRefs', 'SPATIAL_CANDIDATES', 'Spatial candidates must be unique closed participant refs')]);
    }
    const spatial = new Set(spatialCandidateRefs);
    if (request.targeting.type === 'area') selected = eligible.filter((candidate) => spatial.has(candidate.actorRef)).sort(candidateOrder).slice(0, maximum);
    else {
      const primary = selected[0];
      const extras = eligible.filter((candidate) => spatial.has(candidate.actorRef)
        && candidate.actorRef !== primary?.actorRef).sort(candidateOrder);
      selected = primary === undefined ? [] : [primary, ...extras].slice(0, maximum);
    }
  }
  if (request.targeting.type === 'chain') {
    const first = selected[0];
    if (first === undefined) selected = [];
    else {
      const ranges = request.context.candidateRanges;
      if (ranges === undefined || !isArrayValue(ranges)) {
        return failure([issue('context.candidateRanges', 'REQUIRES_SPATIAL_ADAPTER', 'Chain requires a closed candidate range matrix')]);
      }
      const chain = [first];
      while (chain.length < Math.min(request.targeting.chainCount ?? maximum, maximum)) {
        const previous = chain.at(-1);
        if (previous === undefined) break;
        const next = eligible.filter((candidate) => !chain.some((entry) => entry.actorRef === candidate.actorRef))
          .filter((candidate) => {
            const range = ranges.find((entry) => entry.fromActorRef === previous.actorRef
              && entry.toActorRef === candidate.actorRef);
            return range !== undefined && rangeAllows(request.targeting.rangeBand, range.rangeBand);
          }).sort(candidateOrder)[0];
        if (next === undefined) break;
        chain.push(next);
      }
      selected = chain;
    }
  }
  if (request.targeting.type === 'single_target' || request.targeting.type === 'weapon_attack') selected = selected.slice(0, 1);
  else selected = selected.slice(0, maximum);
  if (selected.length === 0) return failure([issue('targets', 'NO_VALID_TARGET', 'No valid target satisfies the encounter targeting policy')]);
  if ((request.targeting.type === 'single_target' || request.targeting.type === 'weapon_attack' || request.targeting.type === 'self')
    && selected.length !== 1) return failure([issue('targets', 'TARGET_COUNT', 'Targeting mode requires exactly one target')]);
  const result = selected.map((candidate, targetOrdinal): CoreV1ResolvedEncounterTarget => ({
    targetRef: candidate.actorRef,
    targetOrdinal,
    damageMultiplierBps: multiplierAt(request.targeting, targetOrdinal),
    effectTickOffset: request.targeting.type === 'chain'
      ? BigInt(request.targeting.chainInterval ?? 0) * BigInt(targetOrdinal)
      : 0n,
  }));
  if (result.some((target) => target.damageMultiplierBps < 1 || target.damageMultiplierBps > 10_000)) {
    return failure([issue('targets', 'TARGET_MULTIPLIER', 'Resolved target multiplier is invalid')]);
  }
  return success(result);
}

function nextEventSequence(encounter: CoreV1EncounterState): number {
  const maximum = encounter.scheduledEvents.reduce(
    (current, event) => Math.max(current, event.timelineEvent.sequence),
    0,
  );
  return safeIntegerAdd(maximum, 1, 'encounter event sequence');
}

function resolvedEffectCount(profile: CoreV1MechanicalContentProfile): number {
  return ((profile.damageComponents?.length ?? 0) > 0 && profile.targeting !== undefined ? 1 : 0)
    + (profile.effects?.length ?? 0);
}

function primaryTargeting(profile: CoreV1MechanicalContentProfile): CoreV1Targeting | null {
  if (profile.targeting !== undefined) return profile.targeting;
  for (const effect of profile.effects ?? []) {
    if ('targeting' in effect) return effect.targeting;
  }
  return null;
}

function assertDefinitionMatchesIntent(
  input: CoreV1CompileEncounterActionInput,
): CoreV1EncounterResult<void> {
  const { definition, intent } = input;
  const issues: ValidationIssue[] = [];
  if (isPlainRecord(intent)) {
    issues.push(...unknownFieldIssues(intent, new Set([
      'intentRef', 'sourceActorRef', 'slotRef', 'actionSource', 'targetSelector',
      'requestedTargetRefs', 'contentRef', 'weaponEntryRef', 'versatileMode', 'reactionPolicy',
    ]), 'intent'));
  }
  if (!isStableRef(intent.intentRef)) issues.push(issue('intent.intentRef', 'PUBLIC_REF', 'Intent ref must be stable and must not be a UUID'));
  if (!isStableRef(intent.sourceActorRef)) issues.push(issue('intent.sourceActorRef', 'PUBLIC_REF', 'Source actor ref is invalid'));
  if (!isStableRef(intent.slotRef)) issues.push(issue('intent.slotRef', 'PUBLIC_REF', 'Slot ref is invalid'));
  if (definition.actionSource !== intent.actionSource) issues.push(issue('definition.actionSource', 'ACTION_SOURCE_MATCH', 'Resolved definition must match the intent action source'));
  if (definition.contentRef !== undefined) {
    if (intent.contentRef === undefined
      || !contentRefMatches(definition.contentRef, intent.contentRef)) {
      issues.push(issue('intent.contentRef', 'CONTENT_VERSION_MATCH', 'Intent and authoritative definition must use the same content version'));
    }
  } else if (intent.contentRef !== undefined) issues.push(issue('intent.contentRef', 'UNEXPECTED_CONTENT_REF', 'This action source does not accept a content ref'));
  if (!isArrayValue(intent.requestedTargetRefs)
    || new Set(intent.requestedTargetRefs).size !== intent.requestedTargetRefs.length) {
    issues.push(issue('intent.requestedTargetRefs', 'UNIQUE_ARRAY', 'Requested target refs must be a unique array'));
  }
  if (!isArrayValue(definition.actionTags)) issues.push(issue('definition.actionTags', 'ARRAY', 'Action tags must be an array'));
  if (!isArrayValue(definition.allowedRelations) || definition.allowedRelations.some((entry) => !relations.has(entry))) {
    issues.push(issue('definition.allowedRelations', 'RELATION_POLICY', 'Allowed relations must use the closed relation catalog'));
  }
  if (definition.profile !== undefined) {
    const profile = validateCoreV1ContentProfile(definition.profile);
    if (!profile.ok) issues.push(...profile.issues.map((entry) => ({ ...entry, path: `definition.profile.${entry.path}` })));
    else if (profile.value.profileMode !== 'mechanical') issues.push(issue('definition.profile.profileMode', 'MECHANICAL_PROFILE', 'Encounter actions require a mechanical profile'));
    if (resolvedEffectCount(definition.profile) !== definition.effectRefs.length) {
      issues.push(issue('definition.effectRefs', 'EFFECT_REF_COUNT', 'Every resolved effect requires one deterministic ref', resolvedEffectCount(definition.profile), definition.effectRefs.length));
    }
  } else if (!['movement', 'wait'].includes(definition.actionSource)) {
    issues.push(issue('definition.profile', 'REQUIRED', 'Content, consumable and weapon actions require a canonical profile'));
  }
  return issues.length > 0 ? failure(issues) : success(undefined);
}

function temporalProfileFor(
  definition: CoreV1EncounterActionDefinition,
): CoreV1EncounterResult<{ readonly preparation: bigint; readonly recovery: bigint }> {
  try {
    if (definition.actionSource === 'movement') {
      if (definition.movement === undefined) return failure([issue('definition.movement', 'REQUIRED', 'Movement action requires a movement definition')]);
      if (definition.movement.kind === 'move_and_act' && definition.movement.combinedActionAllowed !== true) {
        return failure([issue('definition.movement.combinedActionAllowed', 'MOVEMENT_POLICY', 'move_and_act requires explicit authoritative permission')]);
      }
      const kind = definition.movement.kind === 'move_and_act' ? 'approach' : definition.movement.kind;
      const movement = calculateMovement(
        definition.movement.from,
        definition.movement.to,
        kind,
        definition.movement.terrain,
        { overloaded: definition.physicalSpeed?.carriedWeightUnits !== undefined
          && calculatePhysicalSpeed(definition.physicalSpeed).canStartAttackOrMovement === false },
      );
      return success({ preparation: movement.movementTime, recovery: 0n });
    }
    if (definition.actionSource === 'wait') return success({ preparation: 0n, recovery: 100n });
    const actionProfile = definition.profile?.actionProfile;
    if (actionProfile === undefined) return failure([issue('definition.profile.actionProfile', 'REQUIRED', 'Timed encounter action requires an action profile')]);
    if (['block', 'dodge', 'interrupt', 'counter_attack'].includes(actionProfile)) {
      return failure([issue('definition.profile.actionProfile', 'REACTION_ONLY', 'Reaction timing cannot be compiled as a primary action')]);
    }
    const base = ['quick', 'normal', 'heavy', 'very_heavy'].includes(actionProfile)
      ? getTemporalProfile(actionProfile as Parameters<typeof getTemporalProfile>[0])
      : getRepresentativeTemporalProfile(actionProfile as Parameters<typeof getRepresentativeTemporalProfile>[0]);
    if (definition.actionKind === 'magic') {
      if (definition.magicalSpeed === undefined) return failure([issue('definition.magicalSpeed', 'REQUIRED', 'Magic action requires authoritative speed inputs')]);
      const speed = calculateMagicalSpeed(definition.magicalSpeed);
      const profile = calculateMagicalActionTimes(base.preparation, base.recovery, speed.effectiveCastingSpeedBps, speed.recoverySpeedBps);
      const preparation = definition.casting?.canMoveWhileCasting === true
        ? calculateMobileCastTime(profile.preparation, true, definition.casting.mobileCastTimeMultiplierBps)
        : profile.preparation;
      return success({ preparation, recovery: profile.recovery });
    }
    if (definition.actionKind === 'hybrid') {
      if (definition.physicalSpeed === undefined || definition.magicalSpeed === undefined) {
        return failure([issue('definition', 'HYBRID_SPEED_REQUIRED', 'Hybrid action requires physical and magical speed inputs')]);
      }
      const physical = calculatePhysicalSpeed(definition.physicalSpeed);
      const magical = calculateMagicalSpeed(definition.magicalSpeed);
      if (!physical.canStartAttackOrMovement) return failure([issue('definition.physicalSpeed', 'OVERLOADED', 'Overloaded actor cannot start an attack')]);
      const speed = calculateHybridSpeedBps(physical.effectiveAttackSpeedBps, magical.effectiveCastingSpeedBps);
      const profile = calculatePhysicalActionTimes(base.preparation, base.recovery, speed);
      return success({ preparation: profile.preparation, recovery: profile.recovery });
    }
    if (definition.actionKind === 'physical') {
      if (definition.physicalSpeed === undefined) return failure([issue('definition.physicalSpeed', 'REQUIRED', 'Physical action requires authoritative speed inputs')]);
      const speed = calculatePhysicalSpeed(definition.physicalSpeed);
      if (!speed.canStartAttackOrMovement) return failure([issue('definition.physicalSpeed', 'OVERLOADED', 'Overloaded actor cannot start an attack')]);
      const profile = calculatePhysicalActionTimes(base.preparation, base.recovery, speed.effectiveAttackSpeedBps);
      return success({ preparation: profile.preparation, recovery: profile.recovery });
    }
    return success({ preparation: base.preparation, recovery: base.recovery });
  } catch (error) {
    return caughtFailure(error, 'definition');
  }
}

function defaultReactionPolicy(policy: CoreV1EncounterReactionPolicy | undefined): CoreV1EncounterReactionPolicy {
  return policy === undefined ? { mode: 'none', allowCounterAttack: false } : cloneValue(policy);
}

function contentRefMatches(
  left: CoreV1EncounterActionDefinition['contentRef'],
  right: CoreV1EncounterActionDefinition['contentRef'],
): boolean {
  return left !== undefined && right !== undefined
    && left.scope === right.scope && left.contentType === right.contentType
    && left.code === right.code && left.versionNumber === right.versionNumber;
}

function validateInventoryForAction(
  participant: CoreV1EncounterParticipant,
  input: CoreV1CompileEncounterActionInput,
): CoreV1EncounterResult<void> {
  if (input.intent.actionSource !== 'consumable' && input.intent.actionSource !== 'basic_weapon_attack') return success(undefined);
  const entryRef = input.intent.weaponEntryRef;
  if (!isStableRef(entryRef)) return failure([issue('intent.weaponEntryRef', 'ENTRY_REF_REQUIRED', 'Physical action requires a stable inventory entry ref')]);
  const entry = participant.equipmentContext.inventory.entries.find((candidate) => candidate.entryRef === entryRef);
  if (entry === undefined) return failure([issue('intent.weaponEntryRef', 'ENTRY_NOT_FOUND', 'Inventory entry was not found')]);
  if (!contentRefMatches(input.definition.contentRef, entry.contentVersion as CoreV1EncounterActionDefinition['contentRef'])) {
    return failure([issue('definition.contentRef', 'CONTENT_VERSION_MATCH', 'Inventory entry and action definition must use the same exact content version')]);
  }
  if (input.intent.actionSource === 'basic_weapon_attack') {
    if (entry.entryKind !== 'instance' || entry.state !== 'equipped') return failure([issue('intent.weaponEntryRef', 'EQUIPPED_WEAPON_REQUIRED', 'Basic weapon attack requires an equipped weapon instance')]);
  } else if (entry.entryKind === 'instance' && entry.state !== 'available') {
    return failure([issue('intent.weaponEntryRef', 'AVAILABLE_CONSUMABLE_REQUIRED', 'Consumable instance must be available')]);
  }
  return success(undefined);
}

function actionTargeting(
  input: CoreV1CompileEncounterActionInput,
): CoreV1Targeting {
  if (input.definition.actionSource === 'movement' || input.definition.actionSource === 'wait') {
    return { type: 'self', rangeBand: 'self' };
  }
  const targeting = input.definition.profile === undefined ? null : primaryTargeting(input.definition.profile);
  if (targeting === null) throw new RangeError('Action profile does not declare targeting');
  return targeting;
}

export function compileCoreV1EncounterAction(
  input: CoreV1CompileEncounterActionInput,
): CoreV1EncounterResult<CoreV1CompiledEncounterAction> {
  const encounter = validateCoreV1EncounterState(input.encounter);
  if (!encounter.ok) return encounter;
  if (encounter.value.status !== 'active') return failure([issue('encounter.status', 'ENCOUNTER_NOT_ACTIVE', 'Only an active encounter accepts action intents')]);
  const matching = assertDefinitionMatchesIntent({ ...input, encounter: encounter.value });
  if (!matching.ok) return matching;
  const source = encounter.value.participants.find((participant) => participant.actorRef === input.intent.sourceActorRef);
  if (source === undefined) return failure([issue('intent.sourceActorRef', 'UNKNOWN_ACTOR_REF', 'Source actor must belong to the encounter')]);
  if (source.combatState !== 'ready') return failure([issue('source.combatState', 'ACTOR_NOT_READY', 'Source actor is not ready to start an action')]);
  const slot = source.actionSlots.find((candidate) => candidate.slotRef === input.intent.slotRef);
  if (slot === undefined) return failure([issue('intent.slotRef', 'ACTION_SLOT_NOT_FOUND', 'Action slot was not found')]);
  if (slot.nextActionAtTick > encounter.value.currentTick) return failure([issue('intent.slotRef', 'ACTION_SLOT_NOT_READY', 'Action slot is not ready at the current tick')]);
  if (!canScheduleInActionSlot(slot, input.definition.actionTags, input.definition.fullPrimaryAction)) {
    return failure([issue('intent.slotRef', 'ACTION_SLOT_RESTRICTION', 'Action is not allowed in the selected slot')]);
  }
  const inventory = validateInventoryForAction(source, input);
  if (!inventory.ok) return inventory;
  const temporal = temporalProfileFor(input.definition);
  if (!temporal.ok) return temporal;
  let targeting: CoreV1Targeting;
  try { targeting = actionTargeting(input); } catch (error) { return caughtFailure(error, 'definition.profile.targeting'); }
  const targets = resolveCoreV1EncounterTargets({
    encounter: encounter.value,
    sourceActorRef: source.actorRef,
    targeting,
    selector: input.intent.targetSelector,
    requestedTargetRefs: input.intent.requestedTargetRefs,
    allowedRelations: targeting.type === 'self' ? ['self'] : input.definition.allowedRelations,
    context: input.targetingContext,
  });
  if (!targets.ok) return targets;
  const profile = input.definition.profile;
  let cost: CoreV1EncounterResult<CoreV1CostResolution>;
  let movementSpCost = 0;
  if (profile === undefined && input.definition.actionSource === 'movement'
    && input.definition.movement !== undefined) {
    const movementKind = input.definition.movement.kind === 'move_and_act'
      ? 'approach' : input.definition.movement.kind;
    try {
      movementSpCost = calculateMovement(
        input.definition.movement.from,
        input.definition.movement.to,
        movementKind,
        input.definition.movement.terrain,
        { overloaded: input.definition.physicalSpeed !== undefined
          && calculatePhysicalSpeed(input.definition.physicalSpeed).canStartAttackOrMovement === false },
      ).conceptualSpCost;
    } catch (error) {
      return caughtFailure(error, 'definition.movement');
    }
    cost = success({
      cost: { type: 'none' },
      amounts: [],
      resourceDeltas: [],
      affordable: source.resources.sp.current >= movementSpCost,
    });
  } else if (profile === undefined) {
    cost = success({ cost: { type: 'none' }, amounts: [], resourceDeltas: [], affordable: true });
  } else {
    const resolvedCost = resolveCoreV1Cost({
      tier: profile.tier,
      cost: profile.cost,
      resources: source.resources,
      ...(input.definition.costModifiers === undefined ? {} : { modifiers: input.definition.costModifiers }),
    });
    cost = resolvedCost.ok ? success(resolvedCost.value) : failure(resolvedCost.issues);
  }
  if (!cost.ok) return failure(cost.issues);
  if (!cost.value.affordable) return failure([issue('source.resources', 'INSUFFICIENT_RESOURCE', 'Source cannot afford the action cost')]);
  try {
    const actionRef = `${encounter.value.encounterRef}-action-${encounter.value.actionSequence}`;
    const startTick = encounter.value.currentTick;
    const effectTick = addTicks(startTick, temporal.value.preparation, 'action effect tick');
    let sequence = nextEventSequence(encounter.value);
    const events: CoreV1EncounterEvent[] = [];
    events.push(eventFor(source, `${actionRef}-started`, sequence++, 'action_started', startTick, { actionRef }));
    let lastEffectTick = effectTick;
    const combo = input.definition.combo;
    if (combo !== undefined) {
      const validatedCombo = validateMultiTargetAction(combo);
      if (validatedCombo.comboSteps.length > CORE_V1_MAX_COMBO_STEPS
        || validatedCombo.maxComboEvents > Math.min(CORE_V1_MAX_COMBO_EVENTS, CORE_V1_MAX_ENCOUNTER_COMBO_EVENTS)) {
        return failure([issue('definition.combo', 'COMBO_LIMIT', 'Combo exceeds core-v1 operational limits')]);
      }
      const target = targets.value[0];
      if (target === undefined) return failure([issue('targets', 'NO_VALID_TARGET', 'Combo requires one valid target')]);
      for (const [index, step] of validatedCombo.comboSteps.entries()) {
        const tick = addTicks(effectTick, step.offset, 'combo effect tick');
        lastEffectTick = tick > lastEffectTick ? tick : lastEffectTick;
        events.push(eventFor(source, `${actionRef}-combo-${index + 1}`, sequence++, 'action_effect', tick, {
          actionRef, targetRef: target.targetRef, targetOrdinal: target.targetOrdinal, comboStepRef: step.stepRef,
        }));
      }
    } else {
      for (const target of targets.value) {
        const tick = addTicks(effectTick, target.effectTickOffset, 'target effect tick');
        lastEffectTick = tick > lastEffectTick ? tick : lastEffectTick;
        const eventType: CoreV1EncounterEventType = input.definition.actionSource === 'movement'
          ? 'movement_effect' : 'action_effect';
        events.push(eventFor(source, `${actionRef}-effect-${target.targetOrdinal + 1}`, sequence++, eventType, tick, {
          actionRef, targetRef: target.targetRef, targetOrdinal: target.targetOrdinal,
        }));
      }
    }
    let castingState;
    if (input.definition.casting !== undefined) {
      if (input.definition.casting.reservedMana > source.resources.mana.current) {
        return failure([issue('definition.casting.reservedMana', 'INSUFFICIENT_RESOURCE', 'Casting reservation exceeds current Mana')]);
      }
      const casting = startCasting({
        startTick,
        castTime: temporal.value.preparation,
        reservedMana: input.definition.casting.reservedMana,
        ...(input.definition.casting.preparedUntilTick === undefined
          ? {} : { preparedUntilTick: input.definition.casting.preparedUntilTick }),
        ...(input.definition.casting.channelInterval === undefined
          ? {} : { channelInterval: input.definition.casting.channelInterval }),
      });
      castingState = casting.state;
      const hasInterval = input.definition.casting.channelInterval !== undefined
        && input.definition.casting.channelInterval !== null;
      const hasEnd = input.definition.casting.channelEndTick !== undefined
        && input.definition.casting.channelEndTick !== null;
      if (hasInterval !== hasEnd) return failure([issue('definition.casting', 'REQUIRES_UPKEEP_POLICY', 'Channel requires both interval and end tick')]);
      if (hasInterval && hasEnd && casting.state.channelNextPulseTick !== null) {
        const pulses = scheduleChannelPulseEvents(
          casting.state.channelNextPulseTick,
          input.definition.casting.channelEndTick,
          input.definition.casting.channelInterval,
          {
            eventIdPrefix: `${actionRef}-channel`, firstSequence: sequence,
            actorRef: source.actorRef, actionRef, initiativeScore: source.initiative.score,
            agility: source.primaryAttributes.agility, perception: source.primaryAttributes.perception,
            luck: source.primaryAttributes.luck, rngTieBreak: source.initiative.tieBreak,
            stableRef: source.actorRef, reactionDepth: 0,
          },
        );
        for (const pulse of pulses) {
          const pulseTarget = targets.value[0];
          const sequencedPulse = { ...pulse, sequence: sequence++ };
          events.push({
            eventRef: sequencedPulse.eventId,
            type: 'channel_pulse',
            timelineEvent: sequencedPulse,
            actionRef,
            ...(pulseTarget === undefined ? {} : {
              targetRef: pulseTarget.targetRef,
              targetOrdinal: pulseTarget.targetOrdinal,
            }),
          });
          lastEffectTick = sequencedPulse.tick > lastEffectTick ? sequencedPulse.tick : lastEffectTick;
          if (cost.value.maintenancePlan !== undefined) {
            events.push(eventFor(source, `${sequencedPulse.eventId}-upkeep`, sequence++, 'upkeep_due', sequencedPulse.tick, { actionRef }));
          }
        }
      }
    }
    const reactionPolicy = defaultReactionPolicy(input.intent.reactionPolicy);
    if (reactionPolicy.mode !== 'none') {
      const defender = targets.value.map((target) => encounter.value.participants.find((participant) => participant.actorRef === target.targetRef))
        .find((participant) => participant !== undefined);
      const capability = defender?.reactionCapabilities.find((candidate) => (
        candidate.kind !== 'counter_attack'
          && (reactionPolicy.preferredReaction === undefined || candidate.kind === reactionPolicy.preferredReaction)
      ));
      if (defender !== undefined && capability !== undefined) {
        const cooldownRef = `reaction-${capability.kind}`;
        const cooling = encounter.value.cooldowns.some((entry) => entry.actorRef === defender.actorRef
          && entry.cooldownRef === cooldownRef && entry.readyAtTick > startTick);
        if (cooling && reactionPolicy.mode === 'require') return failure([issue('intent.reactionPolicy', 'ACTION_ON_COOLDOWN', 'Required reaction is on cooldown')]);
        if (!cooling) {
          const reactionCost = resolveCoreV1Cost({
            tier: capability.tier,
            cost: capability.cost,
            resources: defender.resources,
          });
          if (!reactionCost.ok || !reactionCost.value.affordable) {
            if (reactionPolicy.mode === 'require') {
              return failure([issue('intent.reactionPolicy', 'INSUFFICIENT_RESOURCE', 'Required reaction cost cannot be reserved')]);
            }
          } else {
          let resolved;
          try {
            resolved = resolveReaction({
              kind: capability.kind,
              originActionRef: actionRef,
              sourceEventIsReaction: false,
              currentDepth: 0,
              startTick,
              originEffectTick: effectTick,
              defensiveReactionAlreadyUsed: false,
              counterAttackAlreadyUsed: false,
              surprised: defender.initiative.surprised,
              actorFirstReadyTick: defender.initiative.firstReadyTick,
            });
          } catch {
            if (reactionPolicy.mode === 'require') return failure([issue('intent.reactionPolicy', 'REACTION_WINDOW_CLOSED', 'Required reaction cannot complete before the effect tick')]);
          }
          if (resolved !== undefined) {
            events.push(eventFor(defender, `${actionRef}-reaction-started`, sequence++, 'reaction_started', startTick, {
              actionRef, targetRef: defender.actorRef, reactionKind: capability.kind,
            }));
            events.push(eventFor(defender, `${actionRef}-reaction-resolved`, sequence++, 'reaction_resolved', resolved.completionTick, {
              actionRef, targetRef: defender.actorRef, reactionKind: capability.kind,
            }));
          }
          }
        }
      } else if (reactionPolicy.mode === 'require') {
        return failure([issue('intent.reactionPolicy', 'REACTION_OUTCOME_REQUIRED', 'No eligible authoritative reaction capability is available')]);
      }
    }
    const nextActionAtTick = addTicks(lastEffectTick, temporal.value.recovery, 'action ready tick');
    events.push(eventFor(source, `${actionRef}-ready`, sequence++, 'actor_ready', nextActionAtTick, { actionRef }));
    if (combo !== undefined && events.length > CORE_V1_MAX_ENCOUNTER_COMBO_EVENTS) {
      return failure([issue('internalEvents', 'COMBO_LIMIT', 'Combo exceeds eight internal encounter events')]);
    }
    if (events.length > CORE_V1_MAX_ENCOUNTER_EVENTS) return failure([issue('internalEvents', 'EVENT_LIMIT', 'Compiled action exceeds the event limit')]);
    const reservations = cost.value.amounts.map((amount) => ({
      resource: amount.resource === 'custom' ? amount.resourceRef?.code ?? 'custom' : amount.resource,
      amount: amount.adjusted,
    }));
    if (movementSpCost > 0) reservations.push({ resource: 'sp', amount: movementSpCost });
    const executionPlan = {
      ...(profile === undefined ? {} : { profile: cloneValue(profile) }),
      ...(input.definition.contentRef === undefined ? {} : { contentRef: cloneValue(input.definition.contentRef) }),
      effectRefs: [...input.definition.effectRefs],
      statusDefinitions: cloneValue(input.definition.statusDefinitions ?? []),
      runtimeDurations: cloneValue(input.definition.runtimeDurations ?? []),
      weaponDamageComponents: cloneValue(input.definition.weaponDamageComponents ?? []),
      ...(input.definition.costModifiers === undefined ? {} : { costModifiers: cloneValue(input.definition.costModifiers) }),
      defenses: cloneValue(input.definition.defenses ?? {}),
      ...(input.definition.movement === undefined ? {} : { movement: cloneValue(input.definition.movement) }),
      ...(castingState === undefined ? {} : { castingState }),
      reactionPolicy,
      comboStopOnMiss: input.definition.combo?.stopOnMiss ?? false,
      ...(input.intent.actionSource === 'consumable' && input.intent.weaponEntryRef !== undefined
        ? { consumedEntryRef: input.intent.weaponEntryRef } : {}),
    };
    return success({
      actionRef,
      intentRef: input.intent.intentRef,
      sourceActorRef: source.actorRef,
      slotRef: slot.slotRef,
      actionKind: input.definition.actionKind,
      ...(input.definition.contentRef === undefined ? {} : { contentRef: input.definition.contentRef }),
      startTick,
      effectTick,
      nextActionAtTick,
      preparationTicks: temporal.value.preparation,
      recoveryTicks: temporal.value.recovery,
      targets: targets.value,
      reactionDepth: 0,
      interruptible: input.definition.interruptible,
      blockable: input.definition.blockable,
      dodgeable: input.definition.dodgeable,
      canRetargetBeforeEffect: input.definition.canRetargetBeforeEffect,
      resourceReservationPlan: { cost: cost.value.cost, affordable: cost.value.affordable, reservations },
      cooldownPlan: [],
      upkeepPlan: cost.value.maintenancePlan === undefined ? [] : [{
        resource: cost.value.maintenancePlan.upkeepResource,
        amount: cost.value.maintenancePlan.upkeepCost,
      }],
      internalEvents: sortedEncounterEvents(events, encounter.value.currentTick),
      executionPlan,
      state: 'scheduled',
      costApplied: false,
      selfEffectsApplied: false,
      dodgedTargetRefs: [],
    });
  } catch (error) {
    return caughtFailure(error, 'action');
  }
}

function replaceParticipant(
  encounter: CoreV1EncounterState,
  actorRef: string,
  update: (participant: CoreV1EncounterParticipant) => CoreV1EncounterParticipant,
): CoreV1EncounterState {
  return {
    ...encounter,
    participants: encounter.participants.map((participant) => participant.actorRef === actorRef
      ? update(cloneValue(participant))
      : cloneValue(participant)),
  };
}

export function scheduleCoreV1EncounterAction(
  encounterInput: CoreV1EncounterState,
  actionInput: CoreV1CompiledEncounterAction,
): CoreV1EncounterResult<CoreV1EncounterState> {
  const encounter = validateCoreV1EncounterState(encounterInput);
  if (!encounter.ok) return encounter;
  const action = cloneValue(actionInput);
  if (action.startTick !== encounter.value.currentTick) return failure([issue('action.startTick', 'STALE_ENCOUNTER_STATE', 'Compiled action start tick is stale')]);
  if (action.actionRef !== `${encounter.value.encounterRef}-action-${encounter.value.actionSequence}`) {
    return failure([issue('action.actionRef', 'ACTION_SEQUENCE', 'Compiled action does not match the next encounter sequence')]);
  }
  if (encounter.value.activeActions.some((candidate) => candidate.actionRef === action.actionRef)) {
    return failure([issue('action.actionRef', 'DUPLICATE_ACTION_REF', 'Action ref is already active')]);
  }
  if (encounter.value.scheduledEvents.length + action.internalEvents.length > CORE_V1_MAX_ENCOUNTER_EVENTS) {
    return failure([issue('scheduledEvents', 'EVENT_LIMIT', 'Scheduling the action would exceed 256 events')]);
  }
  const source = encounter.value.participants.find((participant) => participant.actorRef === action.sourceActorRef);
  if (source === undefined || source.combatState !== 'ready') return failure([issue('action.sourceActorRef', 'ACTOR_NOT_READY', 'Action source is no longer ready')]);
  const slot = source.actionSlots.find((candidate) => candidate.slotRef === action.slotRef);
  if (slot === undefined || slot.nextActionAtTick > encounter.value.currentTick) return failure([issue('action.slotRef', 'ACTION_SLOT_NOT_READY', 'Action slot is no longer ready')]);
  try {
    let next: CoreV1EncounterState = {
      ...encounter.value,
      stateVersion: safeIntegerAdd(encounter.value.stateVersion, 1, 'encounter state version'),
      actionSequence: safeIntegerAdd(encounter.value.actionSequence, 1, 'encounter action sequence'),
      scheduledEvents: sortedEncounterEvents([
        ...encounter.value.scheduledEvents,
        ...action.internalEvents,
      ], encounter.value.currentTick),
      activeActions: [...encounter.value.activeActions, action]
        .sort((left, right) => left.actionRef.localeCompare(right.actionRef)),
    };
    next = replaceParticipant(next, source.actorRef, (participant) => ({
      ...participant,
      combatState: action.actionKind === 'magic' ? 'casting'
        : action.actionKind === 'movement' ? 'moving' : 'preparing',
      actionSlots: participant.actionSlots.map((candidate) => candidate.slotRef === action.slotRef
        ? {
          ...candidate,
          nextActionAtTick: action.nextActionAtTick,
          lastActionAtTick: action.startTick,
          stateVersion: safeIntegerAdd(candidate.stateVersion, 1, 'action slot state version'),
        }
        : candidate),
    }));
    return validateCoreV1EncounterState(next);
  } catch (error) {
    return caughtFailure(error, 'action');
  }
}

function emptyBatch(encounter: CoreV1EncounterState): CoreV1EncounterBatchResult {
  return {
    encounterBefore: cloneValue(encounter),
    encounterAfter: cloneValue(encounter),
    processedEvents: [],
    resolvedActions: [],
    effectResolutions: [],
    reactionResolutions: [],
    movementChanges: [],
    cooldownChanges: [],
    invalidatedEvents: [],
    readyActors: [],
    stopReason: null,
    continuationRequired: false,
  };
}

function updateAction(
  encounter: CoreV1EncounterState,
  actionRef: string,
  update: (action: CoreV1CompiledEncounterAction) => CoreV1CompiledEncounterAction,
): CoreV1EncounterState {
  return {
    ...encounter,
    activeActions: encounter.activeActions.map((action) => action.actionRef === actionRef
      ? update(cloneValue(action)) : cloneValue(action)),
  };
}

function applyActorProjection(
  participant: CoreV1EncounterParticipant,
  actor: CoreV1ActorEffectContext,
): CoreV1EncounterParticipant {
  const becameCandidate = actor.resources.hp.current === 0;
  return {
    ...participant,
    resources: cloneValue(actor.resources),
    activeEffects: cloneValue(actor.activeEffects),
    effectsStateVersion: safeIntegerAdd(participant.effectsStateVersion, 1, 'effects state version'),
    combatState: becameCandidate ? 'incapacitated_candidate' : participant.combatState,
  };
}

interface AdjustedExecution {
  readonly profile: CoreV1MechanicalContentProfile;
  readonly effectRefs: readonly string[];
  readonly statusDefinitions: readonly CoreV1StatusDefinitionBinding[];
  readonly runtimeDurations: readonly CoreV1RuntimeDurationBinding[];
}

function adjustedExecution(
  action: CoreV1CompiledEncounterAction,
): CoreV1EncounterResult<AdjustedExecution> {
  const profile = action.executionPlan.profile;
  if (profile === undefined) return failure([issue('action.executionPlan.profile', 'REQUIRED', 'Effect action has no canonical profile')]);
  type MutableProfile = Omit<CoreV1MechanicalContentProfile, 'cost' | 'effects' | 'damageComponents'> & {
    cost: CoreV1MechanicalContentProfile['cost'];
    effects?: CoreV1Effect[];
    damageComponents?: CoreV1MechanicalContentProfile['damageComponents'];
  };
  const adjusted = cloneValue(profile) as MutableProfile;
  if (action.costApplied) adjusted.cost = { type: 'none' };
  const entries: {
    readonly oldIndex: number;
    readonly ref: string;
    readonly effect: CoreV1Effect;
    readonly root: boolean;
  }[] = [];
  let oldIndex = 0;
  if ((profile.damageComponents?.length ?? 0) > 0 && profile.targeting !== undefined) {
    entries.push({
      oldIndex,
      ref: action.executionPlan.effectRefs[oldIndex] ?? '',
      effect: { type: 'damage', damageComponents: profile.damageComponents ?? [], targeting: profile.targeting },
      root: true,
    });
    oldIndex += 1;
  }
  for (const effect of profile.effects ?? []) {
    entries.push({ oldIndex, ref: action.executionPlan.effectRefs[oldIndex] ?? '', effect, root: false });
    oldIndex += 1;
  }
  const included = entries.filter((entry) => action.selfEffectsApplied === false
    || !('targeting' in entry.effect && entry.effect.targeting.type === 'self'));
  const root = included.find((entry) => entry.root);
  if (root === undefined) delete adjusted.damageComponents;
  const effects = included.filter((entry) => !entry.root).map((entry) => entry.effect);
  if (effects.length === 0) delete adjusted.effects;
  else adjusted.effects = effects;
  const indexMap = new Map(included.map((entry, index) => [entry.oldIndex, index]));
  const statusDefinitions = action.executionPlan.statusDefinitions.flatMap((binding) => {
    const nextIndex = indexMap.get(binding.effectIndex);
    return nextIndex === undefined ? [] : [{ ...binding, effectIndex: nextIndex }];
  });
  const runtimeDurations = action.executionPlan.runtimeDurations.flatMap((binding) => {
    const nextIndex = indexMap.get(binding.effectIndex);
    return nextIndex === undefined ? [] : [{ ...binding, effectIndex: nextIndex }];
  });
  return success({
    profile: adjusted as CoreV1MechanicalContentProfile,
    effectRefs: included.map((entry) => entry.ref),
    statusDefinitions,
    runtimeDurations,
  });
}

function isParticipantActionable(participant: CoreV1EncounterParticipant | undefined): boolean {
  return participant !== undefined
    && participant.combatState !== 'removed'
    && participant.combatState !== 'incapacitated_candidate'
    && participant.resources.hp.current > 0;
}

function rollsFor(
  runtime: CoreV1EncounterRuntime,
  encounter: CoreV1EncounterState,
  action: CoreV1CompiledEncounterAction,
  targetRef: string,
  targetOrdinal: number,
): CoreV1InjectedRolls {
  const injected = runtime.rolls.effectRolls({
    encounterRef: encounter.encounterRef,
    actionRef: action.actionRef,
    sourceActorRef: action.sourceActorRef,
    targetActorRef: targetRef,
    targetOrdinal,
  });
  return action.dodgedTargetRefs.includes(targetRef) ? { ...injected, hitRollBps: 10_000 } : injected;
}

function applyResourceDeltasToParticipant(
  participant: CoreV1EncounterParticipant,
  deltas: readonly { readonly resource: string; readonly after: number; readonly resourceRef?: { readonly code: string } }[],
): CoreV1EncounterParticipant {
  let resources = cloneValue(participant.resources);
  for (const delta of deltas) {
    if (delta.resource === 'hp' || delta.resource === 'mana' || delta.resource === 'sp') {
      resources = { ...resources, [delta.resource]: { ...resources[delta.resource], current: delta.after } };
    } else if (delta.resource === 'custom' && delta.resourceRef !== undefined) {
      const customResources = resources.customResources;
      if (customResources !== undefined) {
        resources = {
          ...resources,
          customResources: customResources.map((entry) => entry.resourceRef.code === delta.resourceRef?.code
            ? { ...entry, pool: { ...entry.pool, current: delta.after } } : entry),
        };
      }
    }
  }
  return { ...participant, resources };
}

function processEffectEvent(
  encounter: CoreV1EncounterState,
  event: CoreV1EncounterEvent,
  runtime: CoreV1EncounterRuntime,
): CoreV1EncounterResult<{
  readonly encounter: CoreV1EncounterState;
  readonly resolution: CoreV1EffectSequenceResult;
  readonly resolvedAction: boolean;
  readonly invalidated: readonly CoreV1EncounterEvent[];
}> {
  const action = encounter.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
  const targetInfo = action?.targets.find((target) => target.targetRef === event.targetRef
    && target.targetOrdinal === event.targetOrdinal);
  const source = encounter.participants.find((participant) => participant.actorRef === action?.sourceActorRef);
  const target = encounter.participants.find((participant) => participant.actorRef === event.targetRef);
  if (action === undefined || targetInfo === undefined || source === undefined || target === undefined) {
    return failure([issue('event', 'NO_VALID_TARGET', 'Action effect is no longer structurally valid')]);
  }
  if (!isParticipantActionable(source) || !isParticipantActionable(target)) return failure([issue('event', 'NO_VALID_TARGET', 'Action source or target is no longer active')]);
  const adjusted = adjustedExecution(action);
  if (!adjusted.ok) return adjusted;
  const rolls = rollsFor(runtime, encounter, action, target.actorRef, targetInfo.targetOrdinal);
  const defense = action.executionPlan.defenses[target.actorRef] ?? { blockValue: 0, completeBlock: false };
  const sourceActor = participantActor(source);
  const sequenceInput: CoreV1EffectSequenceInput = {
    profile: adjusted.value.profile,
    sourceContent: action.executionPlan.contentRef ?? {
      scope: 'campaign', contentType: 'skill', code: 'basic-action', versionNumber: 1,
    },
    sourceActor,
    targetActor: source.actorRef === target.actorRef ? sourceActor : participantActor(target),
    currentTick: encounter.currentTick,
    effectRefs: adjusted.value.effectRefs,
    statusDefinitions: adjusted.value.statusDefinitions,
    runtimeDurations: adjusted.value.runtimeDurations,
    rolls,
    targeting: targetInfo,
    defense,
    ...(action.executionPlan.weaponDamageComponents.length === 0
      ? {} : { weaponDamageComponents: action.executionPlan.weaponDamageComponents }),
    ...(action.executionPlan.costModifiers === undefined
      ? {} : { costModifiers: action.executionPlan.costModifiers }),
  };
  let resolution: CoreV1EffectSequenceResult;
  let next = encounter;
  if (action.executionPlan.consumedEntryRef !== undefined) {
    if (action.costApplied) return failure([issue('action', 'CONSUMABLE_ALREADY_USED', 'Consumable action can execute only once')]);
    const used = resolveCoreV1ConsumableUse({
      ...sequenceInput,
      inventory: source.equipmentContext.inventory,
      entryRef: action.executionPlan.consumedEntryRef,
      contentVersionRef: action.executionPlan.contentRef as unknown as CoreV1ContentVersionReference,
      profile: adjusted.value.profile,
    });
    if (!used.ok) return failure(used.issues);
    resolution = used.value.sequence;
    next = replaceParticipant(next, source.actorRef, (participant) => ({
      ...participant,
      equipmentContext: { ...participant.equipmentContext, inventory: used.value.inventoryAfter },
      inventoryStateVersion: safeIntegerAdd(participant.inventoryStateVersion, 1, 'inventory state version'),
    }));
  } else {
    const resolved = resolveCoreV1EffectSequence(sequenceInput);
    if (!resolved.ok) return failure(resolved.issues);
    resolution = resolved.value;
  }
  next = replaceParticipant(next, source.actorRef, (participant) => applyActorProjection(participant, resolution.sourceAfter));
  if (target.actorRef !== source.actorRef) {
    next = replaceParticipant(next, target.actorRef, (participant) => applyActorProjection(participant, resolution.targetAfter));
  }
  next = updateAction(next, action.actionRef, (current) => {
    const castingState = current.executionPlan.castingState;
    const completedCasting = castingState?.phase === 'casting'
      && encounter.currentTick >= castingState.completionTick
      ? completeCasting(castingState).state
      : castingState;
    return {
      ...current,
      costApplied: true,
      selfEffectsApplied: true,
      executionPlan: {
        ...current.executionPlan,
        ...(completedCasting === undefined ? {} : { castingState: completedCasting }),
      },
    };
  });
  const invalidated: CoreV1EncounterEvent[] = [];
  if (event.comboStepRef !== undefined && action.executionPlan.profile !== undefined
    && inputComboStopOnMiss(action) && resolution.damageResults.some((damage) => !damage.hit)) {
    const later = next.scheduledEvents.filter((candidate) => candidate.actionRef === action.actionRef
      && candidate.type === 'action_effect' && candidate.timelineEvent.tick >= encounter.currentTick);
    invalidated.push(...later);
    next = { ...next, scheduledEvents: next.scheduledEvents.filter((candidate) => !later.some((entry) => entry.eventRef === candidate.eventRef)) };
  }
  const remainingEffects = next.scheduledEvents.some((candidate) => candidate.actionRef === action.actionRef
    && ['action_effect', 'channel_pulse', 'movement_effect'].includes(candidate.type));
  if (!remainingEffects) next = updateAction(next, action.actionRef, (current) => ({ ...current, state: 'resolved' }));
  return success({ encounter: next, resolution, resolvedAction: !remainingEffects, invalidated });
}

function inputComboStopOnMiss(action: CoreV1CompiledEncounterAction): boolean {
  return action.executionPlan.comboStopOnMiss;
}

function completionCandidate(encounter: CoreV1EncounterState): CoreV1EncounterCompletionCandidate | null {
  if (encounter.status === 'cancelled') return 'cancelled';
  const active = encounter.participants.filter(isParticipantActionable);
  if (active.length === 0) return 'stalemate_candidate';
  if (encounter.partySideRef === null) return null;
  const party = active.filter((participant) => participant.sideRef === encounter.partySideRef);
  const hostiles = active.filter((participant) => encounter.participants.some((candidate) => (
    candidate.sideRef === encounter.partySideRef
      && relationFor(encounter, candidate.actorRef, participant.actorRef) === 'hostile'
  )));
  if (party.length > 0 && hostiles.length === 0) return 'party_victory_candidate';
  if (party.length === 0 && hostiles.length > 0) return 'hostile_victory_candidate';
  if (party.length === 0 && hostiles.length === 0) return 'stalemate_candidate';
  return null;
}

function promoteEncounterCompletion(
  encounter: Pick<CoreV1EncounterState, 'completionCandidate'>,
  stopReason: CoreV1EncounterStopReason | null,
): CoreV1EncounterStopReason | null {
  if (encounter.completionCandidate === null) return stopReason;
  return stopReason === null || stopReason === 'new_intent_required' || stopReason === 'no_valid_target'
    ? 'encounter_completed'
    : stopReason;
}

function removeEvents(
  encounter: CoreV1EncounterState,
  refs: ReadonlySet<string>,
): CoreV1EncounterState {
  return { ...encounter, scheduledEvents: encounter.scheduledEvents.filter((event) => !refs.has(event.eventRef)) };
}

function startRecoveryAtCurrentTick(
  encounter: CoreV1EncounterState,
  action: CoreV1CompiledEncounterAction,
): {
  readonly encounter: CoreV1EncounterState;
  readonly replacedReadyEvents: readonly CoreV1EncounterEvent[];
} {
  const replacedReadyEvents = encounter.scheduledEvents.filter((event) => (
    event.actionRef === action.actionRef && event.type === 'actor_ready'
  ));
  let next = removeEvents(encounter, new Set(replacedReadyEvents.map((event) => event.eventRef)));
  const readyTick = addTicks(next.currentTick, action.recoveryTicks, 'cancelled action recovery');
  next = replaceParticipant(next, action.sourceActorRef, (participant) => ({
    ...participant,
    combatState: 'recovering',
    actionSlots: participant.actionSlots.map((slot) => slot.slotRef === action.slotRef
      ? {
        ...slot,
        nextActionAtTick: readyTick,
        stateVersion: safeIntegerAdd(slot.stateVersion, 1, 'action slot state version'),
      }
      : slot),
  }));
  const source = next.participants.find((participant) => participant.actorRef === action.sourceActorRef);
  if (source !== undefined) {
    const readyEvent = eventFor(
      source,
      `${action.actionRef}-ready-after-cancel`,
      nextEventSequence(next),
      'actor_ready',
      readyTick,
      { actionRef: action.actionRef },
    );
    next = { ...next, scheduledEvents: sortedEncounterEvents([...next.scheduledEvents, readyEvent], next.currentTick) };
  }
  return { encounter: next, replacedReadyEvents };
}

function applyReactionCooldown(
  encounter: CoreV1EncounterState,
  event: CoreV1EncounterEvent,
  action: CoreV1CompiledEncounterAction,
  outcome: CoreV1ReactionOutcome,
): CoreV1EncounterResult<{
  readonly encounter: CoreV1EncounterState;
  readonly cooldown: CoreV1EncounterCooldown;
  readonly invalidated: readonly CoreV1EncounterEvent[];
}> {
  const actorRef = event.targetRef ?? event.timelineEvent.actorRef;
  const reactor = encounter.participants.find((participant) => participant.actorRef === actorRef);
  if (reactor === undefined || event.reactionKind === undefined) return failure([issue('event', 'REACTION_CONTEXT', 'Reaction event context is incomplete')]);
  try {
    const definition = getReactionDefinition(event.reactionKind);
    validateCooldown(definition.cooldown);
    const readyAtTick = addTicks(encounter.currentTick, definition.cooldown, 'reaction cooldown');
    const cooldownRef = `reaction-${event.reactionKind}`;
    const cooldown: CoreV1EncounterCooldown = { actorRef, cooldownRef, readyAtTick, sourceKind: 'reaction' };
    let next: CoreV1EncounterState = {
      ...encounter,
      cooldowns: [...encounter.cooldowns.filter((entry) => !(entry.actorRef === actorRef
        && entry.cooldownRef === cooldownRef)), cooldown]
        .sort((left, right) => left.actorRef.localeCompare(right.actorRef)
          || left.cooldownRef.localeCompare(right.cooldownRef)),
    };
    next = replaceParticipant(next, actorRef, (participant) => ({
      ...participant,
      actionSlots: participant.actionSlots.map((slot) => slot.slotType === 'primary'
        ? {
          ...slot,
          nextActionAtTick: addTicks(
            slot.nextActionAtTick > encounter.currentTick ? slot.nextActionAtTick : encounter.currentTick,
            definition.nextActionPenalty,
            'reaction ready penalty',
          ),
          stateVersion: safeIntegerAdd(slot.stateVersion, 1, 'action slot state version'),
        }
        : slot),
    }));
    const sequence = nextEventSequence(next);
    const expired = eventFor(
      reactor,
      `${event.eventRef}-cooldown-expired`,
      sequence,
      'cooldown_expired',
      readyAtTick,
      { targetRef: actorRef, reactionKind: event.reactionKind },
    );
    next = { ...next, scheduledEvents: sortedEncounterEvents([...next.scheduledEvents, expired], next.currentTick) };
    const invalidated: CoreV1EncounterEvent[] = [];
    if (outcome.kind === 'block' && outcome.success && action.blockable) {
      assertIntegerInRange(outcome.blockValue, 0, Number.MAX_SAFE_INTEGER, 'blockValue');
      next = updateAction(next, action.actionRef, (current) => ({
        ...current,
        executionPlan: {
          ...current.executionPlan,
          defenses: {
            ...current.executionPlan.defenses,
            [actorRef]: { blockValue: outcome.blockValue, completeBlock: outcome.completeBlock },
          },
        },
      }));
    } else if (outcome.kind === 'active_dodge' && outcome.success && action.dodgeable) {
      next = updateAction(next, action.actionRef, (current) => ({
        ...current,
        dodgedTargetRefs: [...new Set([...current.dodgedTargetRefs, actorRef])].sort(),
      }));
    } else if (outcome.kind === 'interrupt' && outcome.success && action.interruptible) {
      const later = next.scheduledEvents.filter((candidate) => candidate.actionRef === action.actionRef
        && ['action_effect', 'channel_pulse', 'upkeep_due', 'movement_effect'].includes(candidate.type));
      invalidated.push(...later);
      next = removeEvents(next, new Set(later.map((candidate) => candidate.eventRef)));
      let interruptedCastingState = action.executionPlan.castingState;
      let consumedMana = 0;
      if (interruptedCastingState?.phase === 'casting') {
        const interrupted = interruptCasting(interruptedCastingState, next.currentTick);
        interruptedCastingState = interrupted.state;
        consumedMana = interrupted.manaDelta.consumed;
      }
      next = updateAction(next, action.actionRef, (current) => ({
        ...current,
        state: 'interrupted',
        executionPlan: {
          ...current.executionPlan,
          ...(interruptedCastingState === undefined ? {} : { castingState: interruptedCastingState }),
        },
      }));
      next = replaceParticipant(next, action.sourceActorRef, (participant) => ({
        ...participant,
        resources: consumedMana === 0 ? participant.resources : {
          ...participant.resources,
          mana: {
            ...participant.resources.mana,
            current: safeIntegerAdd(participant.resources.mana.current, -consumedMana, 'interrupted casting mana'),
          },
        },
      }));
      const recovery = startRecoveryAtCurrentTick(next, action);
      invalidated.push(...recovery.replacedReadyEvents);
      next = recovery.encounter;
    }
    const defensiveSuccess = (outcome.kind === 'block' || outcome.kind === 'active_dodge') && outcome.success;
    if (defensiveSuccess && action.executionPlan.reactionPolicy.allowCounterAttack) {
      const counter = reactor.reactionCapabilities.find((capability) => capability.kind === 'counter_attack');
      const cooling = next.cooldowns.some((entry) => entry.actorRef === actorRef
        && entry.cooldownRef === 'reaction-counter_attack' && entry.readyAtTick > next.currentTick);
      if (counter !== undefined && !cooling) {
        try {
          const resolved = resolveReaction({
            kind: 'counter_attack', originActionRef: action.actionRef,
            sourceEventIsReaction: true, currentDepth: 1,
            startTick: next.currentTick, originEffectTick: action.effectTick,
            defensiveReactionAlreadyUsed: true, counterAttackAlreadyUsed: false,
            surprised: false, actorFirstReadyTick: reactor.initiative.firstReadyTick,
          });
          const counterEvent = eventFor(
            reactor,
            `${action.actionRef}-counter-attack`,
            nextEventSequence(next),
            'counter_attack_started',
            resolved.completionTick,
            { actionRef: action.actionRef, targetRef: actorRef, reactionKind: 'counter_attack' },
          );
          const reserved = reserveReactionCost(next, counterEvent);
          if (reserved.ok) {
            next = {
              ...reserved.value,
              scheduledEvents: sortedEncounterEvents([...reserved.value.scheduledEvents, counterEvent], reserved.value.currentTick),
            };
          }
        } catch {
          // The terminal counter is optional when its RC1.1 window no longer fits.
        }
      }
    }
    return success({ encounter: next, cooldown, invalidated });
  } catch (error) {
    return caughtFailure(error, 'reaction');
  }
}

function reactionOutcome(
  encounter: CoreV1EncounterState,
  event: CoreV1EncounterEvent,
  action: CoreV1CompiledEncounterAction,
  runtime: CoreV1EncounterRuntime,
): CoreV1EncounterResult<CoreV1ReactionOutcome> {
  if (event.reactionKind === undefined || runtime.reactionOutcomes === undefined) {
    return failure([issue('runtime.reactionOutcomes', 'REACTION_OUTCOME_REQUIRED', 'Reaction outcome resolver is required')]);
  }
  const outcome = runtime.reactionOutcomes.resolve({
    encounter: cloneValue(encounter),
    action: cloneValue(action),
    reactorActorRef: event.targetRef ?? event.timelineEvent.actorRef,
    reactionKind: event.reactionKind,
    currentTick: encounter.currentTick,
  });
  if (outcome.kind !== event.reactionKind) return failure([issue('runtime.reactionOutcomes', 'REACTION_KIND_MATCH', 'Reaction outcome kind does not match the event')]);
  return success(outcome);
}

function reserveReactionCost(
  encounter: CoreV1EncounterState,
  event: CoreV1EncounterEvent,
): CoreV1EncounterResult<CoreV1EncounterState> {
  const actorRef = event.targetRef ?? event.timelineEvent.actorRef;
  const participant = encounter.participants.find((candidate) => candidate.actorRef === actorRef);
  const capability = participant?.reactionCapabilities.find((candidate) => candidate.kind === event.reactionKind);
  if (participant === undefined || capability === undefined) return failure([issue('event', 'REACTION_CAPABILITY', 'Reaction capability is no longer available')]);
  const cost = resolveCoreV1Cost({ tier: capability.tier, cost: capability.cost, resources: participant.resources });
  if (!cost.ok) return failure(cost.issues);
  if (!cost.value.affordable) return failure([issue('participant.resources', 'INSUFFICIENT_RESOURCE', 'Reaction cost cannot be reserved')]);
  return success(replaceParticipant(encounter, actorRef, (current) => applyResourceDeltasToParticipant(current, cost.value.resourceDeltas)));
}

function eventInvalidReason(
  encounter: CoreV1EncounterState,
  event: CoreV1EncounterEvent,
): 'NO_VALID_TARGET' | 'STATE_CHANGED' | null {
  if (event.type === 'cooldown_expired' || event.type === 'actor_ready') return null;
  const action = event.actionRef === undefined ? undefined
    : encounter.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
  if (event.actionRef !== undefined && action === undefined) return 'STATE_CHANGED';
  if (['action_effect', 'movement_effect', 'channel_pulse', 'upkeep_due'].includes(event.type)) {
    if (action?.state === 'interrupted' || action?.state === 'invalidated') return 'STATE_CHANGED';
    const source = encounter.participants.find((participant) => participant.actorRef === action?.sourceActorRef);
    if (!isParticipantActionable(source)) return 'STATE_CHANGED';
  }
  if (event.targetRef !== undefined && ['action_effect', 'channel_pulse'].includes(event.type)) {
    const target = encounter.participants.find((participant) => participant.actorRef === event.targetRef);
    if (!isParticipantActionable(target)) return 'NO_VALID_TARGET';
  }
  return null;
}

export function processNextCoreV1EncounterEvent(
  encounterInput: CoreV1EncounterState,
  runtime: CoreV1EncounterRuntime,
): CoreV1EncounterResult<CoreV1EncounterBatchResult> {
  const encounter = validateCoreV1EncounterState(encounterInput);
  if (!encounter.ok) return encounter;
  const report = emptyBatch(encounter.value);
  const event = encounter.value.scheduledEvents[0];
  if (event === undefined) return success(report);
  if ((event.type === 'reaction_resolved' || event.type === 'counter_attack_started')
    && runtime.reactionOutcomes === undefined) {
    return failure([issue('runtime.reactionOutcomes', 'REACTION_OUTCOME_REQUIRED', 'Reaction outcome resolver is required before processing this event')]);
  }
  let next: CoreV1EncounterState = {
    ...encounter.value,
    currentTick: event.timelineEvent.tick,
    scheduledEvents: encounter.value.scheduledEvents.slice(1),
  };
  const invalidReason = eventInvalidReason(next, event);
  if (invalidReason !== null) {
    const action = event.actionRef === undefined ? undefined
      : next.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
    const hasRemainingExecutionEvent = event.actionRef !== undefined
      && next.scheduledEvents.some((candidate) => candidate.actionRef === event.actionRef
        && ['action_effect', 'movement_effect', 'channel_pulse', 'upkeep_due'].includes(candidate.type));
    const terminalState = action !== undefined && !hasRemainingExecutionEvent
      ? invalidReason === 'STATE_CHANGED' || !action.costApplied
        ? 'invalidated' as const
        : 'resolved' as const
      : null;
    if (terminalState !== null && event.actionRef !== undefined) {
      next = updateAction(next, event.actionRef, (candidate) => ({ ...candidate, state: terminalState }));
    }
    next = {
      ...next,
      stateVersion: safeIntegerAdd(next.stateVersion, 1, 'encounter state version'),
      completionCandidate: completionCandidate(next),
    };
    const stopReason = promoteEncounterCompletion(
      next,
      terminalState === 'invalidated'
        ? 'new_intent_required'
        : invalidReason === 'NO_VALID_TARGET' ? 'no_valid_target' : null,
    );
    return success({
      ...report,
      encounterAfter: next,
      resolvedActions: terminalState === 'resolved' && event.actionRef !== undefined
        ? [event.actionRef]
        : [],
      invalidatedEvents: [{ event, reason: invalidReason }],
      stopReason,
      continuationRequired: stopReason === 'new_intent_required',
    });
  }
  const processedEvents = [event];
  const resolvedActions: string[] = [];
  const effectResolutions: CoreV1EffectSequenceResult[] = [];
  const reactionResolutions: CoreV1ReactionOutcome[] = [];
  const movementChanges: CoreV1EncounterBatchResult['movementChanges'][number][] = [];
  const cooldownChanges: CoreV1EncounterCooldown[] = [];
  const invalidatedEvents: CoreV1EncounterBatchResult['invalidatedEvents'][number][] = [];
  const readyActors: string[] = [];
  let stopReason: CoreV1EncounterStopReason | null = null;
  try {
    if (event.type === 'action_started' && event.actionRef !== undefined) {
      next = updateAction(next, event.actionRef, (action) => ({ ...action, state: 'active' }));
    } else if (event.type === 'reaction_started') {
      const reserved = reserveReactionCost(next, event);
      if (!reserved.ok) return reserved;
      next = reserved.value;
    } else if ((event.type === 'reaction_resolved' || event.type === 'counter_attack_started')
      && event.actionRef !== undefined) {
      const action = next.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
      if (action === undefined) return failure([issue('event.actionRef', 'STATE_CHANGED', 'Origin action is no longer available')]);
      const outcome = reactionOutcome(next, event, action, runtime);
      if (!outcome.ok) return outcome;
      const applied = applyReactionCooldown(next, event, action, outcome.value);
      if (!applied.ok) return applied;
      next = applied.value.encounter;
      cooldownChanges.push(applied.value.cooldown);
      reactionResolutions.push(outcome.value);
      invalidatedEvents.push(...applied.value.invalidated.map((invalidated) => ({
        event: invalidated, reason: 'STATE_CHANGED' as const,
      })));
    } else if ((event.type === 'action_effect' || event.type === 'channel_pulse')
      && event.actionRef !== undefined) {
      const resolved = processEffectEvent(next, event, runtime);
      if (!resolved.ok) {
        next = updateAction(next, event.actionRef, (action) => ({ ...action, state: 'invalidated' }));
        invalidatedEvents.push({ event, reason: 'STATE_CHANGED' });
        stopReason = resolved.issues.some((entry) => entry.rule === 'INSUFFICIENT_RESOURCE')
          ? 'resource_below_required' : 'no_valid_target';
      } else {
        next = resolved.value.encounter;
        effectResolutions.push(resolved.value.resolution);
        if (resolved.value.resolvedAction) resolvedActions.push(event.actionRef);
        invalidatedEvents.push(...resolved.value.invalidated.map((invalidated) => ({
          event: invalidated, reason: 'STATE_CHANGED' as const,
        })));
      }
    } else if (event.type === 'movement_effect' && event.actionRef !== undefined) {
      const action = next.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
      const movement = action?.executionPlan.movement;
      if (action === undefined || movement === undefined) return failure([issue('event', 'MOVEMENT_PLAN', 'Movement event has no compiled plan')]);
      const kind = movement.kind === 'move_and_act' ? 'approach' : movement.kind;
      calculateMovement(movement.from, movement.to, kind, movement.terrain);
      const actor = next.participants.find((participant) => participant.actorRef === action.sourceActorRef);
      if (actor === undefined || actor.zone !== movement.from) {
        invalidatedEvents.push({ event, reason: 'STATE_CHANGED' });
        stopReason = 'zone_changed';
      } else {
        const movementSpCost = action.resourceReservationPlan.reservations
          .find((reservation) => reservation.resource === 'sp')?.amount ?? 0;
        if (actor.resources.sp.current < movementSpCost) {
          return failure([issue('participant.resources.sp', 'INSUFFICIENT_RESOURCE', 'Movement SP cost is no longer affordable')]);
        }
        next = replaceParticipant(next, actor.actorRef, (participant) => ({
          ...participant,
          zone: movement.to,
          resources: movementSpCost === 0 ? participant.resources : {
            ...participant.resources,
            sp: {
              ...participant.resources.sp,
              current: safeIntegerAdd(participant.resources.sp.current, -movementSpCost, 'movement SP'),
            },
          },
        }));
        movementChanges.push({ actorRef: actor.actorRef, from: movement.from, to: movement.to });
        const affected = next.scheduledEvents.filter((candidate) => candidate.actionRef !== action.actionRef
          && candidate.targetRef === actor.actorRef && ['action_effect', 'channel_pulse'].includes(candidate.type));
        if (affected.length > 0) {
          next = removeEvents(next, new Set(affected.map((candidate) => candidate.eventRef)));
          invalidatedEvents.push(...affected.map((invalidated) => ({ event: invalidated, reason: 'STATE_CHANGED' as const })));
        }
        next = updateAction(next, action.actionRef, (current) => ({
          ...current,
          state: 'resolved',
          costApplied: true,
        }));
        resolvedActions.push(action.actionRef);
      }
    } else if (event.type === 'upkeep_due' && event.actionRef !== undefined) {
      const action = next.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
      const upkeep = action?.upkeepPlan[0];
      const source = next.participants.find((participant) => participant.actorRef === action?.sourceActorRef);
      if (action === undefined || upkeep === undefined || source === undefined) return failure([issue('event', 'REQUIRES_UPKEEP_POLICY', 'Upkeep event has no compiled policy')]);
      const pool = source.resources[upkeep.resource];
      if (pool.current < upkeep.amount) {
        const later = next.scheduledEvents.filter((candidate) => candidate.actionRef === action.actionRef
          && ['channel_pulse', 'upkeep_due'].includes(candidate.type));
        next = removeEvents(next, new Set(later.map((candidate) => candidate.eventRef)));
        next = updateAction(next, action.actionRef, (current) => ({ ...current, state: 'interrupted' }));
        const recovery = startRecoveryAtCurrentTick(next, action);
        next = recovery.encounter;
        invalidatedEvents.push(...[...later, ...recovery.replacedReadyEvents]
          .map((invalidated) => ({ event: invalidated, reason: 'STATE_CHANGED' as const })));
        stopReason = 'resource_below_required';
      } else {
        next = replaceParticipant(next, source.actorRef, (participant) => ({
          ...participant,
          resources: {
            ...participant.resources,
            [upkeep.resource]: { ...participant.resources[upkeep.resource], current: pool.current - upkeep.amount },
          },
        }));
      }
    } else if (event.type === 'cooldown_expired') {
      const actorRef = event.targetRef ?? event.timelineEvent.actorRef;
      const cooldownRef = event.reactionKind === undefined ? null : `reaction-${event.reactionKind}`;
      next = { ...next, cooldowns: next.cooldowns.filter((entry) => !(entry.actorRef === actorRef
        && (cooldownRef === null || entry.cooldownRef === cooldownRef)
        && entry.readyAtTick <= next.currentTick)) };
    } else if (event.type === 'actor_ready') {
      const actorRef = event.timelineEvent.actorRef;
      const participant = next.participants.find((candidate) => candidate.actorRef === actorRef);
      if (participant !== undefined && isParticipantActionable(participant)) {
        next = replaceParticipant(next, actorRef, (current) => ({ ...current, combatState: 'ready' }));
        readyActors.push(actorRef);
      }
      if (event.actionRef !== undefined) {
        const action = next.activeActions.find((candidate) => candidate.actionRef === event.actionRef);
        if (action !== undefined && ['resolved', 'interrupted', 'invalidated'].includes(action.state)) {
          if (action.state !== 'invalidated') resolvedActions.push(action.actionRef);
          next = { ...next, activeActions: next.activeActions.filter((candidate) => candidate.actionRef !== action.actionRef) };
        }
      }
    }
    next = {
      ...next,
      stateVersion: safeIntegerAdd(encounter.value.stateVersion, 1, 'encounter state version'),
      completionCandidate: completionCandidate(next),
      scheduledEvents: sortedEncounterEvents(next.scheduledEvents, next.currentTick),
    };
    const validated = validateCoreV1EncounterState(next);
    if (!validated.ok) return validated;
    stopReason = promoteEncounterCompletion(validated.value, stopReason);
    return success({
      encounterBefore: report.encounterBefore,
      encounterAfter: validated.value,
      processedEvents,
      resolvedActions: [...new Set(resolvedActions)].sort(),
      effectResolutions,
      reactionResolutions,
      movementChanges,
      cooldownChanges,
      invalidatedEvents,
      readyActors: [...new Set(readyActors)].sort(),
      stopReason,
      continuationRequired: false,
    });
  } catch (error) {
    return caughtFailure(error, 'event');
  }
}

function mergeBatchReports(
  before: CoreV1EncounterState,
  after: CoreV1EncounterState,
  reports: readonly CoreV1EncounterBatchResult[],
  stopReason: CoreV1EncounterStopReason | null,
  continuationRequired: boolean,
): CoreV1EncounterBatchResult {
  return {
    encounterBefore: cloneValue(before),
    encounterAfter: cloneValue(after),
    processedEvents: reports.flatMap((report) => report.processedEvents.map((event) => cloneValue(event))),
    resolvedActions: [...new Set(reports.flatMap((report) => report.resolvedActions))].sort(),
    effectResolutions: reports.flatMap((report) => report.effectResolutions.map((resolution) => cloneValue(resolution))),
    reactionResolutions: reports.flatMap((report) => report.reactionResolutions.map((resolution) => cloneValue(resolution))),
    movementChanges: reports.flatMap((report) => report.movementChanges.map((change) => cloneValue(change))),
    cooldownChanges: reports.flatMap((report) => report.cooldownChanges.map((change) => cloneValue(change))),
    invalidatedEvents: reports.flatMap((report) => report.invalidatedEvents.map((entry) => cloneValue(entry))),
    readyActors: [...new Set(reports.flatMap((report) => report.readyActors))].sort(),
    stopReason,
    continuationRequired,
  };
}

export function processCoreV1EncounterBatch(
  encounterInput: CoreV1EncounterState,
  runtime: CoreV1EncounterRuntime,
): CoreV1EncounterResult<CoreV1EncounterBatchResult> {
  const encounter = validateCoreV1EncounterState(encounterInput);
  if (!encounter.ok) return encounter;
  let current = encounter.value;
  const startTick = current.currentTick;
  const reports: CoreV1EncounterBatchResult[] = [];
  let stopReason: CoreV1EncounterStopReason | null = null;
  while (current.scheduledEvents.length > 0 && reports.length < Math.min(
    CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
    CORE_V1_MAX_PROCESSING_EVENTS,
  )) {
    const nextTick = current.scheduledEvents[0]?.timelineEvent.tick;
    if (nextTick === undefined) break;
    if (nextTick - startTick > CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE
      || nextTick - startTick > CORE_V1_MAX_PROCESSING_ADVANCE) {
      stopReason = 'processing_limit';
      break;
    }
    const processed = processNextCoreV1EncounterEvent(current, runtime);
    if (!processed.ok) return processed;
    if (processed.value.processedEvents.length === 0
      && processed.value.invalidatedEvents.length === 0) break;
    reports.push(processed.value);
    current = processed.value.encounterAfter;
    if (processed.value.stopReason === 'encounter_completed'
      || processed.value.stopReason === 'encounter_failed'
      || processed.value.stopReason === 'reaction_required') {
      stopReason = processed.value.stopReason;
      break;
    }
    if (processed.value.stopReason !== null) stopReason = processed.value.stopReason;
  }
  const technicalLimit = current.scheduledEvents.length > 0
    && (reports.length >= CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS
      || reports.length >= CORE_V1_MAX_PROCESSING_EVENTS
      || (current.scheduledEvents[0]?.timelineEvent.tick ?? current.currentTick) - startTick > CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE);
  if (technicalLimit) stopReason = 'processing_limit';
  return success(mergeBatchReports(
    encounter.value,
    current,
    reports,
    stopReason,
    technicalLimit || reports.some((report) => report.continuationRequired),
  ));
}

export function applyCoreV1EncounterIntent(
  input: CoreV1ApplyEncounterIntentInput,
): CoreV1EncounterResult<CoreV1EncounterBatchResult> {
  const compiled = compileCoreV1EncounterAction(input);
  if (!compiled.ok) return compiled;
  const scheduled = scheduleCoreV1EncounterAction(input.encounter, compiled.value);
  if (!scheduled.ok) return scheduled;
  return success({
    ...emptyBatch(input.encounter),
    encounterAfter: scheduled.value,
  });
}

function planStopReason(
  input: CoreV1ApplyEncounterActionPlanInput,
  before: CoreV1EncounterState,
  report: CoreV1EncounterBatchResult,
): CoreV1EncounterStopReason | null {
  const conditions = new Set(input.plan.stopConditions);
  const actor = report.encounterAfter.participants.find((participant) => participant.actorRef === input.plan.actorRef);
  if (conditions.has('actorIncapacitated') && !isParticipantActionable(actor)) return 'actor_incapacitated';
  if (conditions.has('hostileBecomesReady') && report.readyActors.some((actorRef) => (
    relationFor(report.encounterAfter, input.plan.actorRef, actorRef) === 'hostile'
  ))) return 'hostile_became_ready';
  if (conditions.has('zoneChanged')) {
    const oldZone = before.participants.find((participant) => participant.actorRef === input.plan.actorRef)?.zone;
    if (oldZone !== actor?.zone) return 'zone_changed';
  }
  if (conditions.has('resourceBelowRequired') && report.stopReason === 'resource_below_required') return 'resource_below_required';
  if (conditions.has('targetSetChangedMaterially') && report.invalidatedEvents.some((entry) => entry.reason === 'NO_VALID_TARGET')) return 'target_set_changed';
  if (conditions.has('noValidTarget') && report.stopReason === 'no_valid_target') return 'no_valid_target';
  if (conditions.has('reactionRequired') && report.stopReason === 'reaction_required') return 'reaction_required';
  if (conditions.has('newThreatDetected') && before.participants.length !== report.encounterAfter.participants.length) return 'new_threat_detected';
  if (conditions.has('stateVersionChanged') && before.stateVersion !== report.encounterAfter.stateVersion) return 'state_version_changed';
  if (conditions.has('processingLimit') && report.continuationRequired) return 'processing_limit';
  if (conditions.has('newPlayerIntentRequired') && report.stopReason === 'new_intent_required') return 'new_intent_required';
  if (report.stopReason !== null && [
    'processing_limit', 'new_intent_required', 'encounter_completed', 'encounter_failed',
  ].includes(report.stopReason)) return report.stopReason;
  return null;
}

function refreshPlanTargetingContext(
  encounter: CoreV1EncounterState,
  context: CoreV1CompileEncounterActionInput['targetingContext'],
): CoreV1CompileEncounterActionInput['targetingContext'] {
  return {
    ...cloneValue(context),
    candidates: context.candidates.map((candidate) => {
      const participant = encounter.participants.find((entry) => entry.actorRef === candidate.actorRef);
      if (participant === undefined) return cloneValue(candidate);
      const active = participant.combatState !== 'removed'
        && participant.combatState !== 'incapacitated_candidate'
        && participant.resources.hp.current > 0;
      return {
        ...cloneValue(candidate),
        targetable: candidate.targetable && participant.combatState !== 'removed',
        active,
        hpCurrent: participant.resources.hp.current,
        hpMaximum: participant.resources.hp.maximum,
      };
    }),
  };
}

export function applyCoreV1EncounterActionPlan(
  input: CoreV1ApplyEncounterActionPlanInput,
): CoreV1EncounterResult<CoreV1EncounterBatchResult> {
  const encounter = validateCoreV1EncounterState(input.encounter);
  if (!encounter.ok) return encounter;
  if (!isStableRef(input.plan.planRef) || !isStableRef(input.plan.actorRef)) return failure([issue('plan', 'PUBLIC_REF', 'Plan and actor refs must be stable')]);
  if (input.plan.expectedStateVersion !== encounter.value.stateVersion) return success({
    ...emptyBatch(encounter.value),
    stopReason: 'state_version_changed',
    continuationRequired: true,
  });
  if (!isArrayValue(input.plan.intents) || input.plan.intents.length < 1
    || input.plan.intents.length > CORE_V1_MAX_ENCOUNTER_PLAN_ACTIONS) {
    return failure([issue('plan.intents', 'PLAN_ACTION_LIMIT', 'Action plan supports between one and five primary actions')]);
  }
  if (!isArrayValue(input.plan.stopConditions)
    || input.plan.stopConditions.some((condition) => !actionPlanStopConditions.has(condition))) {
    return failure([issue('plan.stopConditions', 'STOP_CONDITION', 'Action plan stop conditions must use the closed catalog')]);
  }
  if (input.plan.intents.some((intent) => intent.sourceActorRef !== input.plan.actorRef)) {
    return failure([issue('plan.intents', 'PLAN_ACTOR_MATCH', 'Every plan intent must use the plan actor')]);
  }
  let current: CoreV1EncounterState = {
    ...encounter.value,
    actionPlans: [...encounter.value.actionPlans.filter((plan) => plan.planRef !== input.plan.planRef), cloneValue(input.plan)]
      .sort((left, right) => left.planRef.localeCompare(right.planRef)),
  };
  const reports: CoreV1EncounterBatchResult[] = [];
  const planStart = current.currentTick;
  let stopReason: CoreV1EncounterStopReason | null = null;
  for (const intent of input.plan.intents) {
    if (reports.flatMap((report) => report.processedEvents).length >= CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS
      || current.currentTick - planStart > CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE) {
      stopReason = 'processing_limit';
      break;
    }
    const definition = input.definitions[intent.intentRef];
    const targetingContext = input.targetingContexts[intent.intentRef];
    if (definition === undefined || targetingContext === undefined) {
      stopReason = 'new_intent_required';
      break;
    }
    const compiled = compileCoreV1EncounterAction({
      encounter: current,
      intent,
      definition,
      targetingContext: refreshPlanTargetingContext(current, targetingContext),
    });
    if (!compiled.ok) {
      stopReason = compiled.issues.some((entry) => entry.rule === 'NO_VALID_TARGET')
        ? 'no_valid_target'
        : compiled.issues.some((entry) => entry.rule === 'REACTION_OUTCOME_REQUIRED'
          || entry.rule === 'REACTION_WINDOW_CLOSED')
          ? 'reaction_required'
        : compiled.issues.some((entry) => entry.rule === 'INSUFFICIENT_RESOURCE')
          ? 'resource_below_required'
          : 'new_intent_required';
      break;
    }
    const processedCount = reports.flatMap((report) => report.processedEvents).length;
    if (processedCount + compiled.value.internalEvents.length > CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS
      || compiled.value.nextActionAtTick - planStart > CORE_V1_MAX_ENCOUNTER_BATCH_ADVANCE) {
      stopReason = 'processing_limit';
      break;
    }
    const scheduled = scheduleCoreV1EncounterAction(current, compiled.value);
    if (!scheduled.ok) return scheduled;
    current = scheduled.value;
    const processed = processCoreV1EncounterBatch(current, input.runtime);
    if (!processed.ok) return processed;
    reports.push(processed.value);
    const condition = planStopReason(input, current, processed.value);
    current = processed.value.encounterAfter;
    if (condition !== null) {
      stopReason = condition;
      break;
    }
  }
  const completedActions = reports.flatMap((report) => report.resolvedActions).length;
  const continuationRequired = stopReason === 'encounter_completed' || stopReason === 'encounter_failed'
    ? false
    : stopReason === 'processing_limit'
      || stopReason === 'new_intent_required'
      || stopReason === 'reaction_required'
      || completedActions < input.plan.intents.length;
  if (stopReason === null) stopReason = 'plan_completed';
  current = {
    ...current,
    actionPlans: stopReason === 'plan_completed'
      ? current.actionPlans.filter((plan) => plan.planRef !== input.plan.planRef)
      : current.actionPlans,
  };
  return success(mergeBatchReports(
    encounter.value,
    current,
    reports,
    stopReason,
    continuationRequired,
  ));
}
