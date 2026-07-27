import { createHash } from 'node:crypto';
import {
  ActorControlPermission,
  ActorStatus,
  AuditDecision,
  CampaignStatus,
  GameSessionStatus,
  Prisma,
  UserStatus,
} from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors/app-error.js';
import { prisma } from '../../shared/database/prisma.js';
import { inspectIdempotencyRecord, isIdempotencyKeyConflict } from '../gpt/gpt.prisma-errors.js';
import { authenticatedSelectionRef } from '../authenticated-game-context/authenticated-selection-ref.js';
import { createPrismaAuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.repository.js';
import { assertActorsMutableOutsideEncounter } from '../encounters/encounter-authority-guard.js';
import { createAuditEventService } from '../audit/audit-event.service.js';
import { createPrismaAuditEventRepository } from '../audit/audit-event.repository.js';
import {
  authenticatedGameSessionSelectionResultSchema,
  authenticatedObservationResultSchema,
  type AuthenticatedGameSessionSelectionResult,
  type AuthenticatedObservationResult,
} from './authenticated-game-session.dto.js';
import type {
  AuthenticatedGameSessionAuditContext,
  AuthenticatedGameSessionRepository,
} from './authenticated-game-session.types.js';

const selectOperation = 'selectAuthenticatedGameContext:v1';
const observeOperation = 'performAuthenticatedObservation:v1';
const observationEventType = 'AUTHENTICATED_OBSERVATION';
const observationAuditEventType = 'AUTHENTICATED_GAME_ACTION';
const observationSummary = 'A observação dos arredores foi registrada. Nenhuma descoberta adicional foi confirmada.';
const transactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 30_000,
} as const;
const observedActionSummaryMaxLength = 220;

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
    message: 'A seleção não foi aplicada. Repita a solicitação com a mesma chave de segurança.',
  });
}

function observationResult(
  status: 'RESOLVED' | 'CONFLICT' | 'BLOCKED' | 'REJECTED',
  focus: string | undefined,
  summary: string,
  sessionVersion: number,
  canContinue: boolean,
  discoveredFacts: string[] = [],
  occurredAt?: Date,
): AuthenticatedObservationResult {
  const safeSummary = summary.length > observedActionSummaryMaxLength
    ? `${summary.slice(0, observedActionSummaryMaxLength - 1)}…`
    : summary;
  return authenticatedObservationResultSchema.parse({
    action: {
      type: 'OBSERVE',
      status,
      summary: safeSummary,
      focus: focus ?? null,
      occurredAt: (occurredAt ?? new Date()).toISOString(),
    },
    continuity: {
      sessionVersion,
      canContinue,
    },
    discoveredFacts,
  });
}

function buildSelectionResult(campaignStatus?: CampaignStatus): AuthenticatedGameSessionSelectionResult {
  return campaignStatus === CampaignStatus.ARCHIVED
    ? authenticatedGameSessionSelectionResultSchema.parse({
      status: 'REJECTED',
      previousSessionVersion: 0,
      sessionVersion: 0,
      selection: null,
      canContinue: false,
      recovery: 'SELECT_AGAIN',
      message: 'A campanha não está disponível no momento.',
    })
    : authenticatedGameSessionSelectionResultSchema.parse({
      status: 'REJECTED',
      previousSessionVersion: 0,
      sessionVersion: 0,
      selection: null,
      canContinue: false,
      recovery: 'SELECT_AGAIN',
      message: 'A seleção solicitada não está disponível para esta conta.',
    });
}

function buildSelectionConflict(
  existingSession: { stateVersion: number } | null,
): AuthenticatedGameSessionSelectionResult {
  return authenticatedGameSessionSelectionResultSchema.parse({
    status: 'CONFLICT',
    previousSessionVersion: existingSession?.stateVersion ?? 0,
    sessionVersion: existingSession?.stateVersion ?? 0,
    selection: null,
    canContinue: existingSession !== null,
    recovery: existingSession === null ? 'SELECT_AGAIN' : 'RELOAD_REQUIRED',
    message: existingSession === null
      ? 'A seleção não foi encontrada para recarga segura.'
      : 'A seleção mudou em outra aba ou conversa. Recarregue antes de confirmar.',
  });
}

function buildConflictFallback(baseSessionVersion: number): AuthenticatedObservationResult {
  return observationResult(
    'CONFLICT',
    undefined,
    'A sessão mudou em outra aba ou conversa. Recarregue e repita a observação.',
    baseSessionVersion,
    false,
    [],
  );
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

async function recordObservation(
  client: typeof prisma | Prisma.TransactionClient,
  userId: string,
  audit: AuthenticatedGameSessionAuditContext,
  input: {
    campaignId?: string;
    actorId?: string;
    gameSessionId?: string;
    requestId?: string;
    traceId?: string;
    allow: boolean;
    reasonCode: string;
    resultStatus: 'rejected' | 'blocked' | 'conflict' | 'resolved';
    previousStateVersion?: number;
    newStateVersion?: number;
  },
) {
  await createAuditEventService(createPrismaAuditEventRepository(client)).record({
    eventType: observationAuditEventType,
    userId,
    ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }),
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.gameSessionId === undefined ? {} : { gameSessionId: input.gameSessionId }),
    ...((input.requestId ?? audit.requestId) === undefined ? {} : { requestId: input.requestId ?? audit.requestId }),
    ...((input.traceId ?? audit.traceId) === undefined ? {} : { traceId: input.traceId ?? audit.traceId }),
    decision: input.allow ? AuditDecision.ALLOW : AuditDecision.DENY,
    reasonCode: input.reasonCode,
    source: audit.origin,
    metadata: {
      toolName: 'performAuthenticatedObservation',
      operation: 'observe',
      result: input.resultStatus,
      origin: audit.origin,
      ...(input.previousStateVersion === undefined ? {} : { previousStateVersion: input.previousStateVersion }),
      ...(input.newStateVersion === undefined ? {} : { newStateVersion: input.newStateVersion }),
    },
  });
}

export const prismaAuthenticatedGameSessionRepository: AuthenticatedGameSessionRepository = {
  async select(userId, input, audit) {
    const requestHash = hash([
      selectOperation,
      userId,
      input.campaignSelectionRef,
      input.characterSelectionRef,
      input.idempotencyKey,
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
          selectOperation,
          membership.campaignId,
          input.idempotencyKey,
        ])}`;
        const idempotency = await transaction.idempotencyRecord.create({
          data: {
            key: persistedKey,
            operation: selectOperation,
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
          result = buildSelectionConflict(existing);
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
        const inspection = inspectIdempotencyRecord(persisted, selectOperation, requestHash);
        if (inspection.kind === 'replay' && !Array.isArray(inspection.response)) {
          return authenticatedGameSessionSelectionResultSchema.parse(inspection.response);
        }
        return safeRetry();
      }
      const code = postgresCode(error);
      if (code === '40001' || code === '40P01' || code === 'P2034') return safeRetry();
      if (error instanceof Error && error.message === 'AUTHENTICATED_SELECTION_DENIED') {
        await recordDenied(userId, audit, 'resource_unavailable');
        return buildSelectionResult();
      }
      throw error;
    }
  },

  async observe(userId, input, audit) {
    const requestHash = hash([
      observeOperation,
      userId,
      input.idempotencyKey,
      String(input.baseSessionVersion),
      input.focus ?? '',
    ]);
    let persistedKey: string | undefined;
    let gameSessionId: string | undefined;

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
          throw new Error('AUTHENTICATED_OBSERVATION_DENIED');
        }

        const latestSession = (access.gameSessions ?? []).find(
          (session) => session.status === GameSessionStatus.ACTIVE,
        );
        if (latestSession === undefined) {
          await recordObservation(transaction, userId, audit, {
            allow: false,
            reasonCode: 'active_session_unavailable',
            resultStatus: 'rejected',
          });
          return observationResult(
            'REJECTED',
            input.focus,
            'A observação não pode ser executada sem uma sessão ativa.',
            0,
            false,
            [],
          );
        }
        gameSessionId = latestSession.id;

        const membership = access.campaignMemberships.find((candidate) => (
          candidate.campaignId === latestSession.campaignId
        ));
        const control = access.actorControls.find((candidate) => (
          candidate.actorId === latestSession.actorId
          && candidate.actor.campaignId === latestSession.campaignId
        ));
        if (membership === undefined
          || control === undefined
          || control.permission !== ActorControlPermission.CONTROL
          || control.actor.status !== ActorStatus.ACTIVE
          || membership.campaign.status === CampaignStatus.ARCHIVED) {
          await recordObservation(transaction, userId, audit, {
            campaignId: latestSession.campaignId,
            actorId: latestSession.actorId,
            gameSessionId: latestSession.id,
            allow: false,
            reasonCode: 'resource_unavailable',
            resultStatus: 'rejected',
            previousStateVersion: latestSession.stateVersion,
          });
          return observationResult(
            'REJECTED',
            input.focus,
            'A observação não está disponível para este personagem no momento.',
            latestSession.stateVersion,
            false,
            [],
          );
        }

        persistedKey = `authenticated-observation:${hash([
          userId,
          observeOperation,
          latestSession.campaignId,
          latestSession.actorId,
          input.idempotencyKey,
        ])}`;
        const idempotency = await transaction.idempotencyRecord.create({
          data: {
            key: persistedKey,
            operation: observeOperation,
            requestHash,
          },
          select: { id: true },
        });

        if (latestSession.stateVersion !== input.baseSessionVersion) {
          const result = buildConflictFallback(latestSession.stateVersion);
          await transaction.idempotencyRecord.update({
            where: { id: idempotency.id },
            data: { response: json(result) },
          });
          await recordObservation(transaction, userId, audit, {
            campaignId: latestSession.campaignId,
            actorId: latestSession.actorId,
            gameSessionId: latestSession.id,
            allow: false,
            reasonCode: 'stale_session_version',
            resultStatus: 'conflict',
            previousStateVersion: latestSession.stateVersion,
          });
          return result;
        }

        try {
          await assertActorsMutableOutsideEncounter(transaction, latestSession.campaignId, [{
            id: latestSession.actorId,
            code: latestSession.actorId,
          }]);
        } catch (error) {
          if (error instanceof AppError && error.code === 'ACTOR_ENCOUNTER_LOCKED') {
            const result = observationResult(
              'BLOCKED',
              input.focus,
              'A observação foi bloqueada por um encontro ativo. Finalize ou abandone o encontro e tente novamente.',
              latestSession.stateVersion,
              true,
            );
            await transaction.idempotencyRecord.update({
              where: { id: idempotency.id },
              data: { response: json(result) },
            });
            await recordObservation(transaction, userId, audit, {
              campaignId: latestSession.campaignId,
              actorId: latestSession.actorId,
              gameSessionId: latestSession.id,
              allow: false,
              reasonCode: 'active_encounter_lock',
              resultStatus: 'blocked',
              previousStateVersion: latestSession.stateVersion,
            });
            return result;
          }
          throw error;
        }

        const now = new Date();
        const updated = await transaction.gameSession.updateMany({
          where: {
            id: latestSession.id,
            status: GameSessionStatus.ACTIVE,
            stateVersion: input.baseSessionVersion,
          },
          data: {
            lastActiveAt: now,
            stateVersion: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          const current = await transaction.gameSession.findUnique({
            where: { id: latestSession.id },
            select: { stateVersion: true },
          });
          const result = buildConflictFallback(current?.stateVersion ?? input.baseSessionVersion);
          await transaction.idempotencyRecord.update({
            where: { id: idempotency.id },
            data: { response: json(result) },
          });
          await recordObservation(transaction, userId, audit, {
            campaignId: latestSession.campaignId,
            actorId: latestSession.actorId,
            gameSessionId: latestSession.id,
            allow: false,
            reasonCode: 'stale_session_version',
            resultStatus: 'conflict',
            previousStateVersion: current?.stateVersion ?? input.baseSessionVersion,
          });
          return result;
        }
        const sessionVersion = input.baseSessionVersion + 1;
        const event = await transaction.gameEvent.create({
          data: {
            campaignId: latestSession.campaignId,
            actorId: latestSession.actorId,
            eventType: observationEventType,
            title: 'Observação dos arredores',
            payload: json({
              gameSessionId: latestSession.id,
              action: {
                type: 'OBSERVE',
                focus: input.focus ?? null,
                summary: observationSummary,
              },
            }),
            idempotencyKey: persistedKey,
          },
          select: { createdAt: true },
        });
        const result = observationResult(
          'RESOLVED',
          input.focus,
          observationSummary,
          sessionVersion,
          true,
          [],
          event.createdAt,
        );
        await recordObservation(transaction, userId, audit, {
          campaignId: latestSession.campaignId,
          actorId: latestSession.actorId,
          gameSessionId: latestSession.id,
          allow: true,
          reasonCode: 'observation_recorded',
          resultStatus: 'resolved',
          previousStateVersion: latestSession.stateVersion,
          newStateVersion: sessionVersion,
        });
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
        const inspection = inspectIdempotencyRecord(persisted, observeOperation, requestHash);
        if (inspection.kind === 'replay' && !Array.isArray(inspection.response)) {
          return authenticatedObservationResultSchema.parse(inspection.response);
        }
        const current = gameSessionId === undefined ? null : await prisma.gameSession.findUnique({
          where: { id: gameSessionId },
          select: { stateVersion: true },
        });
        return buildConflictFallback(current?.stateVersion ?? input.baseSessionVersion);
      }
      const code = postgresCode(error);
      if (code === '40001' || code === '40P01' || code === 'P2034') {
        const current = gameSessionId === undefined ? null : await prisma.gameSession.findUnique({
          where: { id: gameSessionId },
          select: { stateVersion: true },
        });
        return buildConflictFallback(current?.stateVersion ?? input.baseSessionVersion);
      }
      if (error instanceof Error && error.message === 'AUTHENTICATED_OBSERVATION_DENIED') {
        await recordObservation(prisma, userId, audit, {
          allow: false,
          reasonCode: 'resource_unavailable',
          resultStatus: 'rejected',
        });
        return observationResult(
          'REJECTED',
          input.focus,
          'A observação não está disponível para esta conta.',
          input.baseSessionVersion,
          false,
          [],
        );
      }
      throw error;
    }
  },
};
