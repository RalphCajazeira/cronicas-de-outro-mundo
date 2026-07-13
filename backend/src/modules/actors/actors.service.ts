import { NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type { CampaignReference } from '../../shared/database/game-scope.js';
import type { ActorContentRecord, ActorRecord, ActorRepository } from './actors.types.js';
import { publicContentVersionDto } from '../content/content-publication.service.js';

export function normalizeActor(actor: ActorRecord) {
  return { code: actor.code, name: actor.name, actorType: normalizeEnum(actor.actorType), species: actor.species,
    className: actor.className, role: actor.role, description: actor.description, level: actor.level,
    xp: actor.xp, gold: actor.gold, appearance: actor.appearance, personality: actor.personality,
    metadata: actor.metadata, status: normalizeEnum(actor.status), ...actor.mechanicalSheet };
}

export function normalizeActorContent(item: ActorContentRecord) {
  const definition = item.contentDefinition;
  return { ...publicContentVersionDto(definition, item.contentVersion),
    state: normalizeEnum(item.state), rank: item.rank, progress: item.progress,
    mastery: item.mastery, notes: item.notes,
    linkMetadata: item.metadata };
}

export function createActorsService(repository: ActorRepository) {
  return {
    async get(scope: CampaignReference, reference: string) {
      const actor = await repository.findByReference(scope, reference);
      if (actor === null) throw new NotFoundError('Actor');
      return normalizeActor(actor);
    },
    async listContent(scope: CampaignReference, reference: string) {
      const content = await repository.listContent(scope, reference);
      if (content === null) throw new NotFoundError('Actor');
      return content.map(normalizeActorContent);
    },
  };
}
