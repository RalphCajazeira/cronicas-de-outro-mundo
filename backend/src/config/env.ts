import { z } from 'zod';

const asymmetricAlgorithms = [
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
  'EdDSA',
] as const;

const supportedOAuthScopes = ['openid', 'email', 'profile', 'phone'] as const;

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  RPG_API_KEY: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().optional(),
  CHATGPT_APP_PROOF_MODE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OAUTH_UI_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OAUTH_UI_SUPABASE_URL: z.string().trim().optional(),
  OAUTH_UI_SUPABASE_PUBLISHABLE_KEY: z.string().trim().optional(),
  OAUTH_UI_ENVIRONMENT: z.enum(['staging']).default('staging'),
  OAUTH_UI_BASE_PATH: z.string().trim().default('/oauth'),
  OAUTH_RESOURCE_SERVER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  OAUTH_ISSUER: z.string().trim().optional(),
  OAUTH_AUTHORIZATION_SERVER: z.string().trim().optional(),
  OAUTH_JWKS_URI: z.string().trim().optional(),
  OAUTH_RESOURCE_URI: z.string().trim().optional(),
  OAUTH_PROTECTED_MCP_PATH: z.string().trim().default('/mcp-auth'),
  OAUTH_REQUIRED_SCOPES: z.string().trim().optional(),
  OAUTH_ALLOWED_CLIENT_IDS: z.string().trim().optional(),
  OAUTH_ALLOWED_ALGORITHMS: z.string().trim().optional(),
  OAUTH_CLOCK_SKEW_SECONDS: z.coerce.number().int().min(0).max(300).default(30),
  OAUTH_JWKS_TIMEOUT_MS: z.coerce.number().int().min(50).max(30_000).default(2_000),
  OAUTH_JWKS_COOLDOWN_MS: z.coerce.number().int().min(0).max(300_000).default(30_000),
  OAUTH_JWKS_CACHE_MAX_AGE_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
  EXTENSION_OAUTH_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  EXTENSION_OAUTH_CLIENT_ID: z.string().trim().optional(),
  EXTENSION_OAUTH_REDIRECT_URI: z.string().trim().optional(),
  EXTENSION_OAUTH_RESOURCE_URI: z.string().trim().optional(),
  EXTENSION_OAUTH_REQUIRED_SCOPES: z.string().trim().optional(),
  EXTENSION_OAUTH_ALLOWED_ALGORITHMS: z.string().trim().optional(),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && value.PUBLIC_BASE_URL === undefined) {
    context.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'Required in production' });
  }
  if (value.OAUTH_UI_ENABLED) {
    if (value.APP_ENV !== 'staging') {
      context.addIssue({ code: 'custom', path: ['APP_ENV'], message: 'OAuth UI is restricted to the explicit staging product environment' });
    }
    if (value.OAUTH_UI_SUPABASE_URL === undefined) {
      context.addIssue({ code: 'custom', path: ['OAUTH_UI_SUPABASE_URL'], message: 'Required when OAuth UI is enabled' });
    } else {
      try {
        const url = new URL(value.OAUTH_UI_SUPABASE_URL);
        if (url.protocol !== 'https:'
          || url.pathname !== '/'
          || url.username.length > 0
          || url.password.length > 0
          || url.search.length > 0
          || url.hash.length > 0
          || !url.hostname.endsWith('.supabase.co')) {
          throw new Error('invalid');
        }
      } catch {
        context.addIssue({ code: 'custom', path: ['OAUTH_UI_SUPABASE_URL'], message: 'Must be a canonical Supabase HTTPS project URL' });
      }
    }
    if (value.OAUTH_UI_SUPABASE_PUBLISHABLE_KEY === undefined
      || !/^(?:sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.test(
        value.OAUTH_UI_SUPABASE_PUBLISHABLE_KEY,
      )) {
      context.addIssue({ code: 'custom', path: ['OAUTH_UI_SUPABASE_PUBLISHABLE_KEY'], message: 'Must be a Supabase publishable or legacy anon key' });
    }
    if (value.OAUTH_UI_BASE_PATH !== '/oauth') {
      context.addIssue({ code: 'custom', path: ['OAUTH_UI_BASE_PATH'], message: 'Must use the reviewed /oauth base path' });
    }
  }
  if (!value.OAUTH_RESOURCE_SERVER_ENABLED) {
    if (value.EXTENSION_OAUTH_ENABLED) {
      context.addIssue({ code: 'custom', path: ['EXTENSION_OAUTH_ENABLED'], message: 'Requires the OAuth resource server' });
    }
    return;
  }

  const requiredFields = [
    'OAUTH_ISSUER',
    'OAUTH_AUTHORIZATION_SERVER',
    'OAUTH_JWKS_URI',
    'OAUTH_RESOURCE_URI',
    'OAUTH_REQUIRED_SCOPES',
    'OAUTH_ALLOWED_ALGORITHMS',
  ] as const;
  for (const field of requiredFields) {
    if (value[field] === undefined || value[field].length === 0) {
      context.addIssue({ code: 'custom', path: [field], message: 'Required when OAuth resource server is enabled' });
    }
  }

  if (!/^\/[a-z0-9/_-]*[a-z0-9_-]$/u.test(value.OAUTH_PROTECTED_MCP_PATH)) {
    context.addIssue({ code: 'custom', path: ['OAUTH_PROTECTED_MCP_PATH'], message: 'Must be a canonical absolute path without a trailing slash' });
  }

  const parseUrl = (field: 'OAUTH_ISSUER' | 'OAUTH_AUTHORIZATION_SERVER' | 'OAUTH_JWKS_URI' | 'OAUTH_RESOURCE_URI') => {
    const input = value[field];
    if (input === undefined || input.length === 0) return undefined;
    try {
      const parsed = new URL(input);
      if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
        throw new Error('URL components are not allowed');
      }
      return parsed;
    } catch {
      context.addIssue({ code: 'custom', path: [field], message: 'Must be a canonical URL without credentials, query, or fragment' });
      return undefined;
    }
  };

  const issuer = parseUrl('OAUTH_ISSUER');
  const authorizationServer = parseUrl('OAUTH_AUTHORIZATION_SERVER');
  const jwksUri = parseUrl('OAUTH_JWKS_URI');
  const resourceUri = parseUrl('OAUTH_RESOURCE_URI');
  const isLoopbackTestUrl = (url: URL) => value.NODE_ENV === 'test'
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(url.hostname);
  const isForbiddenRuntimeHost = (url: URL) => {
    if (value.NODE_ENV === 'test') return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');
    return hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
      || hostname.endsWith('.internal')
      || /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname)
      || hostname.includes(':');
  };
  for (const [field, url] of [
    ['OAUTH_ISSUER', issuer],
    ['OAUTH_AUTHORIZATION_SERVER', authorizationServer],
    ['OAUTH_JWKS_URI', jwksUri],
  ] as const) {
    if (url !== undefined && url.protocol !== 'https:' && !isLoopbackTestUrl(url)) {
      context.addIssue({ code: 'custom', path: [field], message: 'HTTPS is required outside controlled loopback tests' });
    }
    if (url !== undefined && isForbiddenRuntimeHost(url)) {
      context.addIssue({ code: 'custom', path: [field], message: 'Local, private, and IP-literal hosts are forbidden outside tests' });
    }
  }
  if (resourceUri !== undefined
    && resourceUri.protocol !== 'https:'
    && !(value.NODE_ENV !== 'production' && resourceUri.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(resourceUri.hostname))) {
    context.addIssue({ code: 'custom', path: ['OAUTH_RESOURCE_URI'], message: 'HTTPS is required outside local environments' });
  }
  if (issuer !== undefined && authorizationServer !== undefined && issuer.href !== authorizationServer.href) {
    context.addIssue({ code: 'custom', path: ['OAUTH_AUTHORIZATION_SERVER'], message: 'Authorization server must match the allowed issuer' });
  }
  if (issuer !== undefined && jwksUri !== undefined && issuer.origin !== jwksUri.origin) {
    context.addIssue({ code: 'custom', path: ['OAUTH_JWKS_URI'], message: 'JWKS URI must use the exact allowed issuer origin' });
  }
  if (resourceUri !== undefined && resourceUri.pathname !== value.OAUTH_PROTECTED_MCP_PATH) {
    context.addIssue({ code: 'custom', path: ['OAUTH_RESOURCE_URI'], message: 'Resource URI path must match the protected MCP path' });
  }
  if (resourceUri !== undefined
    && value.PUBLIC_BASE_URL !== undefined
    && resourceUri.origin !== new URL(value.PUBLIC_BASE_URL).origin) {
    context.addIssue({ code: 'custom', path: ['OAUTH_RESOURCE_URI'], message: 'Resource URI origin must match the configured public base URL' });
  }

  const scopes = value.OAUTH_REQUIRED_SCOPES?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (scopes.length === 0
    || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !supportedOAuthScopes.includes(scope as typeof supportedOAuthScopes[number]))) {
    context.addIssue({ code: 'custom', path: ['OAUTH_REQUIRED_SCOPES'], message: 'Must contain only currently supported standard OAuth scopes' });
  }
  const clientIds = value.OAUTH_ALLOWED_CLIENT_IDS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (new Set(clientIds).size !== clientIds.length
    || clientIds.some((clientId) => !/^[\x21-\x2B\x2D-\x7E]{1,512}$/u.test(clientId))) {
    context.addIssue({ code: 'custom', path: ['OAUTH_ALLOWED_CLIENT_IDS'], message: 'Must contain unique comma-separated OAuth client identifiers' });
  }
  const algorithms = value.OAUTH_ALLOWED_ALGORITHMS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (algorithms.length === 0
    || new Set(algorithms).size !== algorithms.length
    || algorithms.some((algorithm) => !asymmetricAlgorithms.includes(algorithm as typeof asymmetricAlgorithms[number]))) {
    context.addIssue({ code: 'custom', path: ['OAUTH_ALLOWED_ALGORITHMS'], message: 'Must contain only allowlisted asymmetric algorithms' });
  }

  if (!value.EXTENSION_OAUTH_ENABLED) return;
  const extensionFields = [
    'EXTENSION_OAUTH_CLIENT_ID',
    'EXTENSION_OAUTH_REDIRECT_URI',
    'EXTENSION_OAUTH_RESOURCE_URI',
    'EXTENSION_OAUTH_REQUIRED_SCOPES',
    'EXTENSION_OAUTH_ALLOWED_ALGORITHMS',
  ] as const;
  for (const field of extensionFields) {
    if (value[field] === undefined || value[field].length === 0) {
      context.addIssue({ code: 'custom', path: [field], message: 'Required when extension OAuth is enabled' });
    }
  }
  const redirect = value.EXTENSION_OAUTH_REDIRECT_URI === undefined ? undefined : (() => {
    try { return new URL(value.EXTENSION_OAUTH_REDIRECT_URI); } catch { return undefined; }
  })();
  if (redirect === undefined
    || redirect.protocol !== 'https:'
    || redirect.username.length > 0
    || redirect.password.length > 0
    || redirect.search.length > 0
    || redirect.hash.length > 0
    || !/^[a-p]{32}\.chromiumapp\.org$/u.test(redirect.hostname)
    || redirect.pathname !== '/oauth2') {
    context.addIssue({ code: 'custom', path: ['EXTENSION_OAUTH_REDIRECT_URI'], message: 'Must be the exact Chromium oauth2 redirect URI' });
  }
  const extensionResource = value.EXTENSION_OAUTH_RESOURCE_URI === undefined ? undefined : (() => {
    try { return new URL(value.EXTENSION_OAUTH_RESOURCE_URI); } catch { return undefined; }
  })();
  if (extensionResource === undefined
    || extensionResource.protocol !== 'https:'
    || extensionResource.username.length > 0
    || extensionResource.password.length > 0
    || extensionResource.search.length > 0
    || extensionResource.hash.length > 0
    || extensionResource.pathname !== '/extension/session'
    || (value.PUBLIC_BASE_URL !== undefined && extensionResource.origin !== new URL(value.PUBLIC_BASE_URL).origin)) {
    context.addIssue({ code: 'custom', path: ['EXTENSION_OAUTH_RESOURCE_URI'], message: 'Must be the exact public extension session resource URI' });
  }
  const extensionScopes = value.EXTENSION_OAUTH_REQUIRED_SCOPES?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (extensionScopes.length === 0 || new Set(extensionScopes).size !== extensionScopes.length
    || extensionScopes.some((scope) => !supportedOAuthScopes.includes(scope as typeof supportedOAuthScopes[number]))) {
    context.addIssue({ code: 'custom', path: ['EXTENSION_OAUTH_REQUIRED_SCOPES'], message: 'Must contain supported unique OAuth scopes' });
  }
  const extensionAlgorithms = value.EXTENSION_OAUTH_ALLOWED_ALGORITHMS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  if (extensionAlgorithms.length === 0 || new Set(extensionAlgorithms).size !== extensionAlgorithms.length
    || extensionAlgorithms.some((algorithm) => !asymmetricAlgorithms.includes(algorithm as typeof asymmetricAlgorithms[number]))) {
    context.addIssue({ code: 'custom', path: ['EXTENSION_OAUTH_ALLOWED_ALGORITHMS'], message: 'Must contain allowlisted asymmetric algorithms' });
  }
});

export interface OAuthResourceServerConfig {
  readonly issuer: string;
  readonly authorizationServer: string;
  readonly jwksUri: string;
  readonly resourceUri: string;
  readonly protectedMcpPath: string;
  readonly requiredScopes: readonly string[];
  readonly allowedClientIds: readonly string[];
  readonly allowedAlgorithms: readonly string[];
  readonly clockSkewSeconds: number;
  readonly jwksTimeoutMs: number;
  readonly jwksCooldownMs: number;
  readonly jwksCacheMaxAgeMs: number;
}

export interface OAuthUiConfig {
  readonly supabaseUrl: string;
  readonly supabasePublishableKey: string;
  readonly environment: 'staging';
  readonly basePath: '/oauth';
}

export interface ExtensionOAuthConfig extends OAuthResourceServerConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly extensionOrigin: string;
}

const envSchema = rawEnvSchema.transform((value) => {
  const base = {
    NODE_ENV: value.NODE_ENV,
    APP_ENV: value.APP_ENV,
    HOST: value.HOST,
    PORT: value.PORT,
    DATABASE_URL: value.DATABASE_URL,
    ...(value.DIRECT_URL === undefined ? {} : { DIRECT_URL: value.DIRECT_URL }),
    RPG_API_KEY: value.RPG_API_KEY,
    ...(value.PUBLIC_BASE_URL === undefined ? {} : { PUBLIC_BASE_URL: value.PUBLIC_BASE_URL }),
    CHATGPT_APP_PROOF_MODE: value.CHATGPT_APP_PROOF_MODE,
    ...(value.OAUTH_UI_ENABLED
      ? {
        OAUTH_UI: {
          supabaseUrl: new URL(value.OAUTH_UI_SUPABASE_URL ?? '').origin,
          supabasePublishableKey: value.OAUTH_UI_SUPABASE_PUBLISHABLE_KEY ?? '',
          environment: value.OAUTH_UI_ENVIRONMENT,
          basePath: value.OAUTH_UI_BASE_PATH as '/oauth',
        } satisfies OAuthUiConfig,
      }
      : {}),
  };
  if (!value.OAUTH_RESOURCE_SERVER_ENABLED) return base;
  const canonicalUrl = (input: string | undefined) => {
    if (input === undefined || input.length === 0) throw new Error('Invalid application configuration');
    return new URL(input).href;
  };
  const oauthResourceServer = {
    issuer: canonicalUrl(value.OAUTH_ISSUER),
    authorizationServer: canonicalUrl(value.OAUTH_AUTHORIZATION_SERVER),
    jwksUri: canonicalUrl(value.OAUTH_JWKS_URI),
    resourceUri: canonicalUrl(value.OAUTH_RESOURCE_URI),
    protectedMcpPath: value.OAUTH_PROTECTED_MCP_PATH,
    requiredScopes: value.OAUTH_REQUIRED_SCOPES?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    allowedClientIds: value.OAUTH_ALLOWED_CLIENT_IDS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    allowedAlgorithms: value.OAUTH_ALLOWED_ALGORITHMS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    clockSkewSeconds: value.OAUTH_CLOCK_SKEW_SECONDS,
    jwksTimeoutMs: value.OAUTH_JWKS_TIMEOUT_MS,
    jwksCooldownMs: value.OAUTH_JWKS_COOLDOWN_MS,
    jwksCacheMaxAgeMs: value.OAUTH_JWKS_CACHE_MAX_AGE_MS,
  } satisfies OAuthResourceServerConfig;
  return {
    ...base,
    OAUTH_RESOURCE_SERVER: oauthResourceServer,
    ...(value.EXTENSION_OAUTH_ENABLED ? {
      EXTENSION_OAUTH: {
        ...oauthResourceServer,
        resourceUri: canonicalUrl(value.EXTENSION_OAUTH_RESOURCE_URI),
        protectedMcpPath: '/extension/session',
        requiredScopes: value.EXTENSION_OAUTH_REQUIRED_SCOPES?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
        allowedClientIds: [value.EXTENSION_OAUTH_CLIENT_ID ?? ''],
        allowedAlgorithms: value.EXTENSION_OAUTH_ALLOWED_ALGORITHMS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
        clientId: value.EXTENSION_OAUTH_CLIENT_ID ?? '',
        redirectUri: canonicalUrl(value.EXTENSION_OAUTH_REDIRECT_URI),
        extensionOrigin: 'chrome-extension://' + (new URL(value.EXTENSION_OAUTH_REDIRECT_URI ?? '').hostname.split('.')[0] ?? ''),
      } satisfies ExtensionOAuthConfig,
    } : {}),
  };
});

export interface AppConfig {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly APP_ENV: 'local' | 'test' | 'staging' | 'production';
  readonly HOST: string;
  readonly PORT: number;
  readonly DATABASE_URL: string;
  readonly DIRECT_URL?: string;
  readonly RPG_API_KEY: string;
  readonly PUBLIC_BASE_URL?: string;
  readonly CHATGPT_APP_PROOF_MODE: boolean;
  readonly OAUTH_UI?: OAuthUiConfig;
  readonly OAUTH_RESOURCE_SERVER?: OAuthResourceServerConfig;
  readonly EXTENSION_OAUTH?: ExtensionOAuthConfig;
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  if (environment.NODE_ENV === 'production'
    && (environment.APP_ENV === undefined || environment.APP_ENV.trim().length === 0)) {
    throw new Error('Invalid application configuration');
  }
  const result = envSchema.safeParse(environment);
  if (!result.success) throw new Error('Invalid application configuration');
  return result.data;
}
