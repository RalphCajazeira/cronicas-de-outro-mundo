import type { Server } from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { runStagingMcpSmoke, stagingEndpoint } from '../../scripts/smoke-staging-mcp.js';
import { HOME_RESOURCE_URI } from '../../src/modules/chatgpt-app/mcp/chatgpt-app.server.js';
import { createChatGptAppRouter } from '../../src/modules/chatgpt-app/mcp/chatgpt-app.routes.js';

describe('staging MCP smoke target allowlist', () => {
  it('accepts an HTTPS Render staging endpoint', () => {
    expect(stagingEndpoint(
      'https://cronicas-de-outro-mundo-staging-api.onrender.com',
    ).href).toBe('https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp');
  });

  it('rejects localhost unless the explicit local-test gate is enabled', () => {
    expect(() => stagingEndpoint('http://127.0.0.1:3000')).toThrow();
    expect(stagingEndpoint('http://127.0.0.1:3000', true).href).toBe('http://127.0.0.1:3000/mcp');
  });

  it.each([
    'https://example.com',
    'http://cronicas-de-outro-mundo-staging-api.onrender.com',
    'https://user:password@cronicas-de-outro-mundo-staging-api.onrender.com',
  ])('rejects an unsafe endpoint: %s', (url) => {
    expect(() => stagingEndpoint(url)).toThrow();
  });

  it('runs the complete smoke against an isolated local proof server', async () => {
    const app = express();
    app.use(express.json());
    app.use('/mcp', createChatGptAppRouter(
      { NODE_ENV: 'production', CHATGPT_APP_PROOF_MODE: true },
      {
        readHome: () => Promise.resolve('<!doctype html><title>Local proof</title>'),
        readAuthenticatedHome: () => Promise.resolve('<!doctype html><title>Authenticated proof</title>'),
        readPreview: () => Promise.resolve('<!doctype html><title>Local preview</title>'),
      },
    ));
    const server = await new Promise<Server>((resolvePromise) => {
      const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Local smoke server did not bind');
      await expect(runStagingMcpSmoke(
        `http://127.0.0.1:${address.port}`,
        HOME_RESOURCE_URI,
        false,
        'https://issuer.example.test',
        true,
      )).resolves.toEqual({ toolCount: 2, resourceCount: 3 });
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error === undefined) resolvePromise();
          else reject(error);
        });
      });
    }
  });

  it('validates the enabled OAuth resource server and both metadata paths', async () => {
    const app = express();
    const expectedAuthorizationServer = 'https://issuer.example.test';
    app.use(express.json());
    app.use('/mcp', createChatGptAppRouter(
      { NODE_ENV: 'production', CHATGPT_APP_PROOF_MODE: true },
      {
        readHome: () => Promise.resolve('<!doctype html><title>Local proof</title>'),
        readAuthenticatedHome: () => Promise.resolve('<!doctype html><title>Authenticated proof</title>'),
        readPreview: () => Promise.resolve('<!doctype html><title>Local preview</title>'),
      },
    ));
    const server = await new Promise<Server>((resolvePromise) => {
      const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
    });
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Local smoke server did not bind');
      const base = `http://127.0.0.1:${address.port}`;
      const metadata = {
        resource: `${base}/mcp-auth`,
        authorization_servers: [expectedAuthorizationServer],
        scopes_supported: ['openid', 'email'],
        bearer_methods_supported: ['header'],
      };
      app.get('/.well-known/oauth-protected-resource', (_request, response) => response.json(metadata));
      app.get('/.well-known/oauth-protected-resource/mcp-auth', (_request, response) => response.json(metadata));
      app.all('/mcp-auth', (_request, response) => response
        .set('www-authenticate', `Bearer error="invalid_token", scope="openid email", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp-auth"`)
        .status(401)
        .json({ error: 'invalid_token' }));

      await expect(runStagingMcpSmoke(
        base,
        HOME_RESOURCE_URI,
        true,
        expectedAuthorizationServer,
        true,
      )).resolves.toEqual({ toolCount: 2, resourceCount: 3 });
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => {
          if (error === undefined) resolvePromise();
          else reject(error);
        });
      });
    }
  });
});
