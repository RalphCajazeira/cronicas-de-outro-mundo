export type EncounterErrorCode =
  | 'ENCOUNTER_NOT_FOUND'
  | 'ENCOUNTER_ALREADY_OPEN'
  | 'ENCOUNTER_LIFECYCLE_CONFLICT'
  | 'ENCOUNTER_EXPECTED_VERSION_CONFLICT'
  | 'ENCOUNTER_SNAPSHOT_HASH_INVALID'
  | 'ENCOUNTER_SNAPSHOT_INVALID'
  | 'ENCOUNTER_DENORMALIZED_DRIFT'
  | 'ENCOUNTER_MECHANICS_DRIFT'
  | 'ENCOUNTER_RESOURCE_DRIFT'
  | 'ENCOUNTER_INVENTORY_DRIFT'
  | 'ENCOUNTER_EFFECTS_DRIFT'
  | 'ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT'
  | 'ENCOUNTER_EFFECT_ORIGIN_REQUIRED'
  | 'ENCOUNTER_CAMPAIGN_TICK_DRIFT'
  | 'ENCOUNTER_PARTICIPANT_INVALID'
  | 'ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED'
  | 'ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE'
  | 'ENCOUNTER_IDEMPOTENCY_KEY_REUSED'
  | 'ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING'
  | 'ENCOUNTER_ROLL_INVALID'
  | 'ENCOUNTER_CORE_REJECTED'
  | 'ENCOUNTER_CONSTRAINT_CONFLICT'
  | 'ENCOUNTER_TRANSACTION_RETRYABLE'
  | 'ENCOUNTER_INTERNAL';

const safeMessages: Readonly<Record<EncounterErrorCode, string>> = {
  ENCOUNTER_NOT_FOUND: 'Encounter was not found',
  ENCOUNTER_ALREADY_OPEN: 'Campaign already has an open encounter',
  ENCOUNTER_LIFECYCLE_CONFLICT: 'Encounter lifecycle does not allow this operation',
  ENCOUNTER_EXPECTED_VERSION_CONFLICT: 'Encounter state version conflict',
  ENCOUNTER_SNAPSHOT_HASH_INVALID: 'Encounter snapshot hash validation failed',
  ENCOUNTER_SNAPSHOT_INVALID: 'Encounter snapshot validation failed',
  ENCOUNTER_DENORMALIZED_DRIFT: 'Encounter denormalized state drift detected',
  ENCOUNTER_MECHANICS_DRIFT: 'Participant mechanics drift detected',
  ENCOUNTER_RESOURCE_DRIFT: 'Participant resource drift detected',
  ENCOUNTER_INVENTORY_DRIFT: 'Participant inventory drift detected',
  ENCOUNTER_EFFECTS_DRIFT: 'Participant effects drift detected',
  ENCOUNTER_EFFECT_OWNERSHIP_CONFLICT: 'Encounter effect ownership failed integrity validation',
  ENCOUNTER_EFFECT_ORIGIN_REQUIRED: 'Encounter effect origin failed integrity validation',
  ENCOUNTER_CAMPAIGN_TICK_DRIFT: 'Campaign engine tick drift detected',
  ENCOUNTER_PARTICIPANT_INVALID: 'Encounter participant validation failed',
  ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED: 'Ephemeral participant mutation is not persistable',
  ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE: 'Authoritative spatial context is unavailable',
  ENCOUNTER_IDEMPOTENCY_KEY_REUSED: 'Idempotency key was reused with different input',
  ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING: 'Idempotent operation has no confirmed response',
  ENCOUNTER_ROLL_INVALID: 'Backend roll validation failed',
  ENCOUNTER_CORE_REJECTED: 'Encounter core rejected the operation',
  ENCOUNTER_CONSTRAINT_CONFLICT: 'Encounter persistence constraint conflict',
  ENCOUNTER_TRANSACTION_RETRYABLE: 'Encounter transaction may be retried with the same idempotency key',
  ENCOUNTER_INTERNAL: 'Encounter operation failed',
};

export class EncounterError extends Error {
  readonly code: EncounterErrorCode;
  readonly retryable: boolean;

  constructor(code: EncounterErrorCode, options?: { readonly retryable?: boolean; readonly cause?: unknown }) {
    super(safeMessages[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EncounterError';
    this.code = code;
    this.retryable = options?.retryable ?? code === 'ENCOUNTER_TRANSACTION_RETRYABLE';
  }
}

export function encounterError(code: EncounterErrorCode, cause?: unknown): EncounterError {
  return new EncounterError(code, cause === undefined ? undefined : { cause });
}
