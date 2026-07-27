import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  GameSessionStatus,
  UserStatus,
} from '../../src/generated/prisma/client.js';
import { prisma } from '../../src/shared/database/prisma.js';
import { authenticatedSelectionRef } from '../../src/modules/authenticated-game-context/authenticated-selection-ref.js';
import { createAuthenticatedGameContextService } from '../../src/modules/authenticated-game-context/authenticated-game-context.service.js';
import { prismaAuthenticatedGameContextRepository } from '../../src/modules/authenticated-game-context/authenticated-game-context.repository.js';
import { prismaAuthenticatedGameSessionRepository } from '../../src/modules/authenticated-game-session/authenticated-game-session.repository.js';
import { createAuthenticatedGameSessionService } from '../../src/modules/authenticated-game-session/authenticated-game-session.service.js';

const ids = {
  userA: randomUUID(),
  userB: randomUUID(),
  playerA: randomUUID(),
  playerB: randomUUID(),
  worldA: randomUUID(),
  worldB: randomUUID(),
  campaignA: randomUUID(),
  campaignB: randomUUID(),
  actorA1: randomUUID(),
  actorA2: randomUUID(),
  actorB: randomUUID(),
};

const audit = { requestId: randomUUID(), traceId: randomUUID(), origin: 'widget' as const };
const contextService = createAuthenticatedGameContextService(
  prismaAuthenticatedGameContextRepository,
  { APP_ENV: 'test', NODE_ENV: 'test' },
);
const gameSessionService = createAuthenticatedGameSessionService(prismaAuthenticatedGameSessionRepository);

function refs(userId: string, campaignId: string, actorId: string) {
  return {
    campaignSelectionRef: authenticatedSelectionRef('campaign', userId, campaignId),
    characterSelectionRef: authenticatedSelectionRef('character', userId, actorId),
  };
}

function input(
  actorId = ids.actorA1,
  baseSessionVersion = 0,
  idempotencyKey = randomUUID(),
) {
  return {
    ...refs(ids.userA, ids.campaignA, actorId),
    idempotencyKey,
    baseSessionVersion,
  };
}

async function cleanup(): Promise<void> {
  await prisma.auditEvent.deleteMany({ where: { userId: { in: [ids.userA, ids.userB] } } });
  await prisma.gameEvent.deleteMany({ where: { campaignId: { in: [ids.campaignA, ids.campaignB] } } });
  await prisma.gameSession.deleteMany({ where: { userId: { in: [ids.userA, ids.userB] } } });
  await prisma.idempotencyRecord.deleteMany({
    where: { operation: { in: ['selectAuthenticatedGameContext:v1', 'performAuthenticatedObservation:v1'] } },
  });
}

describe.sequential('authenticated game session persistence', () => {
  beforeAll(async () => {
    const rulesetVersion = await prisma.rulesetVersion.findFirst({ select: { id: true } });
    if (rulesetVersion === null) throw new Error('Integration ruleset is unavailable');
    await prisma.user.createMany({
      data: [
        { id: ids.userA, status: UserStatus.ACTIVE },
        { id: ids.userB, status: UserStatus.ACTIVE },
      ],
    });
    await prisma.player.createMany({
      data: [
        { id: ids.playerA, userId: ids.userA, slug: `session-a-${ids.userA}`, displayName: 'Session User A' },
        { id: ids.playerB, userId: ids.userB, slug: `session-b-${ids.userB}`, displayName: 'Session User B' },
      ],
    });
    await prisma.world.createMany({
      data: [
        {
          id: ids.worldA,
          playerId: ids.playerA,
          defaultRulesetVersionId: rulesetVersion.id,
          code: `session-world-a-${ids.userA}`,
          name: 'Session World A',
        },
        {
          id: ids.worldB,
          playerId: ids.playerB,
          defaultRulesetVersionId: rulesetVersion.id,
          code: `session-world-b-${ids.userB}`,
          name: 'Session World B',
        },
      ],
    });
    await prisma.campaign.createMany({
      data: [
        {
          id: ids.campaignA,
          worldId: ids.worldA,
          rulesetVersionId: rulesetVersion.id,
          code: `session-campaign-a-${ids.userA}`,
          name: 'Session Campaign A',
          status: CampaignStatus.ACTIVE,
        },
        {
          id: ids.campaignB,
          worldId: ids.worldB,
          rulesetVersionId: rulesetVersion.id,
          code: `session-campaign-b-${ids.userB}`,
          name: 'Session Campaign B',
          status: CampaignStatus.ACTIVE,
        },
      ],
    });
    await prisma.actor.createMany({
      data: [
        {
          id: ids.actorA1,
          campaignId: ids.campaignA,
          code: 'session-actor-a1',
          name: 'Session Actor A1',
          actorType: ActorType.CHARACTER,
          status: ActorStatus.ACTIVE,
        },
        {
          id: ids.actorA2,
          campaignId: ids.campaignA,
          code: 'session-actor-a2',
          name: 'Session Actor A2',
          actorType: ActorType.CHARACTER,
          status: ActorStatus.ACTIVE,
        },
        {
          id: ids.actorB,
          campaignId: ids.campaignB,
          code: 'session-actor-b',
          name: 'Session Actor B',
          actorType: ActorType.CHARACTER,
          status: ActorStatus.ACTIVE,
        },
      ],
    });
    await prisma.campaignMembership.createMany({
      data: [
        {
          campaignId: ids.campaignA,
          userId: ids.userA,
          role: CampaignMembershipRole.PLAYER,
          status: CampaignMembershipStatus.ACTIVE,
        },
        {
          campaignId: ids.campaignB,
          userId: ids.userB,
          role: CampaignMembershipRole.PLAYER,
          status: CampaignMembershipStatus.ACTIVE,
        },
      ],
    });
    await prisma.actorControl.createMany({
      data: [
        { actorId: ids.actorA1, userId: ids.userA, permission: ActorControlPermission.VIEW },
        { actorId: ids.actorA2, userId: ids.userA, permission: ActorControlPermission.CONTROL },
        { actorId: ids.actorB, userId: ids.userB, permission: ActorControlPermission.CONTROL },
      ],
    });
  });

  beforeEach(async () => {
    await cleanup();
    await prisma.user.update({
      where: { id: ids.userA },
      data: { status: UserStatus.ACTIVE, suspendedAt: null, deletedAt: null },
    });
    await prisma.actorControl.updateMany({
      where: { userId: ids.userA },
      data: { revokedAt: null },
    });
    await prisma.campaignMembership.updateMany({
      where: { userId: ids.userA },
      data: { status: CampaignMembershipStatus.ACTIVE, revokedAt: null },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.actorControl.deleteMany({ where: { userId: { in: [ids.userA, ids.userB] } } });
    await prisma.campaignMembership.deleteMany({ where: { userId: { in: [ids.userA, ids.userB] } } });
    await prisma.actor.deleteMany({ where: { id: { in: [ids.actorA1, ids.actorA2, ids.actorB] } } });
    await prisma.campaign.deleteMany({ where: { id: { in: [ids.campaignA, ids.campaignB] } } });
    await prisma.world.deleteMany({ where: { id: { in: [ids.worldA, ids.worldB] } } });
    await prisma.player.deleteMany({ where: { id: { in: [ids.playerA, ids.playerB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ids.userA, ids.userB] } } });
  });

  it('creates once, replays exactly, and writes one consequential audit event', async () => {
    const request = input(ids.actorA1, 0, randomUUID());
    const first = await prismaAuthenticatedGameSessionRepository.select(ids.userA, request, audit);
    const replay = await prismaAuthenticatedGameSessionRepository.select(ids.userA, request, audit);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: 'SUCCESS', previousSessionVersion: 0, sessionVersion: 1 });
    expect(await prisma.gameSession.count({ where: { userId: ids.userA } })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: { userId: ids.userA, eventType: 'AUTHENTICATED_GAME_CONTEXT_SELECTION' },
    })).toBe(1);
  });

  it('rejects stale versions and serializes competing tabs without duplicating sessions', async () => {
    await prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA1), audit);
    const [left, right] = await Promise.all([
      prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA1, 1), audit),
      prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA2, 1), audit),
    ]);
    expect([left.status, right.status]).toContain('SUCCESS');
    expect([left.status, right.status].some((status) => (
      status === 'CONFLICT' || status === 'SAFE_RETRY'
    ))).toBe(true);
    expect(await prisma.gameSession.count({ where: { userId: ids.userA } })).toBe(1);
    const stale = await prismaAuthenticatedGameSessionRepository.select(
      ids.userA,
      input(ids.actorA1, 0),
      audit,
    );
    expect(stale).toMatchObject({ status: 'CONFLICT', recovery: 'RELOAD_REQUIRED' });
  });

  it('fails closed for cross-user references and suspended users', async () => {
    const crossUser = await prismaAuthenticatedGameSessionRepository.select(ids.userA, {
      ...refs(ids.userB, ids.campaignB, ids.actorB),
      idempotencyKey: randomUUID(),
      baseSessionVersion: 0,
    }, audit);
    expect(crossUser).toMatchObject({ status: 'REJECTED', selection: null, canContinue: false });
    expect(await prisma.gameSession.count()).toBe(0);

    await prisma.user.update({
      where: { id: ids.userA },
      data: { status: UserStatus.SUSPENDED, suspendedAt: new Date() },
    });
    const suspended = await prismaAuthenticatedGameSessionRepository.select(
      ids.userA,
      input(ids.actorA1),
      audit,
    );
    expect(suspended.status).toBe('REJECTED');
  });

  it('restores across loads, fails closed after revocation, and reactivates a closed session', async () => {
    await prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA2), audit);
    const restored = await contextService.load(ids.userA, {});
    expect(restored.widgetContext.gameSession).toMatchObject({
      status: 'ACTIVE',
      stateVersion: 1,
      canContinue: true,
    });
    expect(restored.widgetContext.activeContext?.character?.displayName).toBe('Session Actor A2');

    await prisma.actorControl.update({
      where: { actorId_userId: { actorId: ids.actorA2, userId: ids.userA } },
      data: { revokedAt: new Date() },
    });
    const revoked = await contextService.load(ids.userA, {});
    expect(revoked.widgetContext.gameSession).toMatchObject({
      status: 'UNAVAILABLE',
      canContinue: false,
      selection: null,
    });
    expect(JSON.stringify(revoked)).not.toContain('Session Actor A2');

    await prisma.actorControl.update({
      where: { actorId_userId: { actorId: ids.actorA2, userId: ids.userA } },
      data: { revokedAt: null },
    });
    await prisma.gameSession.update({
      where: { userId_campaignId: { userId: ids.userA, campaignId: ids.campaignA } },
      data: { status: GameSessionStatus.CLOSED, closedAt: new Date() },
    });
    const reactivated = await prismaAuthenticatedGameSessionRepository.select(
      ids.userA,
      input(ids.actorA1, 1),
      audit,
    );
    expect(reactivated).toMatchObject({ status: 'SUCCESS', sessionVersion: 2 });
    expect(await prisma.gameSession.findUnique({
      where: { userId_campaignId: { userId: ids.userA, campaignId: ids.campaignA } },
      select: { status: true, closedAt: true, actorId: true },
    })).toEqual({
      status: GameSessionStatus.ACTIVE,
      closedAt: null,
      actorId: ids.actorA1,
    });
  });

  it('persists one honest observation, replays it exactly, increments once, and restores the public last action', async () => {
    await prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA2), audit);
    const request = {
      idempotencyKey: randomUUID(),
      baseSessionVersion: 1,
    };
    const first = await gameSessionService.observe(ids.userA, request, audit);
    const replay = await gameSessionService.observe(ids.userA, request, audit);
    const conflictingPayload = await gameSessionService.observe(ids.userA, {
      ...request,
      focus: 'a janela',
    }, audit);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      action: { type: 'OBSERVE', status: 'RESOLVED', focus: null },
      continuity: { sessionVersion: 2, canContinue: true },
      discoveredFacts: [],
    });
    expect(conflictingPayload).toMatchObject({
      action: { status: 'CONFLICT' },
      continuity: { sessionVersion: 2, canContinue: false },
    });
    expect(await prisma.gameEvent.count({
      where: { campaignId: ids.campaignA, actorId: ids.actorA2, eventType: 'AUTHENTICATED_OBSERVATION' },
    })).toBe(1);
    expect(await prisma.auditEvent.count({
      where: { userId: ids.userA, eventType: 'AUTHENTICATED_GAME_ACTION', reasonCode: 'observation_recorded' },
    })).toBe(1);
    expect(await prisma.gameSession.findUnique({
      where: { userId_campaignId: { userId: ids.userA, campaignId: ids.campaignA } },
      select: { stateVersion: true },
    })).toEqual({ stateVersion: 2 });
    const restored = await contextService.load(ids.userA, {});
    expect(restored.widgetContext.gameSession).toMatchObject({
      stateVersion: 2,
      lastAction: { type: 'OBSERVE', status: 'RESOLVED', focus: null, discoveredFacts: [] },
    });
    expect(JSON.stringify(restored)).not.toMatch(/MASTER_ONLY|GameEvent|campaignId|actorId|idempotency/i);
  });

  it('normalizes focus, rejects long input, fails closed for revoked access, and serializes competing observations', async () => {
    await prismaAuthenticatedGameSessionRepository.select(ids.userA, input(ids.actorA2), audit);
    const focused = await gameSessionService.observe(ids.userA, {
      focus: '  a porta antiga  ',
      idempotencyKey: randomUUID(),
      baseSessionVersion: 1,
    }, audit);
    expect(focused.action.focus).toBe('a porta antiga');
    await expect(gameSessionService.observe(ids.userA, {
      focus: 'x'.repeat(301),
      idempotencyKey: randomUUID(),
      baseSessionVersion: 2,
    }, audit)).rejects.toThrow();
    await prisma.actorControl.update({
      where: { actorId_userId: { actorId: ids.actorA2, userId: ids.userA } },
      data: { revokedAt: new Date() },
    });
    const revoked = await gameSessionService.observe(ids.userA, {
      idempotencyKey: randomUUID(),
      baseSessionVersion: 2,
    }, audit);
    expect(revoked.action.status).toBe('REJECTED');

    await prisma.actorControl.update({
      where: { actorId_userId: { actorId: ids.actorA2, userId: ids.userA } },
      data: { revokedAt: null },
    });
    const [left, right] = await Promise.all([
      gameSessionService.observe(ids.userA, { idempotencyKey: randomUUID(), baseSessionVersion: 2 }, audit),
      gameSessionService.observe(ids.userA, { idempotencyKey: randomUUID(), baseSessionVersion: 2 }, audit),
    ]);
    expect([left.action.status, right.action.status]).toContain('RESOLVED');
    expect([left.action.status, right.action.status]).toContain('CONFLICT');
    expect(await prisma.gameEvent.count({
      where: { campaignId: ids.campaignA, actorId: ids.actorA2, eventType: 'AUTHENTICATED_OBSERVATION' },
    })).toBe(2);

    await prisma.user.update({
      where: { id: ids.userA },
      data: { status: UserStatus.SUSPENDED, suspendedAt: new Date() },
    });
    expect((await gameSessionService.observe(ids.userA, {
      idempotencyKey: randomUUID(),
      baseSessionVersion: 3,
    }, audit)).action.status).toBe('REJECTED');
    await prisma.user.update({
      where: { id: ids.userA },
      data: { status: UserStatus.ACTIVE, suspendedAt: null },
    });
    await prisma.campaignMembership.update({
      where: { campaignId_userId: { campaignId: ids.campaignA, userId: ids.userA } },
      data: { status: CampaignMembershipStatus.REVOKED, revokedAt: new Date() },
    });
    expect((await gameSessionService.observe(ids.userA, {
      idempotencyKey: randomUUID(),
      baseSessionVersion: 3,
    }, audit)).action.status).toBe('REJECTED');
  });
});
