import { describe, expect, it, vi } from 'vitest';
import {
  ActorControlPermission,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
} from '../../generated/prisma/client.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import { createPrismaAuthenticatedGameContextRepository } from './authenticated-game-context.repository.js';

vi.mock('../../shared/database/prisma.js', () => ({ prisma: {} }));

describe('authenticated game context repository', () => {
  it('starts from User and scopes memberships and controls before selecting public allowlisted fields', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repository = createPrismaAuthenticatedGameContextRepository({
      user: { findUnique },
    } as unknown as DbClient);
    await repository.findGameAccessByUserId('user-a');
    expect(findUnique).toHaveBeenCalledOnce();
    const query = findUnique.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(query).toMatchObject({
      where: { id: 'user-a' },
      select: {
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
              },
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(query);
    expect(serialized).not.toMatch(/findMany|metadata|appearance|personality|description|email|subject/i);
  });
});
