import { Router } from 'express';
import type { ActorRepository } from './actors.types.js';
import { createGetActorController } from './actors.controller.js';

export function createActorsRouter(repository: ActorRepository) {
  return Router().get('/:actorRef', createGetActorController(repository));
}
