import { describe, expect, it } from 'vitest';
import {
  ActorControlPermission,
  ActorResourceType,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import { authenticatedGameContextSchema } from './authenticated-game-context.dto.js';
import { AuthenticatedGameContextAccessError } from './authenticated-game-context.errors.js';
import { createAuthenticatedGameContextService } from './authenticated-game-context.service.js';
import type {
  AuthenticatedActorControlRecord,
  AuthenticatedCampaignMembershipRecord,
  AuthenticatedGameAccessRecord,
  AuthenticatedGameContextRepository,
} from './authenticated-game-context.types.js';

const userId = 'user-a';
const config = { APP_ENV: 'staging' as const, NODE_ENV: 'production' as const };

function membership(
  campaignId: string,
  role: CampaignMembershipRole = CampaignMembershipRole.PLAYER,
  overrides: Partial<AuthenticatedCampaignMembershipRecord> = {},
): AuthenticatedCampaignMembershipRecord {
  return {
    campaignId,
    userId,
    role,
    status: CampaignMembershipStatus.ACTIVE,
    revokedAt: null,
    campaign: {
      id: campaignId,
      name: `Campaign ${campaignId}`,
      status: CampaignStatus.ACTIVE,
      world: { name: `World ${campaignId}` },
    },
    ...overrides,
  };
}

function control(
  actorId: string,
  campaignId: string,
  permission: ActorControlPermission = ActorControlPermission.CONTROL,
  overrides: Partial<AuthenticatedActorControlRecord> = {},
): AuthenticatedActorControlRecord {
  return {
    actorId,
    userId,
    permission,
    revokedAt: null,
    actor: {
      id: actorId,
      campaignId,
      name: `Character ${actorId}`,
      level: 3,
      actorType: ActorType.CHARACTER,
      status: ActorStatus.ACTIVE,
      resources: [{ type: ActorResourceType.HP, current: 7 }],
      derivedSnapshot: { maxHp: 10, maxMana: 8, maxSp: 6 },
    },
    ...overrides,
  };
}

function access(
  overrides: Partial<AuthenticatedGameAccessRecord> = {},
): AuthenticatedGameAccessRecord {
  return {
    id: userId,
    status: UserStatus.ACTIVE,
    suspendedAt: null,
    deletedAt: null,
    player: { id: 'player-a', displayName: 'OAuth Staging Tester' },
    campaignMemberships: [],
    actorControls: [],
    ...overrides,
  };
}

function service(record: AuthenticatedGameAccessRecord | null) {
  const repository: AuthenticatedGameContextRepository = {
    findGameAccessByUserId: () => Promise.resolve(record),
  };
  return createAuthenticatedGameContextService(repository, config);
}

describe('authenticated read-only game context', () => {
  it('returns the explicit no-Player state without campaigns or internal identity fields', async () => {
    const result = await service(access({ player: null })).load(userId, {});
    expect(result).toMatchObject({
      authState: 'AUTHENTICATED_NO_PLAYER',
      player: null,
      narrativeContext: null,
      widgetContext: {
        banner: 'STAGING — CONTA SINTÉTICA',
        sessionState: 'NO_PLAYER',
        campaigns: [],
      },
      environment: {
        appEnvironment: 'staging',
        runtimeMode: 'production',
        syntheticAccount: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/userId|issuer|subject|email|token|claim/i);
  });

  it('returns a linked Player with no authorized campaign as a read-only empty state', async () => {
    await expect(service(access()).load(userId, {})).resolves.toMatchObject({
      authState: 'AUTHENTICATED',
      player: { displayName: 'OAuth Staging Tester' },
      widgetContext: {
        sessionState: 'NO_CAMPAIGN',
        campaigns: [],
        navigation: { canMutate: false },
      },
    });
  });

  it('lists only active memberships and actor controls already scoped to the User', async () => {
    const record = access({
      campaignMemberships: [
        membership('campaign-a', CampaignMembershipRole.PLAYER),
        membership('campaign-b', CampaignMembershipRole.OBSERVER),
        membership('campaign-c', CampaignMembershipRole.GM),
        membership('campaign-d', CampaignMembershipRole.OWNER),
      ],
      actorControls: [
        control('actor-a', 'campaign-a', ActorControlPermission.VIEW),
        control('actor-b', 'campaign-b', ActorControlPermission.CONTROL),
        control('actor-c', 'campaign-c'),
        control('actor-d', 'campaign-d'),
        control('actor-without-membership', 'campaign-foreign'),
      ],
    });
    const result = await service(record).load(userId, {});
    expect(result.widgetContext.campaigns).toHaveLength(4);
    expect(result.widgetContext.campaigns.map((campaign) => campaign.characters.length))
      .toEqual([1, 1, 1, 1]);
    expect(result.widgetContext.sessionState).toBe('CAMPAIGN_SELECTION_REQUIRED');
    expect(JSON.stringify(result)).not.toContain('actor-without-membership');
    expect(JSON.stringify(result)).not.toMatch(/owner|observer|control|permission/i);
  });

  it('uses opaque authorized selections and fails closed for an IDOR or stale grant', async () => {
    const first = await service(access({
      campaignMemberships: [membership('campaign-a'), membership('campaign-b')],
      actorControls: [control('actor-a', 'campaign-a'), control('actor-b', 'campaign-b')],
    })).load(userId, {});
    const campaign = first.widgetContext.campaigns[0];
    expect(campaign?.selectionRef).toMatch(/^sel_[A-Za-z0-9_-]{43}$/u);
    expect(campaign?.selectionRef).not.toContain('campaign-a');

    const selected = await service(access({
      campaignMemberships: [membership('campaign-a'), membership('campaign-b')],
      actorControls: [control('actor-a', 'campaign-a'), control('actor-b', 'campaign-b')],
    })).load(userId, { campaignSelectionRef: campaign?.selectionRef });
    expect(selected.widgetContext.activeContext?.campaign.displayName).toBe('Campaign campaign-a');
    expect(selected.widgetContext.activeContext?.character?.displayName).toBe('Character actor-a');

    await expect(service(access({
      campaignMemberships: [membership('campaign-a')],
      actorControls: [control('actor-a', 'campaign-a')],
    })).load(userId, {
      campaignSelectionRef: `sel_${'x'.repeat(43)}`,
    })).rejects.toMatchObject({
      reasonCode: 'resource_unavailable',
    });
  });

  it('never projects MASTER_ONLY, free metadata, hidden inventory, or administrative fields', async () => {
    const record = access({
      campaignMemberships: [membership('campaign-a')],
      actorControls: [control('actor-a', 'campaign-a')],
    }) as AuthenticatedGameAccessRecord & {
      MASTER_ONLY?: string;
      metadata?: unknown;
      hiddenInventory?: unknown;
      administrativeFlags?: unknown;
    };
    record.MASTER_ONLY = 'secret objective';
    record.metadata = { traps: ['hidden'] };
    record.hiddenInventory = ['artifact'];
    record.administrativeFlags = { bypass: true };

    const result = await service(record).load(userId, {});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/MASTER_ONLY|secret objective|metadata|trap|inventory|administrative|bypass/i);
    expect(authenticatedGameContextSchema.safeParse({
      ...result,
      MASTER_ONLY: 'forbidden',
    }).success).toBe(false);
  });

  it('fails closed for revoked, cross-user, suspended, deleted, and inconsistent records', async () => {
    const failures = [
      access({ status: UserStatus.SUSPENDED, suspendedAt: new Date() }),
      access({ status: UserStatus.DELETED, deletedAt: new Date() }),
      access({ id: 'user-b' }),
      access({
        campaignMemberships: [membership('campaign-a', CampaignMembershipRole.PLAYER, {
          status: CampaignMembershipStatus.REVOKED,
          revokedAt: new Date(),
        })],
      }),
      access({
        campaignMemberships: [membership('campaign-a')],
        actorControls: [control('actor-a', 'campaign-a', ActorControlPermission.VIEW, {
          userId: 'user-b',
        })],
      }),
    ];
    for (const record of failures) {
      await expect(service(record).load(userId, {})).rejects.toBeInstanceOf(
        AuthenticatedGameContextAccessError,
      );
    }
  });

  it('does not keep selected state between independent calls or sessions', async () => {
    const contextService = service(access({
      campaignMemberships: [membership('campaign-a'), membership('campaign-b')],
      actorControls: [control('actor-a', 'campaign-a'), control('actor-b', 'campaign-b')],
    }));
    const initial = await contextService.load(userId, {});
    const selectedRef = initial.widgetContext.campaigns[0]?.selectionRef;
    const selected = await contextService.load(userId, { campaignSelectionRef: selectedRef });
    const remounted = await contextService.load(userId, {});
    expect(selected.widgetContext.activeContext).not.toBeNull();
    expect(remounted.widgetContext.activeContext).toBeNull();
    expect(remounted).toEqual(initial);
  });
});
