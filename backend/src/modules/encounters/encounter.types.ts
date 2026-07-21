import type { CampaignReference } from '../../shared/database/game-scope.js';
import { EncounterLifecycleStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type {
  CombatZone,
  CoreV1EncounterActionIntent,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterParticipantRelation,
} from '../rules/core-v1/index.js';
import {
  parseEncounterPublicConsequencesSummary,
  type EncounterPublicConsequencesSummaryV1,
} from './encounter-consequence.js';

export const ACTIVE_ENCOUNTER_LIFECYCLES = [
  EncounterLifecycleStatus.AWAITING_INTENT,
  EncounterLifecycleStatus.AWAITING_REACTION,
  EncounterLifecycleStatus.PROCESSING_PAUSED,
  EncounterLifecycleStatus.COMPLETION_PENDING,
] as const;

export interface ActiveEncounterRecord {
  readonly encounterRef: string;
  readonly lifecycleStatus: EncounterLifecycleStatus;
  readonly stateVersion: number;
}

export function activeEncounterSummary(records: readonly ActiveEncounterRecord[]) {
  if (records.length === 0) return null;
  if (records.length > 1) {
    throw new AppError(500, 'ACTIVE_ENCOUNTER_INTEGRITY_ERROR', 'Campaign has multiple active encounters', {
      retryable: false,
      recoveryAction: 'stop_encounter_flow',
      auditCode: 'MULTIPLE_ACTIVE_ENCOUNTERS',
      issues: [{
        path: 'activeEncounter',
        code: 'MULTIPLE_ACTIVE_ENCOUNTERS',
        message: 'Do not choose an encounter automatically; request administrative repair.',
      }],
    });
  }
  const encounter = records[0];
  if (encounter === undefined) throw new TypeError('Active encounter lookup returned an invalid result');
  return {
    encounterRef: encounter.encounterRef,
    lifecycleStatus: normalizeEnum(encounter.lifecycleStatus),
    stateVersion: encounter.stateVersion,
    canContinue: true,
    canCancel: true,
    recoveryAction: 'load_encounter',
  };
}

export type EncounterOperationName =
  | 'create' | 'submit_intent' | 'resolve_reaction' | 'continue'
  | 'confirm_completion' | 'cancel';

export interface EncounterPersistedParticipantInput {
  readonly bindingKind: 'persisted_actor';
  readonly actorRef: string;
  readonly sideRef: string;
  readonly zone: CombatZone;
  readonly surprised?: boolean;
}

export interface EncounterEphemeralParticipantInput {
  readonly bindingKind: 'ephemeral';
  readonly ephemeralKind: 'summon' | 'projection' | 'ephemeral_creature';
  readonly participant: Omit<CoreV1EncounterParticipantInput, 'actionSlots'>;
}

export interface CreateEncounterInput extends CampaignReference {
  readonly idempotencyKey: string;
  readonly encounterRef: string;
  readonly partySideRef?: string;
  readonly participants: readonly (EncounterPersistedParticipantInput | EncounterEphemeralParticipantInput)[];
  readonly relations: readonly CoreV1EncounterParticipantRelation[];
}

export interface EncounterReference extends CampaignReference {
  readonly encounterRef: string;
}

export interface EncounterMutationReference extends EncounterReference {
  readonly idempotencyKey: string;
  readonly expectedStateVersion: number;
}

export interface SubmitEncounterIntentInput extends EncounterMutationReference {
  readonly intent: CoreV1EncounterActionIntent;
}

export interface ResolveEncounterReactionInput extends EncounterMutationReference {
  readonly reactorActorRef: string;
  readonly reactionKind: 'block' | 'active_dodge' | 'interrupt' | 'counter_attack';
}

export type ContinueEncounterInput = EncounterMutationReference;
export type ConfirmEncounterCompletionInput = EncounterMutationReference;
export type CancelEncounterInput = EncounterMutationReference;
export type LoadEncounterInput = EncounterReference;

export interface EncounterParticipantDto {
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
}

export type EncounterNextRequiredActionDto =
  | { readonly type: 'submit_intent'; readonly actors: readonly { readonly actorRef: string; readonly readySlotRefs: readonly string[] }[] }
  | { readonly type: 'resolve_reaction'; readonly reactorRef: string; readonly reactionKind: 'block' | 'active_dodge' | 'interrupt' | 'counter_attack' }
  | { readonly type: 'continue' }
  | { readonly type: 'confirm_completion'; readonly completionCandidate: 'party_victory_candidate' | 'hostile_victory_candidate' | 'stalemate_candidate' | 'cancelled' }
  | { readonly type: 'none' };

export type EncounterTransitionCategory =
  | 'action_started' | 'action_resolved' | 'damage_applied' | 'resource_changed'
  | 'effect_applied' | 'effect_removed' | 'movement_resolved' | 'reaction_resolved'
  | 'participant_state_changed';

export interface EncounterTransitionSummaryDto {
  readonly processedEventCount: number;
  readonly events: readonly {
    readonly category: EncounterTransitionCategory;
    readonly actorRef?: string;
    readonly targetRef?: string;
  }[];
  readonly changes: readonly {
    readonly actorRef: string;
    readonly categories: readonly EncounterTransitionCategory[];
    readonly resources?: Partial<Readonly<Record<'hp' | 'mana' | 'sp', {
      readonly before: number;
      readonly after: number;
      readonly delta: number;
    }>>>;
    readonly zone?: { readonly before: string; readonly after: string };
    readonly combatState?: { readonly before: string; readonly after: string };
    readonly activeEffects?: { readonly applied: number; readonly removed: number };
  }[];
}

export interface EncounterDto {
  readonly operation: EncounterOperationName | 'load';
  readonly encounterRef: string;
  readonly lifecycleStatus: string;
  readonly stateVersion: number;
  readonly currentTick: string;
  readonly stopReason: string | null;
  readonly completionCandidate: string | null;
  readonly participants: readonly EncounterParticipantDto[];
  readonly nextRequiredAction: EncounterNextRequiredActionDto;
  readonly transitionSummary?: EncounterTransitionSummaryDto;
  readonly consequencesSummary?: EncounterPublicConsequencesSummaryV1;
}

const stableRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lifecycleStatuses = new Set([
  'awaiting_intent', 'awaiting_reaction', 'processing_paused', 'completion_pending',
  'completed', 'failed', 'cancelled',
]);
const stopReasons = new Set([
  'plan_completed', 'actor_incapacitated', 'hostile_became_ready', 'target_set_changed',
  'resource_below_required', 'zone_changed', 'new_threat_detected', 'state_version_changed',
  'processing_limit', 'no_valid_target', 'reaction_required', 'new_intent_required',
  'encounter_completed', 'encounter_failed',
]);
const completionCandidates = new Set([
  'party_victory_candidate', 'hostile_victory_candidate', 'stalemate_candidate', 'cancelled',
]);
const combatStates = new Set([
  'ready', 'preparing', 'casting', 'moving', 'recovering', 'incapacitated_candidate', 'removed',
]);
const zones = new Set(['engaged', 'near', 'medium', 'far', 'out_of_range']);

function isPublicRef(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 160
    && stableRefPattern.test(value) && !uuidPattern.test(value);
}

function closedRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  return value as Record<string, unknown>;
}

function closedOptionalRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  const keys = Object.keys(value);
  if (requiredKeys.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.includes(key))) {
    throw new TypeError(`${path} is not a closed encounter DTO`);
  }
  return value as Record<string, unknown>;
}

function parseNextRequiredAction(value: unknown, participantRefs: ReadonlySet<string>): EncounterNextRequiredActionDto {
  const base = closedOptionalRecord(value, ['type'], ['actors', 'reactorRef', 'reactionKind', 'completionCandidate'], '$.nextRequiredAction');
  if (base.type === 'submit_intent') {
    const action = closedRecord(value, ['type', 'actors'], '$.nextRequiredAction');
    if (!Array.isArray(action.actors) || action.actors.length < 1 || action.actors.length > 64
      || Object.keys(action.actors).length !== action.actors.length) {
      throw new TypeError('Encounter next action is invalid');
    }
    const actorRefs: string[] = [];
    for (const actorValue of action.actors) {
      const actor = closedRecord(actorValue, ['actorRef', 'readySlotRefs'], '$.nextRequiredAction.actors');
      if (!isPublicRef(actor.actorRef) || !participantRefs.has(actor.actorRef)
        || !Array.isArray(actor.readySlotRefs) || actor.readySlotRefs.length < 1 || actor.readySlotRefs.length > 16
        || Object.keys(actor.readySlotRefs).length !== actor.readySlotRefs.length
        || actor.readySlotRefs.some((ref) => !isPublicRef(ref))
        || new Set(actor.readySlotRefs).size !== actor.readySlotRefs.length
        || actor.readySlotRefs.some((ref, index, refs) => index > 0 && (refs[index - 1] as string) >= ref)) {
        throw new TypeError('Encounter next action is invalid');
      }
      actorRefs.push(actor.actorRef);
    }
    if (new Set(actorRefs).size !== actorRefs.length
      || actorRefs.some((ref, index) => index > 0 && (actorRefs[index - 1] as string).localeCompare(ref) >= 0)) {
      throw new TypeError('Encounter next action is invalid');
    }
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'resolve_reaction') {
    const action = closedRecord(value, ['type', 'reactorRef', 'reactionKind'], '$.nextRequiredAction');
    if (!isPublicRef(action.reactorRef) || !participantRefs.has(action.reactorRef)
      || !['block', 'active_dodge', 'interrupt', 'counter_attack'].includes(action.reactionKind as string)) {
      throw new TypeError('Encounter next action is invalid');
    }
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'confirm_completion') {
    const action = closedRecord(value, ['type', 'completionCandidate'], '$.nextRequiredAction');
    if (!completionCandidates.has(action.completionCandidate as string)) throw new TypeError('Encounter next action is invalid');
    return value as EncounterNextRequiredActionDto;
  }
  if (base.type === 'continue' || base.type === 'none') {
    closedRecord(value, ['type'], '$.nextRequiredAction');
    return value as EncounterNextRequiredActionDto;
  }
  throw new TypeError('Encounter next action is invalid');
}

const transitionCategories = new Set<EncounterTransitionCategory>([
  'action_started', 'action_resolved', 'damage_applied', 'resource_changed',
  'effect_applied', 'effect_removed', 'movement_resolved', 'reaction_resolved',
  'participant_state_changed',
]);

function parseTransitionSummary(value: unknown, participantRefs: ReadonlySet<string>): void {
  const summary = closedRecord(value, ['processedEventCount', 'events', 'changes'], '$.transitionSummary');
  if (!Number.isSafeInteger(summary.processedEventCount) || (summary.processedEventCount as number) < 1
    || (summary.processedEventCount as number) > 32 || !Array.isArray(summary.events)
    || summary.events.length !== summary.processedEventCount || summary.events.length > 32
    || Object.keys(summary.events).length !== summary.events.length
    || !Array.isArray(summary.changes) || summary.changes.length > 64
    || Object.keys(summary.changes).length !== summary.changes.length) {
    throw new TypeError('Encounter transition summary is invalid');
  }
  for (const eventValue of summary.events) {
    const event = closedOptionalRecord(eventValue, ['category'], ['actorRef', 'targetRef'], '$.transitionSummary.events');
    if (!transitionCategories.has(event.category as EncounterTransitionCategory)
      || (event.actorRef !== undefined && (!isPublicRef(event.actorRef) || !participantRefs.has(event.actorRef)))
      || (event.targetRef !== undefined && (!isPublicRef(event.targetRef) || !participantRefs.has(event.targetRef)))) {
      throw new TypeError('Encounter transition event is invalid');
    }
  }
  const changedActorRefs = new Set<string>();
  for (const changeValue of summary.changes) {
    const change = closedOptionalRecord(
      changeValue, ['actorRef', 'categories'], ['resources', 'zone', 'combatState', 'activeEffects'], '$.transitionSummary.changes',
    );
    if (!isPublicRef(change.actorRef) || !participantRefs.has(change.actorRef) || changedActorRefs.has(change.actorRef)
      || !Array.isArray(change.categories) || change.categories.length < 1
      || change.categories.length > transitionCategories.size
      || new Set(change.categories).size !== change.categories.length
      || change.categories.some((category) => !transitionCategories.has(category as EncounterTransitionCategory))) {
      throw new TypeError('Encounter transition change is invalid');
    }
    changedActorRefs.add(change.actorRef);
    if (change.resources !== undefined) {
      const resources = closedOptionalRecord(change.resources, [], ['hp', 'mana', 'sp'], '$.transitionSummary.changes.resources');
      if (Object.keys(resources).length === 0) throw new TypeError('Encounter transition resource change is invalid');
      for (const poolValue of Object.values(resources)) {
        const pool = closedRecord(poolValue, ['before', 'after', 'delta'], '$.transitionSummary.changes.resources.pool');
        if (![pool.before, pool.after, pool.delta].every((item) => Number.isSafeInteger(item))
          || (pool.before as number) < 0 || (pool.after as number) < 0
          || (pool.delta as number) !== (pool.after as number) - (pool.before as number)) {
          throw new TypeError('Encounter transition resource change is invalid');
        }
      }
    }
    for (const field of ['zone', 'combatState'] as const) {
      if (change[field] === undefined) continue;
      const transition = closedRecord(change[field], ['before', 'after'], `$.transitionSummary.changes.${field}`);
      const allowed = field === 'zone' ? zones : combatStates;
      if (!allowed.has(transition.before as string) || !allowed.has(transition.after as string)) {
        throw new TypeError(`Encounter transition ${field} change is invalid`);
      }
    }
    if (change.activeEffects !== undefined) {
      const effects = closedRecord(change.activeEffects, ['applied', 'removed'], '$.transitionSummary.changes.activeEffects');
      if (![effects.applied, effects.removed].every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) {
        throw new TypeError('Encounter transition active effects change is invalid');
      }
    }
  }
}

export function parseEncounterDto(value: unknown): EncounterDto {
  const root = closedOptionalRecord(value, [
    'operation', 'encounterRef', 'lifecycleStatus', 'stateVersion', 'currentTick',
    'stopReason', 'completionCandidate', 'participants', 'nextRequiredAction',
  ], ['transitionSummary', 'consequencesSummary'], '$');
  if (!['create', 'submit_intent', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel', 'load']
    .includes(root.operation as string)
    || !isPublicRef(root.encounterRef) || !lifecycleStatuses.has(root.lifecycleStatus as string)
    || !Number.isSafeInteger(root.stateVersion) || (root.stateVersion as number) < 1
    || typeof root.currentTick !== 'string' || !/^(0|[1-9][0-9]*)$/.test(root.currentTick)
    || (root.stopReason !== null && !stopReasons.has(root.stopReason as string))
    || (root.completionCandidate !== null && !completionCandidates.has(root.completionCandidate as string))
    || !Array.isArray(root.participants) || root.participants.length < 1 || root.participants.length > 64
    || Object.keys(root.participants).length !== root.participants.length) {
    throw new TypeError('Encounter DTO is invalid');
  }
  const participantRefs = new Set<string>();
  for (const [index, valueParticipant] of root.participants.entries()) {
    const participant = closedRecord(valueParticipant, [
      'actorRef', 'bindingKind', 'sideRef', 'combatState', 'zone', 'resources',
    ], `$.participants.${index}`);
    if (!isPublicRef(participant.actorRef) || participantRefs.has(participant.actorRef)
      || !['persisted_actor', 'ephemeral'].includes(participant.bindingKind as string)
      || !isPublicRef(participant.sideRef) || !combatStates.has(participant.combatState as string)
      || !zones.has(participant.zone as string)) throw new TypeError('Encounter participant DTO is invalid');
    const resources = closedRecord(participant.resources, ['hp', 'mana', 'sp'], `$.participants.${index}.resources`);
    for (const resource of ['hp', 'mana', 'sp']) {
      const pool = closedRecord(resources[resource], ['current', 'maximum'], `$.participants.${index}.resources.${resource}`);
      if (!Number.isSafeInteger(pool.current) || !Number.isSafeInteger(pool.maximum)
        || (pool.current as number) < 0 || (pool.maximum as number) < 0
        || (pool.current as number) > (pool.maximum as number)) {
        throw new TypeError('Encounter resource DTO is invalid');
      }
    }
    participantRefs.add(participant.actorRef);
  }
  const nextRequiredAction = parseNextRequiredAction(root.nextRequiredAction, participantRefs);
  const nextActionByLifecycle: Readonly<Record<string, EncounterNextRequiredActionDto['type']>> = {
    awaiting_intent: 'submit_intent', awaiting_reaction: 'resolve_reaction', processing_paused: 'continue',
    completion_pending: 'confirm_completion', completed: 'none', failed: 'none', cancelled: 'none',
  };
  const expectedNextAction = nextActionByLifecycle[root.lifecycleStatus as string];
  if (nextRequiredAction.type !== expectedNextAction
    || (nextRequiredAction.type === 'confirm_completion'
      && nextRequiredAction.completionCandidate !== root.completionCandidate)) {
    throw new TypeError('Encounter next action does not match lifecycle');
  }
  if (root.transitionSummary !== undefined) {
    if (!['submit_intent', 'resolve_reaction', 'continue'].includes(root.operation as string)) {
      throw new TypeError('Encounter transition summary does not match operation');
    }
    parseTransitionSummary(root.transitionSummary, participantRefs);
  }
  if (root.consequencesSummary !== undefined) {
    if (!['completed', 'cancelled'].includes(root.lifecycleStatus as string)) {
      throw new TypeError('Encounter consequences require a terminal lifecycle');
    }
    const consequences = parseEncounterPublicConsequencesSummary(root.consequencesSummary, participantRefs);
    const expectedOutcome = root.lifecycleStatus === 'cancelled' ? 'cancelled' : {
      party_victory_candidate: 'party_victory',
      hostile_victory_candidate: 'party_defeat',
      stalemate_candidate: 'stalemate',
    }[root.completionCandidate as string];
    if (consequences.outcome !== expectedOutcome) {
      throw new TypeError('Encounter consequences do not match completion state');
    }
  }
  return structuredClone(value) as EncounterDto;
}
