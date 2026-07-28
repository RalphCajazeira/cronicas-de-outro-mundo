import { Router, type Request, type Response } from 'express';
import type { ExtensionOAuthConfig } from '../../config/env.js';
import type { AuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.types.js';
import { UserStatus } from '../../generated/prisma/client.js';
import { createOAuthResourceServerAuthentication, readAuthenticatedMcpContext } from '../oauth-resource-server/oauth-resource-server.middleware.js';
import type { createIdentityService } from '../identity/identity.service.js';
import { updateAuthenticationAudit } from '../../shared/http/request-audit.js';

type IdentityService = ReturnType<typeof createIdentityService>;

function setExtensionCors(request: Request, response: Response, config: ExtensionOAuthConfig): void {
  const origin = request.header('origin');
  response.setHeader('Vary', 'Origin');
  if (origin === config.extensionOrigin) {
    response.setHeader('Access-Control-Allow-Origin', config.extensionOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  }
}

function publicConfig(config: ExtensionOAuthConfig) {
  return {
    authorizationEndpoint: new URL('oauth/authorize', config.authorizationServer + '/').href,
    tokenEndpoint: new URL('oauth/token', config.authorizationServer + '/').href,
    clientId: config.clientId,
    resourceUri: config.resourceUri,
    scopes: [...config.requiredScopes],
  };
}

export function createExtensionOAuthRouter(
  config: ExtensionOAuthConfig,
  identityService: IdentityService,
  gameContextRepository: AuthenticatedGameContextRepository,
) {
  const router = Router();
  const authenticate = createOAuthResourceServerAuthentication(config, identityService);
  router.options('/{*splat}', (request, response) => {
    setExtensionCors(request, response, config);
    response.status(204).end();
  });
  router.get('/oauth-config', (request, response) => {
    setExtensionCors(request, response, config);
    response.setHeader('Cache-Control', 'no-store');
    response.json(publicConfig(config));
  });
  router.get(
    '/session',
    (request, response, next) => {
      setExtensionCors(request, response, config);
      authenticate(request, response, next);
    },
    async (request, response) => {
      const context = readAuthenticatedMcpContext(request.auth);
      if (context === undefined) {
        updateAuthenticationAudit(response, { category: 'extension_context_missing', result: 'denied' });
        response.status(403).json({ error: 'access_denied' });
        return;
      }
      const access = await gameContextRepository.findGameAccessByUserId(context.userId);
      if (access === null
        || access.id !== context.userId
        || access.status !== UserStatus.ACTIVE
        || access.suspendedAt !== null
        || access.deletedAt !== null
        || access.player === null) {
        updateAuthenticationAudit(response, { category: 'extension_user_unavailable', result: 'denied' });
        response.status(403).json({ error: 'access_denied' });
        return;
      }
      updateAuthenticationAudit(response, { category: 'extension_session_allowed', result: 'allowed' });
      response.setHeader('Cache-Control', 'no-store');
      response.json({ authenticated: true, user: { displayName: access.player.displayName } });
    },
  );
  return router;
}
