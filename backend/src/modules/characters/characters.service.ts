import { NotFoundError } from '../../shared/errors/app-error.js';
import { createActorsService } from '../actors/actors.service.js';
import type { ActorRepository } from '../actors/actors.types.js';
import type { CampaignReference } from '../../shared/database/game-scope.js';

export function createCharactersService(repository: ActorRepository) {
  const actors = createActorsService(repository);

  async function getCharacter(scope: CampaignReference, reference: string) {
    const character = await actors.get(scope, reference);
    if (character.actorType !== 'character') throw new NotFoundError('Character');
    return character;
  }

  return {
    get: getCharacter,
    async listContent(scope: CampaignReference, reference: string) {
      await getCharacter(scope, reference);
      return actors.listContent(scope, reference);
    },
  };
}
