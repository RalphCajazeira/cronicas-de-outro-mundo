import { Prisma } from '../../generated/prisma/client.js';

function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

export function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function isIdempotencyKeyConflict(error: unknown): boolean {
  if (!isUniqueConflict(error)) return false;
  const metadata = error.meta;
  if (metadata === undefined || metadata === null || typeof metadata !== 'object') return false;
  const modelName = property(metadata, 'modelName');
  const target = property(metadata, 'target');
  if (Array.isArray(target)) {
    return (modelName === undefined || modelName === 'IdempotencyRecord') && target.length === 1 && target[0] === 'key';
  }

  const driverAdapterError = property(metadata, 'driverAdapterError');
  if (driverAdapterError === null || typeof driverAdapterError !== 'object') return false;
  const cause = property(driverAdapterError, 'cause');
  if (cause === null || typeof cause !== 'object' || property(cause, 'kind') !== 'UniqueConstraintViolation') return false;
  const constraint = property(cause, 'constraint');
  if (constraint !== null && typeof constraint === 'object') {
    const fields = property(constraint, 'fields');
    if (Array.isArray(fields)) return (modelName === undefined || modelName === 'IdempotencyRecord') && fields.length === 1 && fields[0] === 'key';
    const index = property(constraint, 'index');
    if (index !== undefined) return index === 'IdempotencyRecord_key_key' && (modelName === undefined || modelName === 'IdempotencyRecord');
  }
  // Prisma's pg adapter identifies the model and violation kind but may omit the target entirely.
  // executeIdempotent creates this model with a generated id, leaving only the unique public key as a possible P2002.
  return modelName === 'IdempotencyRecord';
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
