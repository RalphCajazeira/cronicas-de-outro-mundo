import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { resolveScope } from '../../shared/database/game-scope.js';
import type { ActorRepository } from './actors.types.js';
import { loadActorMechanicalSheet } from './actor-mechanics.service.js';

const actorSelect = { id: true, code: true, name: true, actorType: true, species: true, className: true,
  role: true, description: true, level: true, xp: true, gold: true, appearance: true, personality: true,
  metadata: true, status: true } satisfies Prisma.ActorSelect;

export function scopedActorKey(campaignId: string, code: string): Prisma.ActorWhereUniqueInput {
  return { campaignId_code: { campaignId, code } };
}

export const prismaActorRepository: ActorRepository = {
  async findByReference(scope, reference) {
    const { campaign } = await resolveScope(prisma, scope);
    const actor = await prisma.actor.findUnique({ where: scopedActorKey(campaign.id, reference), select: actorSelect });
    if (actor === null) return null;
    const mechanicalSheet = await loadActorMechanicalSheet(prisma, actor.id);
    return { ...actor, mechanicalSheet };
  },
  async listContent(scope, reference) {
    const { campaign } = await resolveScope(prisma, scope);
    const actor = await prisma.actor.findUnique({ where: scopedActorKey(campaign.id, reference), select: { id: true } });
    if (actor === null) return null;
    return prisma.actorContent.findMany({
      where: { actorId: actor.id },
      include: { contentDefinition: true },
      orderBy: [{ contentDefinition: { name: 'asc' } }, { contentDefinition: { contentType: 'asc' } }, { contentDefinition: { code: 'asc' } }],
    });
  },
};
