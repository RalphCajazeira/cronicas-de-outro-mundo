import { prisma } from '../../shared/database/prisma.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import type { IdentityRepository } from './identity.types.js';

export function createPrismaIdentityRepository(client: DbClient): IdentityRepository {
  return {
    findByPrincipal(principal) {
      return client.externalIdentity.findMany({
        where: { issuer: principal.issuer, subject: principal.subject },
        select: {
          id: true,
          issuer: true,
          subject: true,
          user: {
            select: {
              id: true,
              status: true,
              suspendedAt: true,
              deletedAt: true,
            },
          },
        },
        take: 2,
      });
    },
  };
}

export const prismaIdentityRepository = createPrismaIdentityRepository(prisma);
