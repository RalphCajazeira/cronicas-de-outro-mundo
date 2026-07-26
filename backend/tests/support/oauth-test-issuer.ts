import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';
import type { OAuthResourceServerConfig } from '../../src/config/env.js';

type KeyName = 'primary' | 'rotated' | 'untrusted';
type JwksResponseMode = 'available' | 'invalid' | 'oversized' | 'redirect' | 'unavailable';

interface SigningKey {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

export interface SyntheticTokenOptions {
  readonly audience?: string | string[] | null;
  readonly clientId?: string | null;
  readonly expiresAt?: number | null;
  readonly issuedAt?: number | null;
  readonly issuer?: string;
  readonly key?: KeyName;
  readonly keyId?: string | null;
  readonly notBefore?: number;
  readonly protectedType?: string;
  readonly scope?: string;
  readonly subject?: string | null;
  readonly extraClaims?: JWTPayload;
}

export interface OAuthTestIssuer {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly requestCount: number;
  close(): Promise<void>;
  config(resourceUri: string, overrides?: Partial<OAuthResourceServerConfig>): OAuthResourceServerConfig;
  reset(): void;
  setDelay(delayMs: number): void;
  setPublishedKeys(keys: readonly KeyName[]): void;
  setResponseMode(mode: JwksResponseMode): void;
  sign(options?: SyntheticTokenOptions): Promise<string>;
}

async function signingKey(algorithm: 'ES256', keyId: string): Promise<SigningKey> {
  const pair = await generateKeyPair(algorithm, { extractable: true });
  const publicJwk = await exportJWK(pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      ...publicJwk,
      alg: algorithm,
      kid: keyId,
      key_ops: ['verify'],
      use: 'sig',
    },
  };
}

export async function startOAuthTestIssuer(): Promise<OAuthTestIssuer> {
  const keys: Record<KeyName, SigningKey> = {
    primary: await signingKey('ES256', 'primary-key'),
    rotated: await signingKey('ES256', 'rotated-key'),
    untrusted: await signingKey('ES256', 'untrusted-key'),
  };
  let publishedKeys: readonly KeyName[] = ['primary'];
  let responseMode: JwksResponseMode = 'available';
  let delayMs = 0;
  let requestCount = 0;

  const server = createServer((request, response) => {
    if (request.url !== '/jwks') {
      response.writeHead(404).end();
      return;
    }
    requestCount += 1;
    const send = () => {
      if (responseMode === 'unavailable') {
        response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}');
        return;
      }
      if (responseMode === 'invalid') {
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"keys":"invalid"}');
        return;
      }
      if (responseMode === 'oversized') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(' '.repeat(300 * 1_024));
        return;
      }
      if (responseMode === 'redirect') {
        response.writeHead(302, { location: '/redirected-jwks' }).end();
        return;
      }
      response.writeHead(200, { 'cache-control': 'public, max-age=60', 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: publishedKeys.map((name) => keys[name].publicJwk) }));
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('OAuth test issuer did not bind');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const issuer = `${origin}/issuer`;
  const jwksUri = `${origin}/jwks`;

  return {
    issuer,
    jwksUri,
    get requestCount() {
      return requestCount;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
    config(resourceUri, overrides = {}) {
      return {
        issuer,
        authorizationServer: issuer,
        jwksUri,
        resourceUri,
        protectedMcpPath: new URL(resourceUri).pathname,
        requiredScopes: ['openid'],
        allowedClientIds: [],
        allowedAlgorithms: ['ES256'],
        clockSkewSeconds: 0,
        jwksTimeoutMs: 200,
        jwksCooldownMs: 0,
        jwksCacheMaxAgeMs: 60_000,
        ...overrides,
      };
    },
    reset() {
      publishedKeys = ['primary'];
      responseMode = 'available';
      delayMs = 0;
      requestCount = 0;
    },
    setDelay(value) {
      delayMs = value;
    },
    setPublishedKeys(value) {
      publishedKeys = value;
    },
    setResponseMode(value) {
      responseMode = value;
    },
    async sign(options = {}) {
      const now = Math.floor(Date.now() / 1_000);
      const selectedKey = keys[options.key ?? 'primary'];
      const keyId = options.keyId === null ? undefined : options.keyId ?? selectedKey.publicJwk.kid;
      if (keyId !== undefined && typeof keyId !== 'string') throw new Error('Synthetic signing key id is unavailable');
      let token = new SignJWT({
        ...(options.extraClaims ?? {}),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.clientId === null ? {} : { client_id: options.clientId ?? 'synthetic-client' }),
      })
        .setProtectedHeader({
          alg: 'ES256',
          ...(keyId === undefined ? {} : { kid: keyId }),
          ...(options.protectedType === undefined ? {} : { typ: options.protectedType }),
        });
      const tokenIssuer = options.issuer ?? issuer;
      if (tokenIssuer.length > 0) token = token.setIssuer(tokenIssuer);
      if (options.subject !== null) token = token.setSubject(options.subject ?? 'synthetic-subject');
      const audience = options.audience === undefined
        ? 'http://127.0.0.1:3000/mcp-auth'
        : options.audience;
      if (audience !== null) token = token.setAudience(audience);
      if (options.issuedAt !== null) token = token.setIssuedAt(options.issuedAt ?? now);
      if (options.expiresAt !== null) token = token.setExpirationTime(options.expiresAt ?? now + 300);
      if (options.notBefore !== undefined) token = token.setNotBefore(options.notBefore);
      return token.sign(selectedKey.privateKey);
    },
  };
}

export function unsignedNoneToken(payload: JWTPayload): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

export async function symmetricToken(
  payload: JWTPayload,
  algorithm: 'HS256' | 'HS384' | 'HS512' = 'HS256',
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: algorithm, kid: 'symmetric-key' })
    .sign(randomBytes(64));
}

export async function closeHttpServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
