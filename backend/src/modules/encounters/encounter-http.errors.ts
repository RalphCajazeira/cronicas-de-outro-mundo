import { AppError, NotFoundError } from '../../shared/errors/app-error.js';
import { EncounterError, type EncounterErrorCode } from './encounter.errors.js';

interface PublicErrorDefinition {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly recoveryAction?: string;
}

const definitions: Readonly<Record<EncounterErrorCode, PublicErrorDefinition>> = {
  ENCOUNTER_NOT_FOUND: { status: 404, code: 'ENCOUNTER_NOT_FOUND', message: 'Encounter was not found in the requested campaign', retryable: false },
  ENCOUNTER_ALREADY_OPEN: { status: 409, code: 'ENCOUNTER_ALREADY_OPEN', message: 'Campaign already has an open encounter', retryable: false, recoveryAction: 'load_encounter' },
  ENCOUNTER_LIFECYCLE_CONFLICT: { status: 409, code: 'ENCOUNTER_LIFECYCLE_CONFLICT', message: 'Encounter does not allow this operation in its current lifecycle', retryable: false, recoveryAction: 'load_encounter' },
  ENCOUNTER_EXPECTED_VERSION_CONFLICT: { status: 409, code: 'STATE_VERSION_CONFLICT', message: 'Encounter state version does not match', retryable: false, recoveryAction: 'load_encounter' },
  ENCOUNTER_IDEMPOTENCY_KEY_REUSED: { status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was reused with different input', retryable: false, recoveryAction: 'use_new_idempotency_key' },
  ENCOUNTER_CONSTRAINT_CONFLICT: { status: 409, code: 'PERSISTENCE_CONFLICT', message: 'Encounter persistence conflicts with current state', retryable: false, recoveryAction: 'load_encounter' },
  ENCOUNTER_PARTICIPANT_INVALID: { status: 422, code: 'PARTICIPANT_INVALID', message: 'One or more encounter participants are invalid for this campaign', retryable: false, recoveryAction: 'correct_request' },
  ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED: { status: 422, code: 'ACTION_REJECTED', message: 'Encounter action cannot mutate an ephemeral participant', retryable: false, recoveryAction: 'choose_new_intent' },
  ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE: { status: 422, code: 'SPATIAL_CONTEXT_UNAVAILABLE', message: 'Authoritative spatial context is unavailable for this action', retryable: false, recoveryAction: 'choose_new_intent' },
  ENCOUNTER_CORE_REJECTED: { status: 422, code: 'ACTION_REJECTED', message: 'Encounter action was rejected by the authoritative rules', retryable: false, recoveryAction: 'load_encounter' },
  ENCOUNTER_BEAT_ATOMIC_REJECTED: { status: 422, code: 'BEAT_REJECTED', message: 'Encounter beat was rejected and no component was persisted', retryable: false, recoveryAction: 'choose_new_intent' },
  ENCOUNTER_NPC_LIMIT_EXCEEDED: { status: 422, code: 'NPC_LIMIT_EXCEEDED', message: 'Encounter beat has more than four eligible NPCs', retryable: false, recoveryAction: 'choose_new_intent' },
  ENCOUNTER_TRANSACTION_RETRYABLE: { status: 503, code: 'TEMPORARY_UNAVAILABLE', message: 'Encounter operation is temporarily unavailable', retryable: true, recoveryAction: 'retry_same_request' },
  ENCOUNTER_SNAPSHOT_HASH_INVALID: integrity(),
  ENCOUNTER_SNAPSHOT_INVALID: integrity(),
  ENCOUNTER_DENORMALIZED_DRIFT: integrity(),
  ENCOUNTER_MECHANICS_DRIFT: integrity(),
  ENCOUNTER_RESOURCE_DRIFT: integrity(),
  ENCOUNTER_INVENTORY_DRIFT: integrity(),
  ENCOUNTER_EFFECTS_DRIFT: integrity(),
  ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT: integrity(),
  ENCOUNTER_EFFECT_ORIGIN_REQUIRED: integrity(),
  ENCOUNTER_CAMPAIGN_TICK_DRIFT: integrity(),
  ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING: integrity(),
  ENCOUNTER_ROLL_INVALID: integrity(),
  ENCOUNTER_INTERNAL: { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: false, recoveryAction: 'stop_encounter_flow' },
};

function integrity(): PublicErrorDefinition {
  return {
    status: 500,
    code: 'ENCOUNTER_INTEGRITY_ERROR',
    message: 'Encounter integrity validation failed',
    retryable: false,
    recoveryAction: 'stop_encounter_flow',
  };
}

function publicAppError(
  definition: PublicErrorDefinition,
  auditCode?: EncounterErrorCode,
  issues?: EncounterError['issues'],
): AppError {
  return new AppError(definition.status, definition.code, definition.message, {
    retryable: definition.retryable,
    ...(definition.recoveryAction === undefined ? {} : { recoveryAction: definition.recoveryAction }),
    ...(auditCode === undefined ? {} : { auditCode }),
    ...(issues === undefined ? {} : { issues }),
  });
}

export function mapEncounterHttpError(error: unknown): AppError {
  if (error instanceof EncounterError) {
    const definition = definitions[error.code];
    const npcRefs = error.code === 'ENCOUNTER_NPC_LIMIT_EXCEEDED'
      ? error.issues?.flatMap((issue) => {
        const actorRef = issue.path.startsWith('npc.') ? issue.path.slice(4) : '';
        return /^[a-z0-9][a-z0-9_-]{0,99}$/.test(actorRef) ? [actorRef] : [];
      }) ?? []
      : [];
    return publicAppError(
      npcRefs.length === 0 ? definition : {
        ...definition,
        message: `${definition.message}; none acted: ${npcRefs.join(', ')}`,
      },
      error.code,
      error.issues,
    );
  }
  if (error instanceof NotFoundError) {
    return new AppError(404, 'SCOPE_NOT_FOUND', 'Requested game scope was not found', { retryable: false });
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error', {
    retryable: false,
    recoveryAction: 'stop_encounter_flow',
  });
}
