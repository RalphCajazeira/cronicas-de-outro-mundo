import express from 'express';
import type { AppConfig } from './config/env.js';
import { healthRouter } from './modules/health/health.routes.js';
import { createActorsRouter } from './modules/actors/actors.routes.js';
import type { ActorRepository } from './modules/actors/actors.types.js';
import { createCharactersRouter } from './modules/characters/characters.routes.js';
import { createContentRouter } from './modules/content/content.routes.js';
import type { ContentRepository } from './modules/content/content.types.js';
import { createApiKeyAuth } from './shared/http/api-key-auth.js';
import { errorHandler, notFoundHandler } from './shared/http/error-handler.js';

export interface AppDependencies { actorRepository: ActorRepository; contentRepository: ContentRepository; }

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use('/health', healthRouter);
  app.use('/api/v1', createApiKeyAuth(config.RPG_API_KEY));
  app.use('/api/v1/characters', createCharactersRouter(dependencies.actorRepository));
  app.use('/api/v1/actors', createActorsRouter(dependencies.actorRepository));
  app.use('/api/v1/content', createContentRouter(dependencies.contentRepository));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
