import { prisma } from '../../shared/database/prisma.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import type { AuditEventRepository } from './audit-event.types.js';

export function createPrismaAuditEventRepository(client: DbClient): AuditEventRepository {
  return {
    create(input) {
      return client.auditEvent.create({
        data: {
          ...input,
          metadata: input.metadata,
        },
        select: { id: true },
      });
    },
  };
}

export const prismaAuditEventRepository = createPrismaAuditEventRepository(prisma);
