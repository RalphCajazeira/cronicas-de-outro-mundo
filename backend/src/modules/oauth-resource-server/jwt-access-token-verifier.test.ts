import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startOAuthTestIssuer,
  symmetricToken,
  unsignedNoneToken,
  type OAuthTestIssuer,
} from '../../../tests/support/oauth-test-issuer.js';
import {
  AccessTokenVerificationError,
  createJwtAccessTokenVerifier,
  readVerifiedExternalPrincipal,
} from './jwt-access-token-verifier.js';

const resourceUri = 'http://127.0.0.1:3000/mcp-auth';
let issuer: OAuthTestIssuer;

beforeAll(async () => {
  issuer = await startOAuthTestIssuer();
});

beforeEach(() => {
  issuer.reset();
});

afterAll(async () => {
  await issuer.close();
});

async function failureCategory(token: string, overrides = {}) {
  try {
    await createJwtAccessTokenVerifier(issuer.config(resourceUri, overrides)).verifyAccessToken(token);
    throw new Error('Expected token verification to fail');
  } catch (error) {
    if (!(error instanceof AccessTokenVerificationError)) throw error;
    return error;
  }
}

describe('JWT access token verification', () => {
  it('validates a signed token, exact principal, resource, expiration, and scopes', async () => {
    const token = await issuer.sign({
      audience: resourceUri,
      scope: 'openid profile',
      extraClaims: { email: 'ignored-attribute@example.test', arbitrary: 'ignored' },
    });
    const authInfo = await createJwtAccessTokenVerifier(issuer.config(resourceUri)).verifyAccessToken(token);

    expect(readVerifiedExternalPrincipal(authInfo)).toEqual({
      issuer: issuer.issuer,
      subject: 'synthetic-subject',
    });
    expect(authInfo.clientId).toBe('synthetic-client');
    expect(authInfo.scopes).toEqual(['openid', 'profile']);
    expect(authInfo.resource?.href).toBe(resourceUri);
    expect(authInfo.extra).toEqual({
      verifiedExternalPrincipal: {
        issuer: issuer.issuer,
        subject: 'synthetic-subject',
      },
    });
    expect(JSON.stringify(authInfo.extra)).not.toContain('ignored-attribute');
    expect(JSON.stringify(authInfo.extra)).not.toContain('arbitrary');
  });

  it.each([
    resourceUri,
    ['https://another-service.example.test', resourceUri],
  ])('accepts the expected resource in a standards-compatible aud shape: %o', async (audience) => {
    const token = await issuer.sign({ audience, scope: 'openid' });
    await expect(createJwtAccessTokenVerifier(issuer.config(resourceUri)).verifyAccessToken(token))
      .resolves.toMatchObject({ resource: new URL(resourceUri) });
  });

  it('caches a known JWKS instead of downloading it for every request', async () => {
    const verifier = createJwtAccessTokenVerifier(issuer.config(resourceUri));
    await verifier.verifyAccessToken(await issuer.sign({ audience: resourceUri, scope: 'openid' }));
    await verifier.verifyAccessToken(await issuer.sign({ audience: resourceUri, scope: 'openid', subject: 'second-subject' }));
    expect(issuer.requestCount).toBe(1);
  });

  it('reloads JWKS safely when a rotated key id appears after the initial cache fill', async () => {
    const verifier = createJwtAccessTokenVerifier(issuer.config(resourceUri, { jwksCooldownMs: 0 }));
    await verifier.verifyAccessToken(await issuer.sign({ audience: resourceUri, scope: 'openid' }));
    issuer.setPublishedKeys(['primary', 'rotated']);
    await expect(verifier.verifyAccessToken(await issuer.sign({
      audience: resourceUri,
      key: 'rotated',
      scope: 'openid',
    }))).resolves.toBeDefined();
    expect(issuer.requestCount).toBe(2);
  });

  it.each([
    ['issuer_invalid', async () => issuer.sign({ audience: resourceUri, issuer: 'https://other-issuer.example.test' })],
    ['issuer_invalid', async () => issuer.sign({ audience: resourceUri, issuer: '' })],
    ['audience_invalid', async () => issuer.sign({ audience: 'https://other-environment.example.test/mcp-auth' })],
    ['audience_invalid', async () => issuer.sign({ audience: null })],
    ['audience_invalid', async () => issuer.sign({ audience: `${resourceUri}/` })],
    ['audience_invalid', async () => issuer.sign({ audience: resourceUri.toUpperCase() })],
    ['audience_invalid', async () => issuer.sign({ audience: resourceUri.replace('/mcp-auth', '/mcp%2Dauth') })],
    ['audience_invalid', async () => issuer.sign({ audience: `${resourceUri}-other` })],
    ['audience_invalid', async () => issuer.sign({ audience: ['https://another-service.example.test'] })],
    ['token_expired', async () => issuer.sign({ audience: resourceUri, expiresAt: Math.floor(Date.now() / 1_000) - 1 })],
    ['token_not_active', async () => issuer.sign({ audience: resourceUri, notBefore: Math.floor(Date.now() / 1_000) + 60 })],
    ['token_not_active', async () => issuer.sign({ audience: resourceUri, issuedAt: Math.floor(Date.now() / 1_000) + 60 })],
    ['subject_invalid', async () => issuer.sign({ audience: resourceUri, subject: null })],
    ['token_malformed', async () => issuer.sign({ audience: resourceUri, expiresAt: null })],
    ['token_malformed', async () => issuer.sign({ audience: resourceUri, keyId: null })],
    ['token_malformed', async () => issuer.sign({ audience: resourceUri, protectedType: 'unexpected+jwt' })],
    ['signature_invalid', async () => issuer.sign({ audience: resourceUri, key: 'untrusted', keyId: 'primary-key' })],
    ['key_unknown', async () => issuer.sign({ audience: resourceUri, key: 'rotated' })],
  ] as const)('rejects %s tokens with a sanitized category', async (category, createToken) => {
    const error = await failureCategory(await createToken());
    expect(error).toMatchObject({ category, message: 'Access token is invalid' });
  });

  it('rejects malformed compact serialization', async () => {
    await expect(failureCategory('not-a-jwt')).resolves.toMatchObject({ category: 'token_malformed' });
    await expect(failureCategory('a'.repeat(8_193))).resolves.toMatchObject({ category: 'token_malformed' });
  });

  it('rejects none and every symmetric HS token before consulting JWKS', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const payload = { iss: issuer.issuer, sub: 'synthetic-subject', aud: resourceUri, exp: now + 60 };
    await expect(failureCategory(unsignedNoneToken(payload))).resolves.toMatchObject({ category: 'algorithm_forbidden' });
    for (const algorithm of ['HS256', 'HS384', 'HS512'] as const) {
      await expect(failureCategory(await symmetricToken(payload, algorithm), { allowedAlgorithms: ['ES256'] }))
        .resolves.toMatchObject({ category: 'algorithm_forbidden' });
    }
    expect(issuer.requestCount).toBe(0);
  });

  it('fails closed when JWKS is unavailable, invalid, or times out', async () => {
    issuer.setResponseMode('unavailable');
    await expect(failureCategory(await issuer.sign({ audience: resourceUri })))
      .resolves.toMatchObject({ category: 'jwks_unavailable' });

    issuer.reset();
    issuer.setResponseMode('invalid');
    await expect(failureCategory(await issuer.sign({ audience: resourceUri })))
      .resolves.toMatchObject({ category: 'jwks_invalid' });

    issuer.reset();
    issuer.setDelay(150);
    await expect(failureCategory(
      await issuer.sign({ audience: resourceUri }),
      { jwksTimeoutMs: 50 },
    )).resolves.toMatchObject({ category: 'jwks_timeout' });
  });

  it.each(['oversized', 'redirect'] as const)(
    'rejects a %s JWKS response without accepting redirected or unbounded key material',
    async (mode) => {
      issuer.setResponseMode(mode);
      await expect(failureCategory(await issuer.sign({ audience: resourceUri })))
        .resolves.toMatchObject({ category: 'jwks_invalid' });
      expect(issuer.requestCount).toBe(1);
    },
  );

  it('honors configured clock skew without requiring iat', async () => {
    const verifier = createJwtAccessTokenVerifier(issuer.config(resourceUri, { clockSkewSeconds: 30 }));
    const now = Math.floor(Date.now() / 1_000);
    await expect(verifier.verifyAccessToken(await issuer.sign({
      audience: resourceUri,
      expiresAt: now - 5,
      issuedAt: null,
      notBefore: now + 5,
    }))).resolves.toBeDefined();
  });
});
