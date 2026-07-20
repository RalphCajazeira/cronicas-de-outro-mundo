import { EncounterLifecycleStatus } from '../../generated/prisma/client.js';
import {
  CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
  type CoreV1EncounterBatchResult,
  type CoreV1EncounterState,
} from '../rules/core-v1/index.js';
import { EncounterError } from './encounter.errors.js';
import type {
  EncounterNextRequiredActionDto,
  EncounterTransitionCategory,
  EncounterTransitionSummaryDto,
} from './encounter.types.js';

export function encounterNextRequiredAction(
  state: CoreV1EncounterState,
  lifecycleStatus: EncounterLifecycleStatus,
): EncounterNextRequiredActionDto {
  if (lifecycleStatus === EncounterLifecycleStatus.AWAITING_INTENT) {
    const actors = state.participants.flatMap((participant) => {
      if (participant.combatState !== 'ready' || participant.resources.hp.current <= 0) return [];
      const readySlots = participant.actionSlots
        .filter((slot) => slot.nextActionAtTick <= state.currentTick)
        .map((slot) => slot.slotRef);
      if (new Set(readySlots).size !== readySlots.length) {
        throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
      }
      const readySlotRefs = readySlots.sort();
      return readySlotRefs.length === 0 ? [] : [{ actorRef: participant.actorRef, readySlotRefs }];
    }).sort((left, right) => left.actorRef.localeCompare(right.actorRef));
    if (actors.length === 0 || new Set(actors.map((actor) => actor.actorRef)).size !== actors.length) {
      throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    }
    return { type: 'submit_intent', actors };
  }
  if (lifecycleStatus === EncounterLifecycleStatus.AWAITING_REACTION) {
    const event = state.scheduledEvents[0];
    const reactorRef = event?.targetRef ?? event?.timelineEvent.actorRef;
    if (event === undefined || !['reaction_resolved', 'counter_attack_started'].includes(event.type)
      || reactorRef === undefined || event.reactionKind === undefined) {
      throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    }
    return { type: 'resolve_reaction', reactorRef, reactionKind: event.reactionKind };
  }
  if (lifecycleStatus === EncounterLifecycleStatus.PROCESSING_PAUSED) return { type: 'continue' };
  if (lifecycleStatus === EncounterLifecycleStatus.COMPLETION_PENDING) {
    if (state.completionCandidate === null) throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
    return { type: 'confirm_completion', completionCandidate: state.completionCandidate };
  }
  if (lifecycleStatus === EncounterLifecycleStatus.COMPLETED
    || lifecycleStatus === EncounterLifecycleStatus.FAILED
    || lifecycleStatus === EncounterLifecycleStatus.CANCELLED) return { type: 'none' };
  throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
}

function eventCategory(type: CoreV1EncounterBatchResult['processedEvents'][number]['type']): EncounterTransitionCategory {
  if (type === 'action_started' || type === 'reaction_started' || type === 'counter_attack_started') return 'action_started';
  if (type === 'reaction_resolved') return 'reaction_resolved';
  if (type === 'movement_effect') return 'movement_resolved';
  if (type === 'actor_ready' || type === 'participant_incapacitated_candidate') return 'participant_state_changed';
  if (type === 'upkeep_due' || type === 'cooldown_expired') return 'resource_changed';
  return 'action_resolved';
}

export function encounterTransitionSummary(batch: CoreV1EncounterBatchResult): EncounterTransitionSummaryDto | undefined {
  if (batch.processedEvents.length === 0) return undefined;
  if (batch.processedEvents.length > CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS
    || Object.keys(batch.processedEvents).length !== batch.processedEvents.length) {
    throw new EncounterError('ENCOUNTER_DENORMALIZED_DRIFT');
  }
  const events = batch.processedEvents.map((event) => ({
    category: eventCategory(event.type),
    actorRef: event.timelineEvent.actorRef,
    ...(event.targetRef === undefined ? {} : { targetRef: event.targetRef }),
  }));
  const beforeByRef = new Map(batch.encounterBefore.participants.map((participant) => [participant.actorRef, participant]));
  const changes: EncounterTransitionSummaryDto['changes'][number][] = [];
  for (const after of batch.encounterAfter.participants) {
    const before = beforeByRef.get(after.actorRef);
    if (before === undefined) continue;
    const categories = new Set<EncounterTransitionCategory>();
    const resources: Partial<Record<'hp' | 'mana' | 'sp', { before: number; after: number; delta: number }>> = {};
    for (const resource of ['hp', 'mana', 'sp'] as const) {
      if (before.resources[resource].current === after.resources[resource].current) continue;
      resources[resource] = {
        before: before.resources[resource].current,
        after: after.resources[resource].current,
        delta: after.resources[resource].current - before.resources[resource].current,
      };
      categories.add('resource_changed');
      if (resource === 'hp' && resources[resource].delta < 0) categories.add('damage_applied');
    }
    const zone = before.zone === after.zone ? undefined : { before: before.zone, after: after.zone };
    if (zone !== undefined) categories.add('movement_resolved');
    const combatState = before.combatState === after.combatState
      ? undefined : { before: before.combatState, after: after.combatState };
    if (combatState !== undefined) categories.add('participant_state_changed');
    const beforeEffects = new Set(before.activeEffects.map((effect) => effect.effectRef));
    const afterEffects = new Set(after.activeEffects.map((effect) => effect.effectRef));
    const activeEffects = {
      applied: [...afterEffects].filter((ref) => !beforeEffects.has(ref)).length,
      removed: [...beforeEffects].filter((ref) => !afterEffects.has(ref)).length,
    };
    if (activeEffects.applied > 0) categories.add('effect_applied');
    if (activeEffects.removed > 0) categories.add('effect_removed');
    if (categories.size === 0) continue;
    changes.push({
      actorRef: after.actorRef,
      categories: [...categories].sort(),
      ...(Object.keys(resources).length === 0 ? {} : { resources }),
      ...(zone === undefined ? {} : { zone }),
      ...(combatState === undefined ? {} : { combatState }),
      ...(activeEffects.applied === 0 && activeEffects.removed === 0 ? {} : { activeEffects }),
    });
  }
  return { processedEventCount: batch.processedEvents.length, events, changes };
}
