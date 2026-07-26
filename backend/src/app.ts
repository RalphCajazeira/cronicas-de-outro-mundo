import express from 'express';
import type { AppConfig } from './config/env.js';
import { createHealthRouter, type ReadinessCheck } from './modules/health/health.routes.js';
import { createActorsRouter } from './modules/actors/actors.routes.js';
import type { ActorRepository } from './modules/actors/actors.types.js';
import { createCharactersRouter } from './modules/characters/characters.routes.js';
import { createContentRouter } from './modules/content/content.routes.js';
import type { ContentRepository } from './modules/content/content.types.js';
import { createGptRouter } from './modules/gpt/gpt.routes.js';
import type { GptRepository } from './modules/gpt/gpt.types.js';
import { createEncounterHttpRouter } from './modules/encounters/encounter-http.routes.js';
import type { EncounterHttpService } from './modules/encounters/encounter-http.service.js';
import { ACTIVE_API_ROUTES, createOpenApiRouter } from './modules/openapi/openapi.routes.js';
import { createApiKeyAuth } from './shared/http/api-key-auth.js';
import { errorHandler, notFoundHandler } from './shared/http/error-handler.js';
import { createRequestAudit, type AuditLogWriter, writeHttpAuditLog } from './shared/http/request-audit.js';
import { createChatGptAppRouter } from './modules/chatgpt-app/mcp/chatgpt-app.routes.js';
import { createChatGptAppPreviewRouter } from './modules/chatgpt-app/resources/chatgpt-app-preview.routes.js';
import {
  createFileWidgetAssets,
  type WidgetAssets,
} from './modules/chatgpt-app/resources/widget-assets.js';
import { createAuthenticatedMcpRouter } from './modules/authenticated-mcp/authenticated-mcp.routes.js';
import { createProtectedResourceMetadataRouter } from './modules/oauth-resource-server/protected-resource-metadata.routes.js';
import { createIdentityService } from './modules/identity/identity.service.js';
import type { IdentityRepository } from './modules/identity/identity.types.js';

export interface AppDependencies {
  actorRepository: ActorRepository;
  contentRepository: ContentRepository;
  gptRepository: GptRepository;
  readiness: ReadinessCheck;
  auditLog?: AuditLogWriter;
  encounterHttpService: EncounterHttpService;
  chatGptAppWidgetAssets?: WidgetAssets;
  identityRepository?: IdentityRepository;
}

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('apiRoutes', ACTIVE_API_ROUTES);
  app.use(createRequestAudit(dependencies.auditLog ?? (config.NODE_ENV === 'test' ? undefined : writeHttpAuditLog)));
  app.use(express.json({ limit: '100kb' }));
  const widgetAssets = dependencies.chatGptAppWidgetAssets ?? createFileWidgetAssets();
  app.use('/health', createHealthRouter(dependencies.readiness));
  app.use('/openapi.json', createOpenApiRouter(config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`));
  app.use('/mcp', createChatGptAppRouter(config, widgetAssets));
  if (config.OAUTH_RESOURCE_SERVER !== undefined) {
    if (dependencies.identityRepository === undefined) {
      throw new Error('OAuth identity repository is unavailable');
    }
    const identityService = createIdentityService(dependencies.identityRepository);
    app.use(createProtectedResourceMetadataRouter(config.OAUTH_RESOURCE_SERVER));
    app.use(
      config.OAUTH_RESOURCE_SERVER.protectedMcpPath,
      createAuthenticatedMcpRouter(config.NODE_ENV, config.OAUTH_RESOURCE_SERVER, identityService),
    );
  }
  app.use('/chatgpt-app-preview', createChatGptAppPreviewRouter(config, widgetAssets));
  app.use('/api/v1', createApiKeyAuth(config.RPG_API_KEY));
  app.use('/api/v1/encounters', createEncounterHttpRouter(dependencies.encounterHttpService));
  app.use('/api/v1', createGptRouter(dependencies.gptRepository));
  app.use('/api/v1/characters', createCharactersRouter(dependencies.actorRepository));
  app.use('/api/v1/actors', createActorsRouter(dependencies.actorRepository));
  app.use('/api/v1/content', createContentRouter(dependencies.contentRepository));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
