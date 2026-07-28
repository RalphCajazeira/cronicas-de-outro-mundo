import { buildAuthorizationUrl, createPkceTransaction, exchangeCode, parseCallback } from '../auth/oauth-flow.js';
import type { ExtensionOAuthConfig, PublicAuthState } from '../auth/auth-types.js';

const configUrl = 'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/oauth-config';
const refreshStorageKey = 'cronicas.oauth.extension.refresh.v1';
const stagingExtensionId = 'ddmcennimefoiapgjhmienohiapencdm';
let accessToken: string | undefined;
let accessExpiresAt = 0;
let state: PublicAuthState = { status: 'signed_out' };
let loginInFlight = false;
let trustedStorage: Promise<boolean> | undefined;

export function ensureTrustedStorage(): Promise<boolean> {
  trustedStorage ??= chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .then(() => true)
    .catch(() => false);
  return trustedStorage;
}

function isConfig(value: unknown): value is ExtensionOAuthConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Record<string, unknown>;
  return typeof config.authorizationEndpoint === 'string' && typeof config.tokenEndpoint === 'string'
    && typeof config.clientId === 'string' && typeof config.resourceUri === 'string'
    && Array.isArray(config.scopes) && config.scopes.every((scope) => typeof scope === 'string');
}

async function loadConfig(): Promise<ExtensionOAuthConfig | undefined> {
  try {
    if (chrome.runtime.id !== stagingExtensionId) return undefined;
    const response = await fetch(configUrl, { cache: 'no-store', credentials: 'omit' });
    const body: unknown = await response.json();
    if (!response.ok || !isConfig(body)) return undefined;
    const authorization = new URL(body.authorizationEndpoint);
    const token = new URL(body.tokenEndpoint);
    const resource = new URL(body.resourceUri);
    if (authorization.protocol !== 'https:' || token.protocol !== 'https:' || resource.origin !== 'https://cronicas-de-outro-mundo-staging-api.onrender.com'
      || !authorization.hostname.endsWith('.supabase.co') || authorization.pathname !== '/auth/v1/oauth/authorize'
      || token.origin !== authorization.origin || token.pathname !== '/auth/v1/oauth/token'
      || resource.pathname !== '/extension/session' || body.clientId.length === 0 || body.clientId.length > 512) return undefined;
    return body;
  } catch { return undefined; }
}

async function writeRefresh(refreshToken: string | undefined): Promise<void> {
  if (!await ensureTrustedStorage()) throw new Error('Trusted extension storage is unavailable');
  if (refreshToken === undefined) await chrome.storage.local.remove(refreshStorageKey);
  else await chrome.storage.local.set({ [refreshStorageKey]: { refreshToken } });
}

async function readRefresh(): Promise<string | undefined> {
  if (!await ensureTrustedStorage()) throw new Error('Trusted extension storage is unavailable');
  const stored = await chrome.storage.local.get(refreshStorageKey);
  const value = stored[refreshStorageKey];
  if (typeof value === 'object' && value !== null && typeof (value as { refreshToken?: unknown }).refreshToken === 'string') {
    return (value as { refreshToken: string }).refreshToken;
  }
  if (value !== undefined) await chrome.storage.local.remove(refreshStorageKey);
  return undefined;
}

async function loadPublicSession(config: ExtensionOAuthConfig, token: string): Promise<PublicAuthState> {
  try {
    const response = await fetch(config.resourceUri, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store', credentials: 'omit' });
    const body: unknown = await response.json();
    if (response.status === 401) return { status: 'expired' };
    if (response.status === 403) return { status: 'error', code: 'user_revoked' };
    const user = typeof body === 'object' && body !== null ? (body as { user?: unknown }).user : undefined;
    if (!response.ok || typeof user !== 'object' || user === null || typeof (user as { displayName?: unknown }).displayName !== 'string') return { status: 'error', code: 'backend_unavailable' };
    return { status: 'authenticated', user: { displayName: (user as { displayName: string }).displayName } };
  } catch { return { status: 'error', code: 'backend_unavailable' }; }
}

async function refresh(config: ExtensionOAuthConfig, refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(config.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: config.clientId }) });
    const body: unknown = await response.json();
    if (!response.ok || typeof body !== 'object' || body === null) return false;
    const tokens = body as Record<string, unknown>;
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string' || typeof tokens.expires_in !== 'number') return false;
    accessToken = tokens.access_token; accessExpiresAt = Date.now() + tokens.expires_in * 1_000;
    await writeRefresh(tokens.refresh_token); return true;
  } catch { return false; }
}

export async function getAuthState(): Promise<PublicAuthState> {
  if (state.status === 'authenticated' && accessToken !== undefined && accessExpiresAt > Date.now() + 15_000) return state;
  let refreshToken: string | undefined;
  try {
    refreshToken = await readRefresh();
  } catch { return state = { status: 'error', code: 'configuration_invalid' }; }
  if (refreshToken === undefined) return state = { status: 'signed_out' };
  const config = await loadConfig();
  if (config === undefined) return state = { status: 'error', code: 'configuration_invalid' };
  try {
    if (!await refresh(config, refreshToken)) {
      await writeRefresh(undefined);
      return state = { status: 'signed_out' };
    }
  } catch { return state = { status: 'error', code: 'configuration_invalid' }; }
  const next = await loadPublicSession(config, accessToken ?? '');
  if (next.status === 'expired' || next.status === 'error') {
    accessToken = undefined;
    accessExpiresAt = 0;
    try { await writeRefresh(undefined); } catch { return state = { status: 'error', code: 'configuration_invalid' }; }
  }
  return state = next;
}

export async function login(): Promise<PublicAuthState> {
  if (loginInFlight) return state;
  loginInFlight = true;
  try {
    state = { status: 'authorizing' };
    if (!await ensureTrustedStorage()) return state = { status: 'error', code: 'configuration_invalid' };
    const config = await loadConfig();
    if (config === undefined) return state = { status: 'error', code: 'configuration_invalid' };
    const redirectUri = chrome.identity.getRedirectURL('oauth2');
    const transaction = await createPkceTransaction();
    const callback = await chrome.identity.launchWebAuthFlow({ url: buildAuthorizationUrl(config, redirectUri, transaction), interactive: true });
    if (callback === undefined) return state = { status: 'error', code: 'cancelled' };
    const parsed = parseCallback(callback, redirectUri, transaction.state);
    if (parsed.code === undefined) return state = { status: 'error', code: parsed.error ?? 'redirect_invalid' };
    const tokens = await exchangeCode(config, redirectUri, parsed.code, transaction.verifier);
    if ('error' in tokens) return state = { status: 'error', code: tokens.error };
    accessToken = tokens.accessToken; accessExpiresAt = tokens.expiresAt;
    await writeRefresh(tokens.refreshToken);
    return state = await loadPublicSession(config, tokens.accessToken);
  } catch { return state = { status: 'error', code: 'backend_unavailable' }; }
  finally { loginInFlight = false; }
}

export async function logout(): Promise<PublicAuthState> {
  accessToken = undefined; accessExpiresAt = 0;
  try {
    await writeRefresh(undefined);
  } catch {
    return state = { status: 'error', code: 'configuration_invalid' };
  }
  return state = { status: 'signed_out' };
}
