import { prisma } from '../../shared/database/prisma.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import type { AuthorizationRepository } from './authorization.types.js';

const membershipSelection = {
  id: true,
  campaignId: true,
  userId: true,
  role: true,
  status: true,
  revokedAt: true,
  user: {
    select: {
      status: true,
      suspendedAt: true,
      deletedAt: true,
    },
  },
} as const;

function flattenMembership(membership: {
  id: string;
  campaignId: string;
  userId: string;
  role: import('../../generated/prisma/client.js').CampaignMembershipRole;
  status: import('../../generated/prisma/client.js').CampaignMembershipStatus;
  revokedAt: Date | null;
  user: {
    status: import('../../generated/prisma/client.js').UserStatus;
    suspendedAt: Date | null;
    deletedAt: Date | null;
  };
}) {
    return {
      id: membership.id,
      campaignId: membership.campaignId,
      userId: membership.userId,
      role: membership.role,
      status: membership.status,
      revokedAt: membership.revokedAt,
      userStatus: membership.user.status,
      userSuspendedAt: membership.user.suspendedAt,
      userDeletedAt: membership.user.deletedAt,
    };
}

export function createPrismaAuthorizationRepository(client: DbClient): AuthorizationRepository {
  return {
    async findCampaignMembership(userId, campaignId) {
      const membership = await client.campaignMembership.findUnique({
        where: { campaignId_userId: { campaignId, userId } },
        select: membershipSelection,
      });
      return membership === null ? null : flattenMembership(membership);
    },

    async findActorAccess(userId, campaignId, actorId) {
      const control = await client.actorControl.findFirst({
        where: { actorId, userId, actor: { campaignId } },
        select: {
          id: true,
          actorId: true,
          userId: true,
          permission: true,
          revokedAt: true,
          actor: {
            select: {
              campaignId: true,
              campaign: {
                select: {
                  memberships: {
                    where: { userId },
                    select: membershipSelection,
                    take: 1,
                  },
                },
              },
            },
          },
        },
      });
      if (control === null) return null;
      const membership = control.actor.campaign.memberships[0];
      return {
        id: control.id,
        actorId: control.actorId,
        actorCampaignId: control.actor.campaignId,
        userId: control.userId,
        permission: control.permission,
        revokedAt: control.revokedAt,
        membership: membership === undefined ? null : flattenMembership(membership),
      };
    },
  };
}

export const prismaAuthorizationRepository = createPrismaAuthorizationRepository(prisma);
