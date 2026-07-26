import { describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_STORAGE_KEY,
  OAUTH_SESSION_STORAGE_KEY,
  decideAuthorization,
  isSafeReturnedRedirect,
  loadConsent,
  parseAuthorizationId,
  parseScopes,
  signInForAuthorization,
  type OAuthPort,
} from '../src/oauth-flow.js';

const authorizationId = 'B6m9yKp4sR2tV8wX0z_a-C3dF7gH1jLn';
const redirectUri = 'https://chatgpt.com/connector/oauth/callback';

function port(overrides: Partial<OAuthPort> = {}): OAuthPort {
  return {
    signInWithPassword: vi.fn().mockResolvedValue({ data: { user: { id: 'synthetic' } }, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'synthetic' } }, error: null }),
    getAuthorizationDetails: vi.fn().mockResolvedValue({
      data: {
        authorization_id: authorizationId,
        client: { name: '<untrusted-client>' },
        redirect_uri: redirectUri,
        scope: 'openid email',
      },
      error: null,
    }),
    approveAuthorization: vi.fn().mockResolvedValue({
      data: { redirect_url: `${redirectUri}?code=opaque&state=opaque` },
      error: null,
    }),
    denyAuthorization: vi.fn().mockResolvedValue({
      data: { redirect_url: `${redirectUri}?error=access_denied&state=opaque` },
      error: null,
    }),
    ...overrides,
  };
}

describe('OAuth UI flow', () => {
  it('uses a tab-scoped storage key and preserves bounded opaque authorization IDs', () => {
    expect(AUTHORIZATION_STORAGE_KEY).toBe('cronicas.oauth.authorization-id');
    expect(OAUTH_SESSION_STORAGE_KEY).toBe('cronicas.oauth.session');
    expect(parseAuthorizationId(authorizationId)).toBe(authorizationId);
    expect(parseAuthorizationId(authorizationId.toUpperCase())).toBe(authorizationId.toUpperCase());
    expect(parseAuthorizationId('similar-client')).toBeUndefined();
    expect(parseAuthorizationId('x'.repeat(129))).toBeUndefined();
    expect(parseAuthorizationId('opaque authorization id')).toBeUndefined();
  });

  it('keeps supported scope strings bounded and rejects malformed scope lists', () => {
    expect(parseScopes('openid email profile')).toEqual(['openid', 'email', 'profile']);
    expect(parseScopes('openid openid')).toEqual([]);
    expect(parseScopes(`openid ${'x'.repeat(101)}`)).toEqual([]);
  });

  it('performs password login through the narrow auth port with generic success state', async () => {
    const oauth = port();
    await expect(signInForAuthorization(oauth, 'synthetic@example.test', 'strong-password')).resolves.toBe(true);
    expect(oauth.signInWithPassword).toHaveBeenCalledWith({
      email: 'synthetic@example.test',
      password: 'strong-password',
    });
    await expect(signInForAuthorization(oauth, '', 'password')).resolves.toBe(false);
  });

  it('loads consent only for an authenticated user and handles existing consent redirects', async () => {
    await expect(loadConsent(port(), authorizationId)).resolves.toMatchObject({
      kind: 'consent',
      details: { authorization_id: authorizationId },
    });
    await expect(loadConsent(port({
      getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    }), authorizationId)).resolves.toEqual({ kind: 'login_required' });
    await expect(loadConsent(port({
      getAuthorizationDetails: vi.fn().mockResolvedValue({
        data: { redirect_url: `${redirectUri}?code=existing` },
        error: null,
      }),
    }), authorizationId)).resolves.toEqual({
      kind: 'redirect',
      redirectUrl: `${redirectUri}?code=existing`,
    });
    await expect(loadConsent(port({
      getAuthorizationDetails: vi.fn().mockResolvedValue({
        data: {
          authorization_id: authorizationId.toLowerCase(),
          client: { name: '<untrusted-client>' },
          redirect_uri: redirectUri,
          scope: 'openid email',
        },
        error: null,
      }),
    }), authorizationId)).resolves.toEqual({ kind: 'error' });
  });

  it.each(['approve', 'deny'] as const)('accepts only the SDK redirect for %s', async (decision) => {
    await expect(decideAuthorization(port(), decision, authorizationId, redirectUri))
      .resolves.toMatch(/^https:\/\/chatgpt\.com\/connector\/oauth\/callback\?/u);
  });

  it('rejects a redirect whose base differs from the approved client redirect', async () => {
    expect(isSafeReturnedRedirect('https://evil.example/callback?code=x', redirectUri)).toBe(false);
    expect(isSafeReturnedRedirect(`${redirectUri}/similar?code=x`, redirectUri)).toBe(false);
    expect(isSafeReturnedRedirect(`${redirectUri}?code=x`, redirectUri)).toBe(true);
    await expect(decideAuthorization(port({
      approveAuthorization: vi.fn().mockResolvedValue({
        data: { redirect_url: 'https://evil.example/callback?code=x' },
        error: null,
      }),
    }), 'approve', authorizationId, redirectUri)).resolves.toBeUndefined();
  });
});
