import { createHash } from 'node:crypto';
import {
  ActorStatus,
  AuditDecision,
  CampaignStatus,
  GameSessionStatus,
  Prisma,
  UserStatus,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict } from '../gpt/gpt.prisma-errors.js';
import { authenticatedSelectionRef } from '../authenticated-game-context/authenticated-selection-ref.js';
import { createPrismaAuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.repository.js';
import { createAuditEventService } from '../audit/audit-event.service.js';
import { createPrismaAuditEventRepository } from '../audit/audit-event.repository.js';
import {
  authenticatedGameSessionSelectionResultSchema,
  type AuthenticatedGameSessionSelectionResult,
} from './authenticated-game-session.dto.js';
import type {
  AuthenticatedGameSessionAuditContext,
  AuthenticatedGameSessionRepository,
} from './authenticated-game-session.types.js';

const operation = 'selectAuthenticatedGameContext:v1';
const transactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 30_000,
} as const;

function hash(parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part).update('\0');
  return digest.digest('hex');
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function postgresCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return cause === error ? undefined : postgresCode(cause);
}

function safeRetry(): AuthenticatedGameSessionSelectionResult {
  return authenticatedGameSessionSelectionResultSchema.parse({
    status: 'SAFE_RETRY',
    previousSessionVersion: 0,
    sessionVersion: 0,
    selection: null,
    canContinue: false,
    recovery: 'SAFE_RETRY',
    message: 'A seleção não foi aplicada. Repita a mesma solicitação com segurança.',
  });
}

async function recordDenied(
  userId: string,
  audit: AuthenticatedGameSessionAuditContext,
  reasonCode: string,
): Promise<void> {
  await createAuditEventService(createPrismaAuditEventRepository(prisma)).record({
      eventType: 'AUTHENTICATED_GAME_CONTEXT_SELECTION',
      userId,
      decision: AuditDecision.DENY,
      reasonCode,
      source: audit.origin,
      ...(audit.requestId === undefined ? {} : { requestId: audit.requestId }),
      ...(audit.traceId === undefined ? {} : { traceId: audit.traceId }),
      metadata: {
        toolName: 'selectAuthenticatedGameContext',
        operation: 'select',
        result: 'rejected',
        origin: audit.origin,
      },
  });
}

export const prismaAuthenticatedGameSessionRepository: AuthenticatedGameSessionRepository = {
  async select(userId, input, audit) {
    const requestHash = hash([
      operation,
      userId,
      input.campaignSelectionRef,
      input.characterSelectionRef,
      String(input.baseSessionVersion),
    ]);
    let persistedKey: string | undefined;

    try {
      return await prisma.$transaction(async (transaction) => {
        const access = await createPrismaAuthenticatedGameContextRepository(transaction)
          .findGameAccessByUserId(userId);
        if (access === null
          || access.id !== userId
          || access.status !== UserStatus.ACTIVE
          || access.suspendedAt !== null
          || access.deletedAt !== null
          || access.player === null) {
          throw new Error('AUTHENTICATED_SELECTION_DENIED');
        }

        const membership = access.campaignMemberships.find((candidate) => (
          authenticatedSelectionRef('campaign', userId, candidate.campaignId)
          === input.campaignSelectionRef
        ));
        const control = access.actorControls.find((candidate) => (
          authenticatedSelectionRef('character', userId, candidate.actorId)
          === input.characterSelectionRef
        ));
        if (membership === undefined
          || control === undefined
          || control.actor.campaignId !== membership.campaignId
          || control.actor.status !== ActorStatus.ACTIVE
          || membership.campaign.status === CampaignStatus.ARCHIVED) {
          throw new Error('AUTHENTICATED_SELECTION_DENIED');
        }

        persistedKey = `authenticated-session:${hash([
          userId,
          operation,
          membership.campaignId,
          input.idempotencyKey,
        ])}`;
        const idempotency = await transaction.idempotencyRecord.create({
          data: {
            key: persistedKey,
            operation,
            requestHash,
          },
          select: { id: true },
        });

        const existing = await transaction.gameSession.findUnique({
          where: {
            userId_campaignId: {
              userId,
              campaignId: membership.campaignId,
            },
          },
          select: {
            id: true,
            stateVersion: true,
          },
        });
        const previousSessionVersion = existing?.stateVersion ?? 0;
        let result: AuthenticatedGameSessionSelectionResult;

        if (previousSessionVersion !== input.baseSessionVersion) {
          result = authenticatedGameSessionSelectionResultSchema.parse({
            status: 'CONFLICT',
            previousSessionVersion,
            sessionVersion: previousSessionVersion,
            selection: null,
            canContinue: existing !== null,
            recovery: 'RELOAD_REQUIRED',
            message: 'A seleção mudou em outra aba ou conversa. Recarregue antes de confirmar.',
          });
          await createAuditEventService(createPrismaAuditEventRepository(transaction)).record({
              eventType: 'AUTHENTICATED_GAME_CONTEXT_SELECTION',
              userId,
              campaignId: membership.campaignId,
              actorId: control.actorId,
              ...(existing === null ? {} : { gameSessionId: existing.id }),
              ...(audit.requestId === undefined ? {} : { requestId: audit.requestId }),
              ...(audit.traceId === undefined ? {} : { traceId: audit.traceId }),
              decision: AuditDecision.DENY,
              reasonCode: 'stale_session_version',
              source: audit.origin,
              metadata: {
                toolName: 'selectAuthenticatedGameContext',
                operation: 'select',
                result: 'conflict',
                origin: audit.origin,
                previousStateVersion: previousSessionVersion,
                newStateVersion: previousSessionVersion,
                idempotencyFingerprint: hash([input.idempotencyKey]).slice(0, 16),
              },
          });
        } else {
          const now = new Date();
          const session = existing === null
            ? await transaction.gameSession.create({
              data: {
                userId,
                campaignId: membership.campaignId,
                actorId: control.actorId,
                status: GameSessionStatus.ACTIVE,
                stateVersion: 1,
                lastActiveAt: now,
              },
              select: { id: true, stateVersion: true },
            })
            : await transaction.gameSession.update({
              where: { id: existing.id },
              data: {
                actorId: control.actorId,
                status: GameSessionStatus.ACTIVE,
                closedAt: null,
                lastActiveAt: now,
                stateVersion: { increment: 1 },
              },
              select: { id: true, stateVersion: true },
            });
          result = authenticatedGameSessionSelectionResultSchema.parse({
            status: 'SUCCESS',
            previousSessionVersion,
            sessionVersion: session.stateVersion,
            selection: {
              campaignSelectionRef: input.campaignSelectionRef,
              characterSelectionRef: input.characterSelectionRef,
            },
            canContinue: true,
            recovery: 'NONE',
            message: 'Campanha e personagem salvos para continuar depois.',
          });
          await createAuditEventService(createPrismaAuditEventRepository(transaction)).record({
              eventType: 'AUTHENTICATED_GAME_CONTEXT_SELECTION',
              userId,
              campaignId: membership.campaignId,
              actorId: control.actorId,
              gameSessionId: session.id,
              ...(audit.requestId === undefined ? {} : { requestId: audit.requestId }),
              ...(audit.traceId === undefined ? {} : { traceId: audit.traceId }),
              decision: AuditDecision.ALLOW,
              reasonCode: existing === null ? 'session_created' : 'session_updated',
              source: audit.origin,
              metadata: {
                toolName: 'selectAuthenticatedGameContext',
                operation: 'select',
                result: 'success',
                origin: audit.origin,
                previousStateVersion: previousSessionVersion,
                newStateVersion: session.stateVersion,
                idempotencyFingerprint: hash([input.idempotencyKey]).slice(0, 16),
              },
          });
        }

        await transaction.idempotencyRecord.update({
          where: { id: idempotency.id },
          data: { response: json(result) },
        });
        return result;
      }, transactionOptions);
    } catch (error) {
      if (persistedKey !== undefined && isIdempotencyKeyConflict(error)) {
        const persisted = await prisma.idempotencyRecord.findUnique({
          where: { key: persistedKey },
          select: { operation: true, requestHash: true, response: true },
        });
        const inspection = inspectIdempotencyRecord(persisted, operation, requestHash);
        if (inspection.kind === 'replay' && !Array.isArray(inspection.response)) {
          return authenticatedGameSessionSelectionResultSchema.parse(inspection.response);
        }
        return authenticatedGameSessionSelectionResultSchema.parse({
          status: 'CONFLICT',
          previousSessionVersion: input.baseSessionVersion,
          sessionVersion: input.baseSessionVersion,
          selection: null,
          canContinue: input.baseSessionVersion > 0,
          recovery: 'RELOAD_REQUIRED',
          message: 'A chave de repetição já foi usada com outra seleção.',
        });
      }
      const code = postgresCode(error);
      if (code === '40001' || code === '40P01' || code === 'P2034') return safeRetry();
      if (error instanceof Error && error.message === 'AUTHENTICATED_SELECTION_DENIED') {
        await recordDenied(userId, audit, 'resource_unavailable');
        return authenticatedGameSessionSelectionResultSchema.parse({
          status: 'REJECTED',
          previousSessionVersion: 0,
          sessionVersion: 0,
          selection: null,
          canContinue: false,
          recovery: 'SELECT_AGAIN',
          message: 'A seleção solicitada não está disponível para esta conta.',
        });
      }
      throw error;
    }
  },
};
