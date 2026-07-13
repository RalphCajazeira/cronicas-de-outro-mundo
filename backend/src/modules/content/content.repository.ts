import { ContentType } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/database/prisma.js';
import { resolveScope, type DbClient } from '../../shared/database/game-scope.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { publishedContentInclude } from './content-publication.service.js';
import type { GetContentInput } from './content.schemas.js';
import type { ContentRepository } from './content.types.js';

export async function findScopedContent(
  client: DbClient,
  scope: { worldId: string; campaignId: string; rulesetVersionId: string },
  reference: string,
  contentType: string,
) {
  const baseWhere = {
    worldId: scope.worldId,
    contentType: contentType.toUpperCase() as ContentType,
    code: reference,
  };
  const campaignDefinition = await client.contentDefinition.findFirst({
    where: {
      ...baseWhere,
      campaignId: scope.campaignId,
    },
    include: publishedContentInclude,
  });
  const definition = campaignDefinition ?? await client.contentDefinition.findFirst({
    where: { ...baseWhere, campaignId: null },
    include: publishedContentInclude,
  });
  if (definition === null) throw new NotFoundError('Content');
  const version = definition.versions[0];
  if (version === undefined) throw new ConflictError('Content definition has no published version');
  if (version.rulesetVersionId !== scope.rulesetVersionId) throw new ConflictError('Content version is not compatible with the Campaign ruleset');
  return definition;
}

export const prismaContentRepository: ContentRepository = {
  async findByReference(input: GetContentInput, reference: string) {
    const { world, campaign } = await resolveScope(prisma, input);
    return findScopedContent(prisma, {
      worldId: world.id, campaignId: campaign.id, rulesetVersionId: campaign.rulesetVersionId,
    }, reference, input.contentType);
  },
};
