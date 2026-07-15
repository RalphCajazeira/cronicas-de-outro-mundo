import type { CampaignReference } from '../../shared/database/game-scope.js';
import type {
  CombatZone,
  CoreV1EncounterActionIntent,
  CoreV1EncounterParticipantInput,
  CoreV1EncounterParticipantRelation,
} from '../rules/core-v1/index.js';

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

export interface EncounterDto {
  readonly operation: EncounterOperationName | 'load';
  readonly encounterRef: string;
  readonly lifecycleStatus: string;
  readonly stateVersion: number;
  readonly currentTick: string;
  readonly stopReason: string | null;
  readonly completionCandidate: string | null;
  readonly participants: readonly EncounterParticipantDto[];
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

export function parseEncounterDto(value: unknown): EncounterDto {
  const root = closedRecord(value, [
    'operation', 'encounterRef', 'lifecycleStatus', 'stateVersion', 'currentTick',
    'stopReason', 'completionCandidate', 'participants',
  ], '$');
  if (!['create', 'submit_intent', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel', 'load']
    .includes(root.operation as string)
    || !isPublicRef(root.encounterRef) || !lifecycleStatuses.has(root.lifecycleStatus as string)
    || !Number.isSafeInteger(root.stateVersion) || (root.stateVersion as number) < 1
    || typeof root.currentTick !== 'string' || !/^(0|[1-9][0-9]*)$/.test(root.currentTick)
    || (root.stopReason !== null && !stopReasons.has(root.stopReason as string))
    || (root.completionCandidate !== null && !completionCandidates.has(root.completionCandidate as string))
    || !Array.isArray(root.participants) || root.participants.length > 64
    || Object.keys(root.participants).length !== root.participants.length) {
    throw new TypeError('Encounter DTO is invalid');
  }
  for (const [index, valueParticipant] of root.participants.entries()) {
    const participant = closedRecord(valueParticipant, [
      'actorRef', 'bindingKind', 'sideRef', 'combatState', 'zone', 'resources',
    ], `$.participants.${index}`);
    if (!isPublicRef(participant.actorRef)
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
  }
  return structuredClone(value) as EncounterDto;
}
