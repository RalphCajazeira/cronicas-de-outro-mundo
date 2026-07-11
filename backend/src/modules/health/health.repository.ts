import { prisma } from '../../shared/database/prisma.js';
import type { ReadinessCheck } from './health.routes.js';

export const prismaReadinessCheck: ReadinessCheck = {
  async check(timeoutMs) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        prisma.$queryRaw`SELECT 1`.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  },
};
