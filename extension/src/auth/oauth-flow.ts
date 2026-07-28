import type { ExtensionOAuthConfig, PublicAuthErrorCode } from './auth-types.js';

const verifierLength = 64;
const stateLength = 32;

function base64Url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function randomBase64Url(length: number, random: Crypto = crypto): string {
  return base64Url(random.getRandomValues(new Uint8Array(length)));
}

export async function createPkceTransaction(random: Crypto = crypto): Promise<{ readonly state: string; readonly verifier: string; readonly challenge: string }> {
  const verifier = randomBase64Url(verifierLength, random);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { state: randomBase64Url(stateLength, random), verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizationUrl(config: ExtensionOAuthConfig, redirectUri: string, transaction: { state: string; challenge: string }): string {
  const url = new URL(config.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri,
    state: transaction.state,
    code_challenge: transaction.challenge,
    code_challenge_method: 'S256',
    scope: config.scopes.join(' '),
  }).toString();
  return url.href;
}

export function parseCallback(callbackUrl: string, redirectUri: string, expectedState: string): { readonly code?: string; readonly error?: PublicAuthErrorCode } {
  try {
    const callback = new URL(callbackUrl);
    const expected = new URL(redirectUri);
    if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash.length > 0) return { error: 'redirect_invalid' };
    if (callback.searchParams.get('state') !== expectedState) return { error: 'state_invalid' };
    if (callback.searchParams.has('error')) return { error: callback.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'backend_unavailable' };
    const code = callback.searchParams.get('code');
    if (code === null || code.length === 0 || code.length > 2_048) return { error: 'redirect_invalid' };
    return { code };
  } catch {
    return { error: 'redirect_invalid' };
  }
}

export async function exchangeCode(
  config: ExtensionOAuthConfig,
  redirectUri: string,
  code: string,
  verifier: string,
): Promise<{ readonly accessToken: string; readonly refreshToken: string; readonly expiresAt: number } | { readonly error: PublicAuthErrorCode }> {
  try {
    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId, redirect_uri: redirectUri, code_verifier: verifier }),
    });
    const body: unknown = await response.json();
    if (!response.ok || typeof body !== 'object' || body === null) return { error: 'backend_unavailable' };
    const token = body as Record<string, unknown>;
    if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || typeof token.expires_in !== 'number') return { error: 'backend_unavailable' };
    return { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1_000 };
  } catch {
    return { error: 'backend_unavailable' };
  }
}
