import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import type { ActorRepository } from './actors.types.js';

const actorSelect = { id: true, code: true, name: true, actorType: true, species: true, className: true,
  level: true, xp: true, gold: true, health: true, maxHealth: true, mana: true, maxMana: true,
  attributes: true, resistances: true, affinities: true, status: true } satisfies Prisma.ActorSelect;

function referenceWhere(reference: string): Prisma.ActorWhereInput {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference);
  return { OR: [{ code: reference }, ...(isUuid ? [{ id: reference }] : [])] };
}

export const prismaActorRepository: ActorRepository = {
  findByReference: (reference) => prisma.actor.findFirst({ where: referenceWhere(reference), select: actorSelect }),
  async listContent(reference) {
    const actor = await prisma.actor.findFirst({ where: referenceWhere(reference), select: { id: true } });
    if (actor === null) return null;
    return prisma.actorContent.findMany({ where: { actorId: actor.id }, include: { contentDefinition: true }, orderBy: { contentDefinition: { name: 'asc' } } });
  },
};
