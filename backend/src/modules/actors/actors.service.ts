import { NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type { ActorContentRecord, ActorRecord, ActorRepository } from './actors.types.js';

export function normalizeActor(actor: ActorRecord) {
  return { code: actor.code, name: actor.name, actorType: normalizeEnum(actor.actorType), species: actor.species,
    className: actor.className, level: actor.level, xp: actor.xp, gold: actor.gold, health: actor.health,
    maxHealth: actor.maxHealth, mana: actor.mana, maxMana: actor.maxMana, attributes: actor.attributes,
    resistances: actor.resistances, affinities: actor.affinities, status: normalizeEnum(actor.status) };
}

export function normalizeActorContent(item: ActorContentRecord) {
  const definition = item.contentDefinition;
  return { code: definition.code, name: definition.name, contentType: normalizeEnum(definition.contentType),
    description: definition.description, state: normalizeEnum(item.state), rank: item.rank, progress: item.progress,
    mastery: item.mastery, equipped: item.equipped, quantity: item.quantity, notes: item.notes,
    mechanics: definition.mechanics, requirements: definition.requirements, presentation: definition.presentation,
    tags: definition.tags, schemaVersion: definition.schemaVersion, status: normalizeEnum(definition.status) };
}

export function createActorsService(repository: ActorRepository) {
  return {
    async get(reference: string) {
      const actor = await repository.findByReference(reference);
      if (actor === null) throw new NotFoundError('Actor');
      return normalizeActor(actor);
    },
    async listContent(reference: string) {
      const content = await repository.listContent(reference);
      if (content === null) throw new NotFoundError('Actor');
      return content.map(normalizeActorContent);
    },
  };
}
