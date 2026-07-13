import { ContentType } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { resolveScope, type DbClient } from '../../shared/database/game-scope.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { GetContentInput } from './content.schemas.js';
import type { ContentRepository } from './content.types.js';

export async function findScopedContent(
  client: DbClient,
  scope: { worldId: string; campaignId: string },
  reference: string,
  contentType: string,
) {
  const definitions = await client.contentDefinition.findMany({
    where: {
      worldId: scope.worldId,
      contentType: contentType.toUpperCase() as ContentType,
      code: reference,
      AND: [{ OR: [{ campaignId: scope.campaignId }, { campaignId: null }] }],
    },
  });
  const campaignDefinition = definitions.find((definition) => definition.campaignId === scope.campaignId);
  const globalDefinition = definitions.find((definition) => definition.campaignId === null);
  const definition = campaignDefinition ?? globalDefinition;
  if (definition === undefined) throw new NotFoundError('Content');
  return definition;
}

export const prismaContentRepository: ContentRepository = {
  async findByReference(input: GetContentInput, reference: string) {
    const { world, campaign } = await resolveScope(prisma, input);
    return findScopedContent(prisma, { worldId: world.id, campaignId: campaign.id }, reference, input.contentType);
  },
};
