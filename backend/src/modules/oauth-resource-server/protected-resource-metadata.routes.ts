import { Router } from 'express';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthResourceServerConfig } from '../../config/env.js';

export function createProtectedResourceMetadataRouter(config: OAuthResourceServerConfig) {
  const router = Router();
  const resourceUrl = new URL(config.resourceUri);
  const metadataUrl = new URL(getOAuthProtectedResourceMetadataUrl(resourceUrl));
  const metadata = OAuthProtectedResourceMetadataSchema.parse({
    resource: resourceUrl.href,
    authorization_servers: [config.authorizationServer],
    scopes_supported: [...config.requiredScopes],
    bearer_methods_supported: ['header'],
  });
  router.use(metadataUrl.pathname, metadataHandler(metadata));
  return router;
}
