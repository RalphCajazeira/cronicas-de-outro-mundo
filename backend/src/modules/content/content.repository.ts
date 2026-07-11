import { prisma } from '../../shared/database/prisma.js';
import type { ContentRepository } from './content.types.js';

export const prismaContentRepository: ContentRepository = {
  findByReference: (reference) => {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference);
    return prisma.contentDefinition.findFirst({ where: { OR: [{ code: reference }, ...(isUuid ? [{ id: reference }] : [])] } });
  },
};
