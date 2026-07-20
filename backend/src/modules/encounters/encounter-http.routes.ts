import { Router } from 'express';
import { createManageEncounterController } from './encounter-http.controller.js';
import type { EncounterHttpService } from './encounter-http.service.js';

export function createEncounterHttpRouter(service: EncounterHttpService) {
  return Router().post('/manage', createManageEncounterController(service));
}
