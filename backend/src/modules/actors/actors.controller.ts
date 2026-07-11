import type { RequestHandler } from 'express';
import type { ActorRepository } from './actors.types.js';
import { actorRefSchema } from './actors.schemas.js';
import { createActorsService } from './actors.service.js';

export function createGetActorController(repository: ActorRepository): RequestHandler {
  const service = createActorsService(repository);
  return async (request, response, next) => {
    try { response.json(await service.get(actorRefSchema.parse(request.params.actorRef))); } catch (error) { next(error); }
  };
}
