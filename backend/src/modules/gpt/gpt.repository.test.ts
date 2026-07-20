import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict } from './gpt.prisma-errors.js';
import { IDEMPOTENT_TRANSACTION_OPTIONS } from './gpt.start-game.js';

function uniqueError(modelName: string, target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: { modelName, target },
  });
}

function adapterUniqueError(fields: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: {
      driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { fields } } },
    },
  });
}

function adapterIndexError(index: string) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: {
      driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index } } },
    },
  });
}

function adapterModelError(modelName: string) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: {
      modelName, driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } },
    },
  });
}

function targetOnlyError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: { target },
  });
}

describe('GPT repository unique conflicts', () => {
  it('allows bounded idempotent transactions to persist the complete structured game start', () => {
    expect(IDEMPOTENT_TRANSACTION_OPTIONS).toEqual({ maxWait: 5_000, timeout: 60_000 });
  });

  it('recognizes only the structured IdempotencyRecord.key target as an idempotent retry', () => {
    expect(isIdempotencyKeyConflict(uniqueError('IdempotencyRecord', ['key']))).toBe(true);
    expect(isIdempotencyKeyConflict(adapterUniqueError(['key']))).toBe(true);
    expect(isIdempotencyKeyConflict(adapterModelError('IdempotencyRecord'))).toBe(true);
    expect(isIdempotencyKeyConflict(adapterModelError('Campaign'))).toBe(false);
    expect(isIdempotencyKeyConflict(targetOnlyError(['key']))).toBe(true);
    expect(isIdempotencyKeyConflict(targetOnlyError(['worldId', 'code']))).toBe(false);
    expect(isIdempotencyKeyConflict(adapterIndexError('IdempotencyRecord_key_key'))).toBe(true);
    expect(isIdempotencyKeyConflict(adapterIndexError('Campaign_worldId_code_key'))).toBe(false);
    expect(isIdempotencyKeyConflict(adapterUniqueError(['worldId', 'code']))).toBe(false);
    expect(isIdempotencyKeyConflict(uniqueError('Campaign', ['worldId', 'code']))).toBe(false);
    expect(isIdempotencyKeyConflict(uniqueError('ContentDefinition', ['worldId', 'contentType', 'code']))).toBe(false);
    expect(isIdempotencyKeyConflict(uniqueError('ActorContent', ['actorId', 'contentDefinitionId']))).toBe(false);
    expect(isIdempotencyKeyConflict(uniqueError('IdempotencyRecord', ['operation']))).toBe(false);
    expect(isIdempotencyKeyConflict(new Error('P2002 IdempotencyRecord key'))).toBe(false);
  });

  it('replays only a complete record with matching operation and request hash', () => {
    const complete = { operation: 'game.start', requestHash: 'same-hash', response: { campaign: { ref: 'campaign' } } };
    expect(inspectIdempotencyRecord(null, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'missing' });
    expect(inspectIdempotencyRecord({ ...complete, operation: 'events.create' }, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'operation' });
    expect(inspectIdempotencyRecord({ ...complete, requestHash: 'other-hash' }, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'requestHash' });
    expect(inspectIdempotencyRecord({ ...complete, response: {} }, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'responsePending' });
    expect(inspectIdempotencyRecord({ ...complete, response: [] }, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'responsePending' });
    expect(inspectIdempotencyRecord({ ...complete, response: [null] }, 'game.start', 'same-hash')).toEqual({ kind: 'conflict', reason: 'responsePending' });
    expect(inspectIdempotencyRecord(complete, 'game.start', 'same-hash')).toEqual({ kind: 'replay', response: complete.response });
  });
});
