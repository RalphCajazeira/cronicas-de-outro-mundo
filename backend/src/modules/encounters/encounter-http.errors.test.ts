import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { EncounterError, type EncounterErrorCode } from './encounter.errors.js';
import { mapEncounterHttpError } from './encounter-http.errors.js';

const cases: Array<[EncounterErrorCode, number, string, boolean]> = [
  ['ENCOUNTER_NOT_FOUND', 404, 'ENCOUNTER_NOT_FOUND', false],
  ['ENCOUNTER_ALREADY_OPEN', 409, 'ENCOUNTER_ALREADY_OPEN', false],
  ['ENCOUNTER_LIFECYCLE_CONFLICT', 409, 'ENCOUNTER_LIFECYCLE_CONFLICT', false],
  ['ENCOUNTER_EXPECTED_VERSION_CONFLICT', 409, 'STATE_VERSION_CONFLICT', false],
  ['ENCOUNTER_IDEMPOTENCY_KEY_REUSED', 409, 'IDEMPOTENCY_KEY_REUSED', false],
  ['ENCOUNTER_CONSTRAINT_CONFLICT', 409, 'PERSISTENCE_CONFLICT', false],
  ['ENCOUNTER_PARTICIPANT_INVALID', 422, 'PARTICIPANT_INVALID', false],
  ['ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED', 422, 'ACTION_REJECTED', false],
  ['ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE', 422, 'SPATIAL_CONTEXT_UNAVAILABLE', false],
  ['ENCOUNTER_CORE_REJECTED', 422, 'ACTION_REJECTED', false],
  ['ENCOUNTER_TRANSACTION_RETRYABLE', 503, 'TEMPORARY_UNAVAILABLE', true],
  ...([
    'ENCOUNTER_SNAPSHOT_HASH_INVALID', 'ENCOUNTER_SNAPSHOT_INVALID', 'ENCOUNTER_DENORMALIZED_DRIFT',
    'ENCOUNTER_MECHANICS_DRIFT', 'ENCOUNTER_RESOURCE_DRIFT', 'ENCOUNTER_INVENTORY_DRIFT',
    'ENCOUNTER_EFFECTS_DRIFT', 'ENCOUNTER_CAMPAIGN_TICK_DRIFT', 'ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING',
    'ENCOUNTER_ROLL_INVALID',
  ] as EncounterErrorCode[]).map((code): [EncounterErrorCode, number, string, boolean] => [code, 500, 'ENCOUNTER_INTEGRITY_ERROR', false]),
  ['ENCOUNTER_INTERNAL', 500, 'INTERNAL_ERROR', false],
];

describe('encounter HTTP error mapper', () => {
  it.each(cases)('maps %s to a sanitized public error', (internal, status, code, retryable) => {
    const mapped = mapEncounterHttpError(new EncounterError(internal, { cause: new Error('postgresql://secret Prisma SQL') }));
    expect(mapped).toMatchObject({ statusCode: status, code, retryable });
    expect(mapped.auditCode).toBe(internal);
    expect(JSON.stringify(mapped)).not.toMatch(/postgres|secret|Prisma|SQL/);
  });

  it('collapses every missing Player/World/Campaign scope to one public code', () => {
    expect(mapEncounterHttpError(new NotFoundError('Player'))).toMatchObject({ statusCode: 404, code: 'SCOPE_NOT_FOUND', retryable: false });
    expect(mapEncounterHttpError(new NotFoundError('Campaign')).message).not.toContain('Campaign');
  });

  it('sanitizes unknown errors', () => {
    const mapped = mapEncounterHttpError(new Error('stack SQL secret'));
    expect(mapped).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR', retryable: false });
    expect(mapped.message).toBe('Internal server error');
  });

  it('uses the approved recovery action for an incompatible idempotency-key reuse', () => {
    expect(mapEncounterHttpError(new EncounterError('ENCOUNTER_IDEMPOTENCY_KEY_REUSED')))
      .toMatchObject({ recoveryAction: 'use_new_idempotency_key' });
  });
});
