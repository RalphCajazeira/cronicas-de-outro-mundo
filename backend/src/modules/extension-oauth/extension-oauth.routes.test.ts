import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { ExtensionOAuthConfig } from '../../config/env.js';
import type { AuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.types.js';
import type { createIdentityService } from '../identity/identity.service.js';
import { createExtensionOAuthRouter } from './extension-oauth.routes.js';

const config: ExtensionOAuthConfig = {
  issuer: 'https://project.supabase.co/auth/v1',
  authorizationServer: 'https://project.supabase.co/auth/v1',
  jwksUri: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  resourceUri: 'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/session',
  protectedMcpPath: '/extension/session',
  requiredScopes: ['openid', 'profile'],
  allowedClientIds: ['extension-public-client'],
  allowedAlgorithms: ['ES256'],
  clockSkewSeconds: 30,
  jwksTimeoutMs: 2_000,
  jwksCooldownMs: 30_000,
  jwksCacheMaxAgeMs: 600_000,
  clientId: 'extension-public-client',
  redirectUri: 'https://ddmcennimefoiapgjhmienohiapencdm.chromiumapp.org/oauth2',
  extensionOrigin: 'chrome-extension://ddmcennimefoiapgjhmienohiapencdm',
};

function app() {
  const server = express();
  server.use(createExtensionOAuthRouter(
    config,
    {} as ReturnType<typeof createIdentityService>,
    {} as AuthenticatedGameContextRepository,
  ));
  return server;
}

describe('extension OAuth public configuration', () => {
  it('publishes only public configuration and permits the exact extension origin', async () => {
    const response = await request(app())
      .get('/oauth-config')
      .set('Origin', config.extensionOrigin)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe(config.extensionOrigin);
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      authorizationEndpoint: 'https://project.supabase.co/auth/v1/oauth/authorize',
      tokenEndpoint: 'https://project.supabase.co/auth/v1/oauth/token',
      clientId: 'extension-public-client',
      resourceUri: config.resourceUri,
      scopes: ['openid', 'profile'],
    });
  });

  it('does not authorize an unlisted browser origin', async () => {
    const response = await request(app())
      .get('/oauth-config')
      .set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
