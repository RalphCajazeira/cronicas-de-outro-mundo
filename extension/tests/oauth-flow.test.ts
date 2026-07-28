import { describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, createPkceTransaction, parseCallback } from '../src/auth/oauth-flow.js';

const config = {
  authorizationEndpoint: 'https://project.supabase.co/auth/v1/oauth/authorize',
  tokenEndpoint: 'https://project.supabase.co/auth/v1/oauth/token',
  clientId: 'extension-public-client',
  resourceUri: 'https://cronicas-de-outro-mundo-staging-api.onrender.com/extension/session',
  scopes: ['openid', 'profile'],
};
const redirectUri = 'https://ddmcennimefoiapgjhmienohiapencdm.chromiumapp.org/oauth2';

describe('extension OAuth PKCE', () => {
  it('generates an S256 authorization request without a secret', async () => {
    const transaction = await createPkceTransaction();
    const url = new URL(buildAuthorizationUrl(config, redirectUri, transaction));
    expect(transaction.verifier).toHaveLength(86);
    expect(transaction.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  it('rejects divergent state, replay-like callbacks, errors, fragments, and missing codes', () => {
    expect(parseCallback(redirectUri + '?code=one&state=other', redirectUri, 'expected')).toEqual({ error: 'state_invalid' });
    expect(parseCallback(redirectUri + '?state=expected', redirectUri, 'expected')).toEqual({ error: 'redirect_invalid' });
    expect(parseCallback(redirectUri + '?error=access_denied&state=expected', redirectUri, 'expected')).toEqual({ error: 'cancelled' });
    expect(parseCallback(redirectUri + '?code=one&state=expected#token=forbidden', redirectUri, 'expected')).toEqual({ error: 'redirect_invalid' });
    expect(parseCallback(redirectUri + '?code=one&state=expected', redirectUri, 'expected')).toEqual({ code: 'one' });
  });
});
