import { Router } from 'express';
import type { ActorRepository } from '../actors/actors.types.js';
import { createGetCharacterController, createListCharacterContentController } from './characters.controller.js';

export function createCharactersRouter(repository: ActorRepository) {
  return Router()
    .get('/:characterRef', createGetCharacterController(repository))
    .get('/:characterRef/content', createListCharacterContentController(repository));
}
