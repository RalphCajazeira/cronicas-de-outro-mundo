import { Router } from 'express';
import { actorRefSchema } from '../actors/actors.schemas.js';
import {
  createEventSchema, listCampaignActorsSchema, listPlayerWorldsSchema, listWorldCampaignsSchema, loadGameSchema, manageActorContentSchema, manageActorInventorySchema, startGameSchema,
  patchActorSchema, upsertActorSchema, upsertContentSchema,
} from './gpt.schemas.js';
import { createGptService } from './gpt.service.js';
import type { GptRepository } from './gpt.types.js';

export function createGptRouter(repository: GptRepository) {
  const router = Router();
  const service = createGptService(repository);

  router.post('/game/load', async (request, response, next) => {
    try { response.json(await service.loadGame(loadGameSchema.parse(request.body))); } catch (error) { next(error); }
  });
  router.post('/game/start', async (request, response, next) => {
    try { response.json(await service.startGame(startGameSchema.parse(request.body))); } catch (error) { next(error); }
  });
  router.get('/players/:playerRef/worlds', async (request, response, next) => {
    try { response.json(await service.listPlayerWorlds(listPlayerWorldsSchema.parse(request.params))); } catch (error) { next(error); }
  });
  router.get('/players/:playerRef/worlds/:worldRef/campaigns', async (request, response, next) => {
    try { response.json(await service.listWorldCampaigns(listWorldCampaignsSchema.parse(request.params))); } catch (error) { next(error); }
  });
  router.get('/campaigns/:campaignRef/actors', async (request, response, next) => {
    try {
      response.json(await service.listCampaignActors(listCampaignActorsSchema.parse({ ...request.query, campaignRef: request.params.campaignRef })));
    } catch (error) { next(error); }
  });
  router.post('/actors/upsert', async (request, response, next) => {
    try { response.json(await service.upsertActor(upsertActorSchema.parse(request.body))); } catch (error) { next(error); }
  });
  router.patch('/actors/:actorRef', async (request, response, next) => {
    try {
      response.json(await service.patchActor(actorRefSchema.parse(request.params.actorRef), patchActorSchema.parse(request.body)));
    } catch (error) { next(error); }
  });
  router.post('/content/upsert', async (request, response, next) => {
    try { response.json(await service.upsertContent(upsertContentSchema.parse(request.body))); } catch (error) { next(error); }
  });
  router.post('/actors/:actorRef/content/manage', async (request, response, next) => {
    try {
      response.json(await service.manageActorContent(actorRefSchema.parse(request.params.actorRef), manageActorContentSchema.parse(request.body)));
    } catch (error) { next(error); }
  });
  router.post('/actors/:actorRef/inventory/manage', async (request, response, next) => {
    try {
      response.json(await service.manageActorInventory(actorRefSchema.parse(request.params.actorRef), manageActorInventorySchema.parse(request.body)));
    } catch (error) { next(error); }
  });
  router.post('/events', async (request, response, next) => {
    try { response.json(await service.createEvent(createEventSchema.parse(request.body))); } catch (error) { next(error); }
  });
  return router;
}
