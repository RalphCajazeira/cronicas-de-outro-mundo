import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  GameSessionStatus,
} from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import type { AuthenticatedGameContextRepository } from './authenticated-game-context.types.js';

const maximumCampaignsPlusIntegritySentinel = 21;
const maximumActorControlsPlusIntegritySentinel = 101;

export function createPrismaAuthenticatedGameContextRepository(
  client: DbClient,
): AuthenticatedGameContextRepository {
  return {
    findGameAccessByUserId(userId) {
      return client.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          status: true,
          suspendedAt: true,
          deletedAt: true,
          player: {
            select: {
              id: true,
              displayName: true,
            },
          },
          campaignMemberships: {
            where: {
              status: CampaignMembershipStatus.ACTIVE,
              revokedAt: null,
              role: {
                in: [
                  CampaignMembershipRole.OWNER,
                  CampaignMembershipRole.GM,
                  CampaignMembershipRole.PLAYER,
                  CampaignMembershipRole.OBSERVER,
                ],
              },
            },
            select: {
              campaignId: true,
              userId: true,
              role: true,
              status: true,
              revokedAt: true,
              campaign: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  world: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
            orderBy: [
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            take: maximumCampaignsPlusIntegritySentinel,
          },
          actorControls: {
            where: {
              revokedAt: null,
              permission: {
                in: [
                  ActorControlPermission.VIEW,
                  ActorControlPermission.CONTROL,
                ],
              },
              actor: {
                is: {
                  actorType: ActorType.CHARACTER,
                  status: ActorStatus.ACTIVE,
                },
              },
            },
            select: {
              actorId: true,
              userId: true,
              permission: true,
              revokedAt: true,
              actor: {
                select: {
                  id: true,
                  campaignId: true,
                  name: true,
                  level: true,
                  actorType: true,
                  status: true,
                  resources: {
                    select: {
                      type: true,
                      current: true,
                    },
                    orderBy: {
                      type: 'asc',
                    },
                  },
                  derivedSnapshot: {
                    select: {
                      maxHp: true,
                      maxMana: true,
                      maxSp: true,
                    },
                  },
                },
              },
            },
            orderBy: [
              { createdAt: 'asc' },
              { id: 'asc' },
            ],
            take: maximumActorControlsPlusIntegritySentinel,
          },
          gameSessions: {
            where: {
              status: GameSessionStatus.ACTIVE,
            },
            select: {
              id: true,
              userId: true,
              campaignId: true,
              actorId: true,
              status: true,
              stateVersion: true,
              lastActiveAt: true,
              closedAt: true,
            },
            orderBy: [
              { lastActiveAt: 'desc' },
              { id: 'asc' },
            ],
            take: maximumCampaignsPlusIntegritySentinel,
          },
        },
      });
    },
    findLatestObservation(gameSessionId, campaignId, actorId) {
      return client.gameEvent.findFirst({
        where: {
          campaignId,
          actorId,
          eventType: 'AUTHENTICATED_OBSERVATION',
          payload: {
            path: ['gameSessionId'],
            equals: gameSessionId,
          },
        },
        select: {
          payload: true,
          createdAt: true,
        },
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
      });
    },
  };
}

export const prismaAuthenticatedGameContextRepository =
  createPrismaAuthenticatedGameContextRepository(prisma);
