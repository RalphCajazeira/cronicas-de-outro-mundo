import type { EncounterDto, EncounterNextRequiredActionDto, EncounterTransitionSummaryDto } from './encounter.types.js';

export type EncounterPublicResult =
  | 'encounter_created' | 'encounter_loaded' | 'intent_accepted' | 'reaction_required'
  | 'reaction_resolved' | 'processing_paused' | 'new_intent_required'
  | 'completion_confirmation_required' | 'encounter_completed' | 'encounter_cancelled'
  | 'encounter_failed';

export interface EncounterPublicDto {
  readonly result: EncounterPublicResult;
  readonly encounterRef: string;
  readonly lifecycleStatus: string;
  readonly stateVersion: number;
  readonly currentTick: string;
  readonly stopReason: string | null;
  readonly completionCandidate: string | null;
  readonly participants: readonly {
    readonly actorRef: string;
    readonly bindingKind: 'persisted_actor' | 'ephemeral';
    readonly sideRef: string;
    readonly combatState: string;
    readonly zone: string;
    readonly resources: {
      readonly hp: { readonly current: number; readonly maximum: number };
      readonly mana: { readonly current: number; readonly maximum: number };
      readonly sp: { readonly current: number; readonly maximum: number };
    };
  }[];
  readonly nextRequiredAction: EncounterNextRequiredActionDto;
  readonly transitionSummary?: EncounterTransitionSummaryDto;
}

export function encounterPublicResult(dto: EncounterDto): EncounterPublicResult {
  if (dto.lifecycleStatus === 'cancelled') return 'encounter_cancelled';
  if (dto.lifecycleStatus === 'completed') return 'encounter_completed';
  if (dto.lifecycleStatus === 'failed') return 'encounter_failed';
  if (dto.lifecycleStatus === 'completion_pending') return 'completion_confirmation_required';
  if (dto.lifecycleStatus === 'awaiting_reaction') return 'reaction_required';
  const processed = (dto.transitionSummary?.processedEventCount ?? 0) > 0;
  if (dto.lifecycleStatus === 'awaiting_intent' && processed) return 'new_intent_required';
  if (dto.lifecycleStatus === 'processing_paused' && processed) return 'processing_paused';
  if (dto.operation === 'create') return 'encounter_created';
  if (dto.operation === 'load') return 'encounter_loaded';
  if (dto.operation === 'submit_intent') return 'intent_accepted';
  if (dto.operation === 'resolve_reaction') return 'reaction_resolved';
  throw new TypeError('Encounter DTO has no compatible public result');
}

function toPublicNextRequiredAction(value: EncounterNextRequiredActionDto): EncounterNextRequiredActionDto {
  if (value.type === 'submit_intent') return {
    type: 'submit_intent',
    actors: value.actors.map((actor) => ({ actorRef: actor.actorRef, readySlotRefs: [...actor.readySlotRefs] })),
  };
  if (value.type === 'resolve_reaction') return {
    type: 'resolve_reaction', reactorRef: value.reactorRef, reactionKind: value.reactionKind,
  };
  if (value.type === 'confirm_completion') return {
    type: 'confirm_completion', completionCandidate: value.completionCandidate,
  };
  if (value.type === 'continue') return { type: 'continue' };
  if (value.type === 'none') return { type: 'none' };
  throw new TypeError('Encounter DTO has an invalid next action');
}

function toPublicTransitionSummary(value: EncounterTransitionSummaryDto): EncounterTransitionSummaryDto {
  return {
    processedEventCount: value.processedEventCount,
    events: value.events.map((event) => ({
      category: event.category,
      ...(event.actorRef === undefined ? {} : { actorRef: event.actorRef }),
      ...(event.targetRef === undefined ? {} : { targetRef: event.targetRef }),
    })),
    changes: value.changes.map((change) => ({
      actorRef: change.actorRef,
      categories: [...change.categories],
      ...(change.resources === undefined ? {} : { resources: Object.fromEntries(
        (['hp', 'mana', 'sp'] as const).flatMap((resource) => {
          const pool = change.resources?.[resource];
          return pool === undefined ? [] : [[resource, {
            before: pool.before, after: pool.after, delta: pool.delta,
          }]];
        }),
      ) }),
      ...(change.zone === undefined ? {} : { zone: { before: change.zone.before, after: change.zone.after } }),
      ...(change.combatState === undefined ? {} : { combatState: {
        before: change.combatState.before, after: change.combatState.after,
      } }),
      ...(change.activeEffects === undefined ? {} : { activeEffects: {
        applied: change.activeEffects.applied, removed: change.activeEffects.removed,
      } }),
    })),
  };
}

export function toEncounterPublicDto(dto: EncounterDto): EncounterPublicDto {
  return {
    result: encounterPublicResult(dto),
    encounterRef: dto.encounterRef,
    lifecycleStatus: dto.lifecycleStatus,
    stateVersion: dto.stateVersion,
    currentTick: dto.currentTick,
    stopReason: dto.stopReason,
    completionCandidate: dto.completionCandidate,
    participants: dto.participants.map((participant) => ({
      actorRef: participant.actorRef,
      bindingKind: participant.bindingKind,
      sideRef: participant.sideRef,
      combatState: participant.combatState,
      zone: participant.zone,
      resources: {
        hp: { ...participant.resources.hp },
        mana: { ...participant.resources.mana },
        sp: { ...participant.resources.sp },
      },
    })),
    nextRequiredAction: toPublicNextRequiredAction(dto.nextRequiredAction),
    ...(dto.transitionSummary === undefined ? {} : {
      transitionSummary: toPublicTransitionSummary(dto.transitionSummary),
    }),
  };
}
