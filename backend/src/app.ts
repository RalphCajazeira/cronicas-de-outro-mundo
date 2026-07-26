import express from 'express';
import type { AppConfig } from './config/env.js';
import {
  createHealthRouter,
  type ReadinessCheck,
  type ReleaseInfo,
} from './modules/health/health.routes.js';
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
import { createOAuthUiRouter } from './modules/oauth-ui/oauth-ui.routes.js';
import {
  createFileOAuthUiAssets,
  type OAuthUiAssets,
} from './modules/oauth-ui/oauth-ui.assets.js';
import { createAuthenticatedGameContextService } from './modules/authenticated-game-context/authenticated-game-context.service.js';
import type { AuthenticatedGameContextRepository } from './modules/authenticated-game-context/authenticated-game-context.types.js';
import type { AuthenticatedCharacterViewRepository } from './modules/authenticated-character-view/authenticated-character-view.types.js';
import { createAuthenticatedCharacterViewService } from './modules/authenticated-character-view/authenticated-character-view.service.js';
import { createAuthenticatedGameSessionService } from './modules/authenticated-game-session/authenticated-game-session.service.js';
import type { AuthenticatedGameSessionRepository } from './modules/authenticated-game-session/authenticated-game-session.types.js';

export interface AppDependencies {
  actorRepository: ActorRepository;
  contentRepository: ContentRepository;
  gptRepository: GptRepository;
  readiness: ReadinessCheck;
  auditLog?: AuditLogWriter;
  encounterHttpService: EncounterHttpService;
  chatGptAppWidgetAssets?: WidgetAssets;
  oauthUiAssets?: OAuthUiAssets;
  identityRepository?: IdentityRepository;
  authenticatedGameContextRepository?: AuthenticatedGameContextRepository;
  authenticatedCharacterViewRepository?: AuthenticatedCharacterViewRepository;
  authenticatedGameSessionRepository?: AuthenticatedGameSessionRepository;
  releaseInfo?: ReleaseInfo;
}

export function createApp(config: AppConfig, dependencies: AppDependencies) {
  const app = express();
  app.disable('x-powered-by');
  app.set('apiRoutes', ACTIVE_API_ROUTES);
  app.use(createRequestAudit(dependencies.auditLog ?? (config.NODE_ENV === 'test' ? undefined : writeHttpAuditLog)));
  app.use(express.json({ limit: '100kb' }));
  const widgetAssets = dependencies.chatGptAppWidgetAssets ?? createFileWidgetAssets();
  const oauthUiAssets = dependencies.oauthUiAssets ?? createFileOAuthUiAssets();
  app.use('/health', createHealthRouter(dependencies.readiness, dependencies.releaseInfo));
  app.use('/openapi.json', createOpenApiRouter(config.PUBLIC_BASE_URL ?? `http://localhost:${config.PORT}`));
  app.use('/mcp', createChatGptAppRouter(config, widgetAssets));
  if (config.OAUTH_UI !== undefined) {
    app.use(config.OAUTH_UI.basePath, createOAuthUiRouter(config.OAUTH_UI, oauthUiAssets));
  }
  if (config.OAUTH_RESOURCE_SERVER !== undefined) {
    if (dependencies.identityRepository === undefined) {
      throw new Error('OAuth identity repository is unavailable');
    }
    if (dependencies.authenticatedGameContextRepository === undefined) {
      throw new Error('Authenticated game context repository is unavailable');
    }
    const identityService = createIdentityService(dependencies.identityRepository);
    const authenticatedGameContextService = createAuthenticatedGameContextService(
      dependencies.authenticatedGameContextRepository,
      config,
    );
    const authenticatedCharacterViewService = createAuthenticatedCharacterViewService(
      dependencies.authenticatedGameContextRepository,
      dependencies.authenticatedCharacterViewRepository ?? {
        loadAuthorizedCharacterSnapshot: () => Promise.resolve(null),
      },
    );
    const authenticatedGameSessionService = createAuthenticatedGameSessionService(
      dependencies.authenticatedGameSessionRepository ?? {
        select: (_userId, input) => Promise.resolve({
          status: 'REJECTED' as const,
          previousSessionVersion: input.baseSessionVersion,
          sessionVersion: input.baseSessionVersion,
          selection: null,
          canContinue: false,
          recovery: 'SELECT_AGAIN' as const,
          message: 'A seleção solicitada não está disponível para esta conta.',
        }),
      },
    );
    app.use(createProtectedResourceMetadataRouter(config.OAUTH_RESOURCE_SERVER));
    app.use(
      config.OAUTH_RESOURCE_SERVER.protectedMcpPath,
      createAuthenticatedMcpRouter(
        config,
        config.OAUTH_RESOURCE_SERVER,
        identityService,
        authenticatedGameContextService,
        authenticatedCharacterViewService,
        widgetAssets,
        authenticatedGameSessionService,
      ),
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
