import { NotFoundError } from '../../shared/errors/app-error.js';
import { createActorsService } from '../actors/actors.service.js';
import type { ActorRepository } from '../actors/actors.types.js';

export function createCharactersService(repository: ActorRepository) {
  const actors = createActorsService(repository);

  async function getCharacter(reference: string) {
    const character = await actors.get(reference);
    if (character.actorType !== 'character') throw new NotFoundError('Character');
    return character;
  }

  return {
    get: getCharacter,
    async listContent(reference: string) {
      await getCharacter(reference);
      return actors.listContent(reference);
    },
  };
}
