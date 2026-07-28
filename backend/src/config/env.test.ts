import { describe, expect, it } from 'vitest';
import { parseConfig } from './env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  PORT: '3100',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/game_gpt_test',
  RPG_API_KEY: 'secret-test-key',
};

describe('application configuration', () => {
  it('parses a valid configuration', () => {
    expect(parseConfig(validEnvironment)).toMatchObject({
      NODE_ENV: 'test',
      APP_ENV: 'test',
      HOST: '0.0.0.0',
      PORT: 3100,
      RPG_API_KEY: 'secret-test-key',
    });
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = validEnvironment;
    void _databaseUrl;
    expect(() => parseConfig(missingDatabaseUrl)).toThrow('Invalid application configuration');
  });

  it('does not expose a secret in its error', () => {
    const secret = 'must-never-leak';
    expect(() => parseConfig({ ...validEnvironment, DATABASE_URL: secret })).toThrowError(new Error('Invalid application configuration'));
  });

  it('requires a public HTTPS base URL in production', () => {
    expect(() => parseConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_ENV: undefined,
    })).toThrow('Invalid application configuration');
    expect(parseConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      PUBLIC_BASE_URL: 'https://rpg.example.com',
    }).PUBLIC_BASE_URL).toBe('https://rpg.example.com');
  });

  it('keeps the ChatGPT fixture proof mode disabled unless explicitly enabled', () => {
    expect(parseConfig(validEnvironment).CHATGPT_APP_PROOF_MODE).toBe(false);
    expect(parseConfig({ ...validEnvironment, CHATGPT_APP_PROOF_MODE: 'true' }).CHATGPT_APP_PROOF_MODE).toBe(true);
    expect(() => parseConfig({ ...validEnvironment, CHATGPT_APP_PROOF_MODE: 'yes' })).toThrow('Invalid application configuration');
  });

  it('enables the staging OAuth UI only with reviewed public configuration', () => {
    expect(parseConfig(validEnvironment).OAUTH_UI).toBeUndefined();
    expect(parseConfig({
      ...validEnvironment,
      APP_ENV: 'staging',
      OAUTH_UI_ENABLED: 'true',
      OAUTH_UI_SUPABASE_URL: 'https://project-ref.supabase.co',
      OAUTH_UI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-test-key',
    }).OAUTH_UI).toEqual({
      supabaseUrl: 'https://project-ref.supabase.co',
      supabasePublishableKey: 'sb_publishable_public-test-key',
      environment: 'staging',
      basePath: '/oauth',
    });
  });

  it.each([
    { OAUTH_UI_SUPABASE_URL: undefined },
    { OAUTH_UI_SUPABASE_URL: 'http://project-ref.supabase.co' },
    { OAUTH_UI_SUPABASE_URL: 'https://evil.example' },
    { OAUTH_UI_SUPABASE_PUBLISHABLE_KEY: 'service-role-secret' },
    { OAUTH_UI_BASE_PATH: '/other' },
  ])('rejects incomplete or unsafe OAuth UI configuration: %o', (override) => {
    expect(() => parseConfig({
      ...validEnvironment,
      APP_ENV: 'staging',
      OAUTH_UI_ENABLED: 'true',
      OAUTH_UI_SUPABASE_URL: 'https://project-ref.supabase.co',
      OAUTH_UI_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-test-key',
      ...override,
    })).toThrow('Invalid application configuration');
  });

  it('keeps the OAuth resource server disabled unless a complete explicit configuration is present', () => {
    expect(parseConfig(validEnvironment).OAUTH_RESOURCE_SERVER).toBeUndefined();
    expect(() => parseConfig({ ...validEnvironment, OAUTH_RESOURCE_SERVER_ENABLED: 'true' }))
      .toThrow('Invalid application configuration');
  });

  it('parses a fail-closed loopback OAuth resource server configuration in tests', () => {
    expect(parseConfig({
      ...validEnvironment,
      OAUTH_RESOURCE_SERVER_ENABLED: 'true',
      OAUTH_ISSUER: 'http://127.0.0.1:4100/issuer',
      OAUTH_AUTHORIZATION_SERVER: 'http://127.0.0.1:4100/issuer',
      OAUTH_JWKS_URI: 'http://127.0.0.1:4100/jwks',
      OAUTH_RESOURCE_URI: 'http://127.0.0.1:3000/mcp-auth',
      OAUTH_REQUIRED_SCOPES: 'openid',
      OAUTH_ALLOWED_CLIENT_IDS: 'synthetic-client',
      OAUTH_ALLOWED_ALGORITHMS: 'ES256,RS256',
    }).OAUTH_RESOURCE_SERVER).toMatchObject({
      protectedMcpPath: '/mcp-auth',
      requiredScopes: ['openid'],
      allowedClientIds: ['synthetic-client'],
      allowedAlgorithms: ['ES256', 'RS256'],
      clockSkewSeconds: 30,
      jwksTimeoutMs: 2_000,
      jwksCooldownMs: 30_000,
      jwksCacheMaxAgeMs: 600_000,
    });
  });

  it('accepts the future staging resource only with canonical HTTPS configuration', () => {
    const stagingResource = 'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth';
    expect(parseConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://cronicas-de-outro-mundo-staging-api.onrender.com',
      OAUTH_RESOURCE_SERVER_ENABLED: 'true',
      OAUTH_ISSUER: 'https://project-ref.supabase.co/auth/v1',
      OAUTH_AUTHORIZATION_SERVER: 'https://project-ref.supabase.co/auth/v1',
      OAUTH_JWKS_URI: 'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json',
      OAUTH_RESOURCE_URI: stagingResource,
      OAUTH_REQUIRED_SCOPES: 'openid',
      OAUTH_ALLOWED_ALGORITHMS: 'ES256',
    }).OAUTH_RESOURCE_SERVER?.resourceUri).toBe(stagingResource);
  });

  it('enables an extension public client only with its exact Chromium redirect and separate audience', () => {
    const extensionResource = 'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/session';
    expect(parseConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://cronicas-de-outro-mundo-staging-api.onrender.com',
      OAUTH_RESOURCE_SERVER_ENABLED: 'true',
      OAUTH_ISSUER: 'https://project-ref.supabase.co/auth/v1',
      OAUTH_AUTHORIZATION_SERVER: 'https://project-ref.supabase.co/auth/v1',
      OAUTH_JWKS_URI: 'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json',
      OAUTH_RESOURCE_URI: 'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth',
      OAUTH_REQUIRED_SCOPES: 'openid',
      OAUTH_ALLOWED_ALGORITHMS: 'ES256',
      EXTENSION_OAUTH_ENABLED: 'true',
      EXTENSION_OAUTH_CLIENT_ID: 'extension-public-client',
      EXTENSION_OAUTH_REDIRECT_URI: 'https://ddmcennimefoiapgjhmienohiapencdm.chromiumapp.org/oauth2',
      EXTENSION_OAUTH_RESOURCE_URI: extensionResource,
      EXTENSION_OAUTH_REQUIRED_SCOPES: 'openid,profile',
      EXTENSION_OAUTH_ALLOWED_ALGORITHMS: 'ES256',
    }).EXTENSION_OAUTH).toMatchObject({
      resourceUri: extensionResource,
      allowedClientIds: ['extension-public-client'],
      extensionOrigin: 'chrome-extension://ddmcennimefoiapgjhmienohiapencdm',
      requiredScopes: ['openid', 'profile'],
    });
  });

  it.each([
    { OAUTH_JWKS_URI: 'http://keys.example.test/jwks' },
    { OAUTH_JWKS_URI: 'http://127.0.0.2:4100/jwks' },
    { OAUTH_ALLOWED_ALGORITHMS: 'HS256' },
    { OAUTH_ALLOWED_ALGORITHMS: 'none' },
    { OAUTH_RESOURCE_URI: 'http://127.0.0.1:3000/other' },
    { PUBLIC_BASE_URL: 'http://localhost:3000' },
    { OAUTH_AUTHORIZATION_SERVER: 'http://127.0.0.1:4100/other-issuer' },
    { OAUTH_REQUIRED_SCOPES: 'openid,openid' },
    { OAUTH_REQUIRED_SCOPES: 'game:bootstrap' },
    { OAUTH_ALLOWED_CLIENT_IDS: 'synthetic-client,synthetic-client' },
  ])('rejects an unsafe OAuth configuration override: %o', (override) => {
    expect(() => parseConfig({
      ...validEnvironment,
      OAUTH_RESOURCE_SERVER_ENABLED: 'true',
      OAUTH_ISSUER: 'http://127.0.0.1:4100/issuer',
      OAUTH_AUTHORIZATION_SERVER: 'http://127.0.0.1:4100/issuer',
      OAUTH_JWKS_URI: 'http://127.0.0.1:4100/jwks',
      OAUTH_RESOURCE_URI: 'http://127.0.0.1:3000/mcp-auth',
      OAUTH_REQUIRED_SCOPES: 'openid',
      OAUTH_ALLOWED_ALGORITHMS: 'ES256',
      ...override,
    })).toThrow('Invalid application configuration');
  });

  it.each([
    'https://localhost/auth/v1/.well-known/jwks.json',
    'https://127.0.0.1/auth/v1/.well-known/jwks.json',
    'https://[::1]/auth/v1/.well-known/jwks.json',
    'https://auth.internal/auth/v1/.well-known/jwks.json',
  ])('rejects a runtime JWKS host that could target a local or private service: %s', (jwksUri) => {
    expect(() => parseConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      PUBLIC_BASE_URL: 'https://api.example.test',
      OAUTH_RESOURCE_SERVER_ENABLED: 'true',
      OAUTH_ISSUER: new URL('/auth/v1', jwksUri).href,
      OAUTH_AUTHORIZATION_SERVER: new URL('/auth/v1', jwksUri).href,
      OAUTH_JWKS_URI: jwksUri,
      OAUTH_RESOURCE_URI: 'https://api.example.test/mcp-auth',
      OAUTH_REQUIRED_SCOPES: 'openid',
      OAUTH_ALLOWED_ALGORITHMS: 'ES256',
    })).toThrow('Invalid application configuration');
  });
});
