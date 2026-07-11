import type { RequestHandler } from 'express';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { actorRefSchema } from '../actors/actors.schemas.js';
import { createActorsService } from '../actors/actors.service.js';
import type { ActorRepository } from '../actors/actors.types.js';

export function createGetCharacterController(repository: ActorRepository): RequestHandler {
  return async (request, response, next) => {
    try {
      const result = await createActorsService(repository).get(actorRefSchema.parse(request.params.characterRef));
      if (result.actorType !== 'character') throw new NotFoundError('Character');
      response.json(result);
    } catch (error) { next(error); }
  };
}

export function createListCharacterContentController(repository: ActorRepository): RequestHandler {
  const service = createActorsService(repository);
  return async (request, response, next) => {
    try {
      const reference = actorRefSchema.parse(request.params.characterRef);
      const character = await service.get(reference);
      if (character.actorType !== 'character') throw new NotFoundError('Character');
      response.json(await service.listContent(reference));
    }
    catch (error) { next(error); }
  };
}
