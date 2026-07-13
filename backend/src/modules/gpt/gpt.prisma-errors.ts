import { isExpectedUniqueConflict } from '../../shared/database/prisma-errors.js';

export { isUniqueConflict } from '../../shared/database/prisma-errors.js';

export function isIdempotencyKeyConflict(error: unknown): boolean {
  return isExpectedUniqueConflict(error, {
    modelName: 'IdempotencyRecord', fields: ['key'], index: 'IdempotencyRecord_key_key', allowModelOnly: true,
  });
}

export type IdempotencyInspection =
  | { kind: 'replay'; response: Record<string, unknown> | Array<Record<string, unknown>> }
  | { kind: 'conflict'; reason: 'missing' | 'operation' | 'requestHash' | 'responsePending' };

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function inspectIdempotencyRecord(
  persisted: { operation: string; requestHash: string; response: unknown } | null,
  operation: string,
  requestHash: string,
): IdempotencyInspection {
  if (persisted === null) return { kind: 'conflict', reason: 'missing' };
  if (persisted.operation !== operation) return { kind: 'conflict', reason: 'operation' };
  if (persisted.requestHash !== requestHash) return { kind: 'conflict', reason: 'requestHash' };
  if (Array.isArray(persisted.response) && persisted.response.length > 0 && persisted.response.every(isNonEmptyRecord)) {
    return { kind: 'replay', response: persisted.response };
  }
  if (isNonEmptyRecord(persisted.response)) return { kind: 'replay', response: persisted.response };
  return { kind: 'conflict', reason: 'responsePending' };
}
