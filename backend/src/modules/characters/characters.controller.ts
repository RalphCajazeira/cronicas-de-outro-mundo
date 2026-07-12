import type { RequestHandler } from 'express';
import { actorRefSchema, gameScopeSchema } from '../actors/actors.schemas.js';
import type { ActorRepository } from '../actors/actors.types.js';
import { createCharactersService } from './characters.service.js';

export function createGetCharacterController(repository: ActorRepository): RequestHandler {
  const service = createCharactersService(repository);
  return async (request, response, next) => {
    try {
      response.json(await service.get(gameScopeSchema.parse(request.query), actorRefSchema.parse(request.params.characterRef)));
    } catch (error) { next(error); }
  };
}

export function createListCharacterContentController(repository: ActorRepository): RequestHandler {
  const service = createCharactersService(repository);
  return async (request, response, next) => {
    try {
      const reference = actorRefSchema.parse(request.params.characterRef);
      response.json(await service.listContent(gameScopeSchema.parse(request.query), reference));
    }
    catch (error) { next(error); }
  };
}
