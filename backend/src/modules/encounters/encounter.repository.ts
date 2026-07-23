import { createHash } from 'node:crypto';
import {
  Prisma,
  type EncounterOperationKind,
  type EncounterStopReason,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict } from '../gpt/gpt.prisma-errors.js';
import { observeOperationStage } from '../../shared/observability/operation-observability.js';
import { canonicalEncounterMechanicalJson } from './encounter-mechanical-json.js';
import { parseEncounterDto, type EncounterDto } from './encounter.types.js';
import { EncounterError } from './encounter.errors.js';

export type EncounterTransaction = Prisma.TransactionClient;
export type EncounterDatabase = typeof prisma;

export const ENCOUNTER_TRANSACTION_OPTIONS = { maxWait: 5_000, timeout: 30_000 } as const;

export function calculateEncounterRequestHash(value: unknown): string {
  return createHash('sha256').update(canonicalEncounterMechanicalJson(value)).digest('hex');
}

export function absentEncounterStateHash(): string {
  return calculateEncounterRequestHash({ schemaVersion: 1, state: 'absent' });
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

export function isRetryableEncounterTransactionError(error: unknown): boolean {
  const code = encounterPostgresCode(error);
  return code === '40P01' || code === '40001';
}

export function encounterPostgresCode(error: unknown): string | undefined {
  const candidates = [
    property(property(property(error, 'meta'), 'driverAdapterError'), 'cause'),
    property(property(error, 'cause'), 'cause'),
    property(error, 'cause'),
    property(property(error, 'meta'), 'driverAdapterError'),
    property(error, 'meta'),
    error,
  ];
  for (const candidate of candidates) {
    for (const key of ['originalCode', 'code']) {
      const value = property(candidate, key);
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

export function encounterPostgresMessage(error: unknown): string | undefined {
  const candidates = [
    property(property(property(error, 'meta'), 'driverAdapterError'), 'cause'),
    property(property(error, 'cause'), 'cause'),
    property(error, 'cause'),
    property(property(error, 'meta'), 'driverAdapterError'),
    error,
  ];
  for (const candidate of candidates) {
    for (const key of ['originalMessage', 'message']) {
      const value = property(candidate, key);
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

export async function executeIdempotentEncounter(
  database: EncounterDatabase,
  key: string,
  operation: string,
  input: unknown,
  work: (transaction: EncounterTransaction, idempotencyRecordId: string, requestHash: string) => Promise<EncounterDto>,
): Promise<EncounterDto> {
  const requestHash = calculateEncounterRequestHash(input);
  const persistedKey = `encounter:${key}`;
  try {
    return await observeOperationStage('encounter_transaction', () => database.$transaction(async (transaction) => {
      const record = await transaction.idempotencyRecord.create({
        data: { key: persistedKey, operation, requestHash },
        select: { id: true },
      });
      const response = await work(transaction, record.id, requestHash);
      await transaction.idempotencyRecord.update({
        where: { id: record.id },
        data: { response: json(response) },
      });
      return response;
    }, ENCOUNTER_TRANSACTION_OPTIONS));
  } catch (error) {
    if (isRetryableEncounterTransactionError(error)) {
      throw new EncounterError('ENCOUNTER_TRANSACTION_RETRYABLE', { retryable: true, cause: error });
    }
    if (!isIdempotencyKeyConflict(error)) throw error;
    const persisted = await database.idempotencyRecord.findUnique({
      where: { key: persistedKey },
      select: { operation: true, requestHash: true, response: true },
    });
    const inspection = inspectIdempotencyRecord(persisted, operation, requestHash);
    if (inspection.kind === 'replay' && !Array.isArray(inspection.response)) {
      try {
        return parseEncounterDto(inspection.response);
      } catch (error) {
        throw new EncounterError('ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING', { cause: error });
      }
    }
    throw new EncounterError(
      inspection.kind === 'conflict' && inspection.reason === 'responsePending'
        ? 'ENCOUNTER_IDEMPOTENCY_RESPONSE_PENDING'
        : 'ENCOUNTER_IDEMPOTENCY_KEY_REUSED',
      { cause: error },
    );
  }
}

export async function lockCampaign(transaction: EncounterTransaction, campaignId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Campaign" WHERE "id" = ${campaignId}::uuid FOR UPDATE
  `);
}

export async function lockEncounter(transaction: EncounterTransaction, encounterId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "Encounter" WHERE "id" = ${encounterId}::uuid FOR UPDATE
  `);
}

export async function lockEncounterAuthorities(
  transaction: EncounterTransaction,
  encounterId: string,
  actorIds: readonly string[],
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id" FROM "EncounterParticipant"
    WHERE "encounterId" = ${encounterId}::uuid ORDER BY "actorRef" ASC FOR UPDATE
  `);
  await lockActorAuthorities(transaction, actorIds);
}

export async function lockActorAuthorities(
  transaction: EncounterTransaction,
  actorIds: readonly string[],
): Promise<void> {
  const orderedActorIds = [...new Set(actorIds)].sort();
  for (const actorId of orderedActorIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "Actor" WHERE "id" = ${actorId}::uuid FOR UPDATE
    `);
  }
  for (const actorId of orderedActorIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "ActorResource" WHERE "actorId" = ${actorId}::uuid
      ORDER BY "type" ASC FOR UPDATE
    `);
  }
  for (const actorId of orderedActorIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "InventoryEntry" WHERE "actorId" = ${actorId}::uuid
      ORDER BY "entryRef" ASC FOR UPDATE
    `);
  }
  for (const actorId of orderedActorIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "ActorEquipmentSlot" WHERE "actorId" = ${actorId}::uuid
      ORDER BY "slotRef" ASC FOR UPDATE
    `);
  }
  for (const actorId of orderedActorIds) {
    await transaction.$queryRaw(Prisma.sql`
      SELECT "id" FROM "ActiveEffect" WHERE "targetActorId" = ${actorId}::uuid
      ORDER BY "effectRef" ASC FOR UPDATE
    `);
  }
}

export async function createEncounterOperation(
  transaction: EncounterTransaction,
  input: {
    readonly encounterId: string;
    readonly idempotencyRecordId: string;
    readonly operation: EncounterOperationKind;
    readonly previousStateVersion: number;
    readonly nextStateVersion: number;
    readonly inputHash: string;
    readonly beforeStateHash: string;
    readonly afterStateHash: string;
    readonly stopReason: EncounterStopReason | null;
    readonly resultSummary: Prisma.InputJsonValue;
  },
) {
  return transaction.encounterOperation.create({ data: input });
}
