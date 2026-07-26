import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthResourceServerConfig } from '../../config/env.js';
import type { VerifiedExternalPrincipal } from '../identity/identity.types.js';

export type AccessTokenFailureCategory =
  | 'algorithm_forbidden'
  | 'audience_invalid'
  | 'issuer_invalid'
  | 'jwks_invalid'
  | 'jwks_timeout'
  | 'jwks_unavailable'
  | 'key_unknown'
  | 'signature_invalid'
  | 'subject_invalid'
  | 'token_expired'
  | 'token_malformed'
  | 'token_not_active';

export type IssuerDisposition = 'allowed' | 'missing' | 'not_evaluated' | 'rejected';

const maximumAccessTokenLength = 8_192;
const maximumJwksResponseBytes = 256 * 1_024;

export class AccessTokenVerificationError extends Error {
  constructor(
    readonly category: AccessTokenFailureCategory,
    readonly issuerDisposition: IssuerDisposition,
  ) {
    super('Access token is invalid');
    this.name = 'AccessTokenVerificationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function readVerifiedExternalPrincipal(authInfo: AuthInfo | undefined): VerifiedExternalPrincipal | undefined {
  const principal = authInfo?.extra?.verifiedExternalPrincipal;
  if (!isRecord(principal)) return undefined;
  const issuer = principal.issuer;
  const subject = principal.subject;
  if (typeof issuer !== 'string' || typeof subject !== 'string') return undefined;
  return { issuer, subject };
}

function scopeClaim(payload: JWTPayload): string[] {
  const scope = payload.scope;
  if (scope === undefined) return [];
  if (typeof scope !== 'string'
    || scope.length > 2_048
    || [...scope].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw new AccessTokenVerificationError('token_malformed', 'allowed');
  }
  const scopes = scope.split(' ').filter(Boolean);
  if (new Set(scopes).size !== scopes.length
    || scopes.some((item) => !/^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/u.test(item))) {
    throw new AccessTokenVerificationError('token_malformed', 'allowed');
  }
  return scopes;
}

function clientIdClaim(payload: JWTPayload): string | undefined {
  const clientId = payload.client_id;
  if (clientId === undefined) return undefined;
  if (typeof clientId !== 'string'
    || clientId.length === 0
    || clientId.length > 512
    || clientId.trim() !== clientId
    || hasAsciiControlCharacter(clientId)) {
    throw new AccessTokenVerificationError('token_malformed', 'allowed');
  }
  return clientId;
}

async function readBoundedResponseBody(response: Response): Promise<ArrayBuffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumJwksResponseBytes) {
      await response.body?.cancel();
      throw new AccessTokenVerificationError('jwks_invalid', 'not_evaluated');
    }
  }
  if (response.body === null) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalLength += value.byteLength;
      if (totalLength > maximumJwksResponseBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort cancellation; the response is rejected either way.
        }
        throw new AccessTokenVerificationError('jwks_invalid', 'not_evaluated');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new ArrayBuffer(totalLength);
  const bodyView = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    bodyView.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function createBoundedJwksFetch(expectedJwksUri: string) {
  return async (resource: string, options: {
    method: 'GET';
    headers: Headers;
    redirect: 'manual';
    signal: AbortSignal;
  }): Promise<Response> => {
    if (new URL(resource).href !== expectedJwksUri || options.redirect !== 'manual') {
      throw new AccessTokenVerificationError('jwks_invalid', 'not_evaluated');
    }
    const response = await fetch(resource, options);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new AccessTokenVerificationError('jwks_invalid', 'not_evaluated');
    }
    if (response.status !== 200) return response;
    const body = await readBoundedResponseBody(response);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function mapVerificationError(error: unknown): AccessTokenVerificationError {
  if (error instanceof AccessTokenVerificationError) return error;
  if (error instanceof errors.JWTExpired) {
    return new AccessTokenVerificationError('token_expired', 'allowed');
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new AccessTokenVerificationError('issuer_invalid', 'rejected');
    if (error.claim === 'aud') return new AccessTokenVerificationError('audience_invalid', 'allowed');
    if (error.claim === 'nbf') return new AccessTokenVerificationError('token_not_active', 'allowed');
    if (error.claim === 'exp') return new AccessTokenVerificationError('token_malformed', 'allowed');
    if (error.claim === 'sub') return new AccessTokenVerificationError('subject_invalid', 'allowed');
    return new AccessTokenVerificationError('token_malformed', 'not_evaluated');
  }
  if (error instanceof errors.JOSEAlgNotAllowed || error instanceof errors.JOSENotSupported) {
    return new AccessTokenVerificationError('algorithm_forbidden', 'not_evaluated');
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return new AccessTokenVerificationError('signature_invalid', 'not_evaluated');
  }
  if (error instanceof errors.JWKSNoMatchingKey) {
    return new AccessTokenVerificationError('key_unknown', 'not_evaluated');
  }
  if (error instanceof errors.JWKSTimeout) {
    return new AccessTokenVerificationError('jwks_timeout', 'not_evaluated');
  }
  if (error instanceof errors.JWKSInvalid
    || error instanceof errors.JWKInvalid
    || error instanceof errors.JWKSMultipleMatchingKeys) {
    return new AccessTokenVerificationError('jwks_invalid', 'not_evaluated');
  }
  if (error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid) {
    return new AccessTokenVerificationError('token_malformed', 'not_evaluated');
  }
  return new AccessTokenVerificationError('jwks_unavailable', 'not_evaluated');
}

export function createJwtAccessTokenVerifier(
  config: OAuthResourceServerConfig,
): OAuthTokenVerifier {
  const remoteJwks = createRemoteJWKSet(new URL(config.jwksUri), {
    timeoutDuration: config.jwksTimeoutMs,
    cooldownDuration: config.jwksCooldownMs,
    cacheMaxAge: config.jwksCacheMaxAgeMs,
    [customFetch]: createBoundedJwksFetch(config.jwksUri),
  });
  const expectedResource = new URL(config.resourceUri);

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token.length === 0 || token.length > maximumAccessTokenLength) {
        throw new AccessTokenVerificationError('token_malformed', 'not_evaluated');
      }
      let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
      try {
        protectedHeader = decodeProtectedHeader(token);
      } catch {
        throw new AccessTokenVerificationError('token_malformed', 'not_evaluated');
      }
      if (typeof protectedHeader.alg !== 'string'
        || !config.allowedAlgorithms.includes(protectedHeader.alg)
        || protectedHeader.alg === 'none'
        || protectedHeader.alg.startsWith('HS')) {
        throw new AccessTokenVerificationError('algorithm_forbidden', 'not_evaluated');
      }
      if (typeof protectedHeader.kid !== 'string'
        || protectedHeader.kid.length === 0
        || protectedHeader.kid.length > 256
        || hasAsciiControlCharacter(protectedHeader.kid)) {
        throw new AccessTokenVerificationError('token_malformed', 'not_evaluated');
      }
      if (protectedHeader.typ !== undefined
        && protectedHeader.typ !== 'JWT'
        && protectedHeader.typ !== 'at+jwt') {
        throw new AccessTokenVerificationError('token_malformed', 'not_evaluated');
      }

      try {
        const { payload } = await jwtVerify(token, remoteJwks, {
          issuer: config.issuer,
          audience: config.resourceUri,
          algorithms: [...config.allowedAlgorithms],
          requiredClaims: ['exp', 'sub'],
          clockTolerance: config.clockSkewSeconds,
        });
        const subject = payload.sub;
        if (typeof subject !== 'string'
          || subject.length === 0
          || subject.length > 512
          || subject.trim() !== subject
          || /[\r\n]/u.test(subject)) {
          throw new AccessTokenVerificationError('subject_invalid', 'allowed');
        }
        if (payload.iat !== undefined
          && (!Number.isSafeInteger(payload.iat)
            || payload.iat < 0
            || payload.iat > Math.floor(Date.now() / 1_000) + config.clockSkewSeconds)) {
          throw new AccessTokenVerificationError('token_not_active', 'allowed');
        }
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
          throw new AccessTokenVerificationError('token_malformed', 'allowed');
        }
        const clientId = clientIdClaim(payload);

        const principal: VerifiedExternalPrincipal = { issuer: config.issuer, subject };
        const extra: Record<string, unknown> = { verifiedExternalPrincipal: principal };
        return {
          token,
          clientId: clientId ?? 'not-validated',
          scopes: scopeClaim(payload),
          expiresAt: payload.exp + config.clockSkewSeconds,
          resource: expectedResource,
          extra,
        };
      } catch (error) {
        throw mapVerificationError(error);
      }
    },
  };
}
