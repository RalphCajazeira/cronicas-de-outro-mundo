import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthResourceServerConfig } from '../../config/env.js';
import {
  ExternalIdentityConflictError,
  ExternalIdentityNotFoundError,
  InvalidExternalPrincipalError,
  UserIdentityIntegrityError,
  UserSuspendedError,
  UserUnavailableError,
} from '../identity/identity.errors.js';
import type { createIdentityService } from '../identity/identity.service.js';
import {
  setAuthenticationAudit,
  updateAuthenticationAudit,
} from '../../shared/http/request-audit.js';
import {
  AccessTokenVerificationError,
  createJwtAccessTokenVerifier,
  readVerifiedExternalPrincipal,
} from './jwt-access-token-verifier.js';

export interface AuthenticatedMcpContext {
  readonly bindingFingerprint: string;
  readonly userStatus: 'ACTIVE';
}

type IdentityService = ReturnType<typeof createIdentityService>;
const maximumBearerTokenLength = 8_192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readAuthenticatedMcpContext(authInfo: AuthInfo | undefined): AuthenticatedMcpContext | undefined {
  const context = authInfo?.extra?.authenticatedMcp;
  if (!isRecord(context)) return undefined;
  const bindingFingerprint = context.bindingFingerprint;
  const userStatus = context.userStatus;
  if (typeof bindingFingerprint !== 'string' || userStatus !== 'ACTIVE') return undefined;
  return { bindingFingerprint, userStatus };
}

function subjectFingerprint(issuer: string, subject: string): string {
  return createHash('sha256')
    .update('subject-audit:v1')
    .update('\0')
    .update(issuer)
    .update('\0')
    .update(subject)
    .digest('hex')
    .slice(0, 12);
}

function bindingFingerprint(issuer: string, subject: string, userId: string): string {
  return createHash('sha256')
    .update('mcp-binding:v1')
    .update('\0')
    .update(issuer)
    .update('\0')
    .update(subject)
    .update('\0')
    .update(userId)
    .digest('hex');
}

function hasSingleStrictBearerHeader(request: Request): boolean {
  let authorizationHeaderCount = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') authorizationHeaderCount += 1;
  }
  const authorization = request.headers.authorization;
  return authorizationHeaderCount === 1
    && typeof authorization === 'string'
    && authorization.length <= 'Bearer '.length + maximumBearerTokenLength
    && /^Bearer [^\s,]+$/iu.test(authorization);
}

function removeAuthorizationCredential(request: Request): void {
  delete request.headers.authorization;
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (request.rawHeaders[index]?.toLowerCase() === 'authorization') {
      request.rawHeaders.splice(index, 2);
    }
  }
}

function identityFailureCategory(error: unknown): string {
  if (error instanceof ExternalIdentityNotFoundError) return 'identity_not_found';
  if (error instanceof UserSuspendedError) return 'user_suspended';
  if (error instanceof UserUnavailableError) return 'user_unavailable';
  if (error instanceof ExternalIdentityConflictError) return 'identity_conflict';
  if (error instanceof UserIdentityIntegrityError) return 'identity_inconsistent';
  if (error instanceof InvalidExternalPrincipalError) return 'principal_invalid';
  return 'identity_resolution_failed';
}

function sendIdentityDenied(response: Response): void {
  response.status(403).json({
    error: 'access_denied',
    error_description: 'Authenticated principal is not authorized',
  });
}

export function createOAuthResourceServerAuthentication(
  config: OAuthResourceServerConfig,
  identityService: IdentityService,
): RequestHandler {
  const tokenVerifier = createJwtAccessTokenVerifier(config);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.resourceUri));

  return (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.header('authorization');
    const queryCredentialPresent = new URL(request.originalUrl, 'http://localhost').searchParams.has('access_token');
    const initialCategory = queryCredentialPresent
      ? 'query_credential_forbidden'
      : authorization === undefined
      ? 'token_missing'
      : hasSingleStrictBearerHeader(request)
        ? 'token_pending_validation'
        : 'token_malformed';
    setAuthenticationAudit(response, {
      category: initialCategory,
      issuerDisposition: 'not_evaluated',
      result: 'pending',
    });
    if (queryCredentialPresent || (authorization !== undefined && !hasSingleStrictBearerHeader(request))) {
      request.headers.authorization = 'Bearer malformed';
    }

    const auditedVerifier = {
      async verifyAccessToken(token: string): Promise<AuthInfo> {
        try {
          const authInfo = await tokenVerifier.verifyAccessToken(token);
          const principal = readVerifiedExternalPrincipal(authInfo);
          const hasRequiredScopes = config.requiredScopes.every((scope) => authInfo.scopes.includes(scope));
          updateAuthenticationAudit(response, {
            category: hasRequiredScopes ? 'token_valid' : 'scope_insufficient',
            issuerDisposition: 'allowed',
            result: hasRequiredScopes ? 'pending' : 'denied',
            ...(principal === undefined
              ? {}
              : { subjectFingerprint: subjectFingerprint(principal.issuer, principal.subject) }),
          });
          return authInfo;
        } catch (error) {
          const verificationError = error instanceof AccessTokenVerificationError
            ? error
            : new AccessTokenVerificationError('jwks_unavailable', 'not_evaluated');
          updateAuthenticationAudit(response, {
            category: queryCredentialPresent ? 'query_credential_forbidden' : verificationError.category,
            issuerDisposition: verificationError.issuerDisposition,
            result: 'denied',
          });
          throw new InvalidTokenError('Access token is invalid');
        }
      },
    };

    const bearerAuthentication = requireBearerAuth({
      verifier: auditedVerifier,
      requiredScopes: [...config.requiredScopes],
      resourceMetadataUrl,
    });
    bearerAuthentication(request, response, (bearerError?: unknown) => {
      if (bearerError !== undefined) {
        next(bearerError);
        return;
      }
      const principal = readVerifiedExternalPrincipal(request.auth);
      if (principal === undefined) {
        updateAuthenticationAudit(response, {
          category: 'principal_invalid',
          issuerDisposition: 'not_evaluated',
          result: 'denied',
        });
        sendIdentityDenied(response);
        return;
      }
      if (config.allowedClientIds.length > 0
        && (request.auth === undefined || !config.allowedClientIds.includes(request.auth.clientId))) {
        updateAuthenticationAudit(response, {
          category: 'client_not_allowed',
          issuerDisposition: 'allowed',
          result: 'denied',
        });
        sendIdentityDenied(response);
        return;
      }

      void identityService.resolveActiveUser(principal).then((identity) => {
        const authenticatedMcp: AuthenticatedMcpContext = {
          bindingFingerprint: bindingFingerprint(principal.issuer, principal.subject, identity.userId),
          userStatus: 'ACTIVE',
        };
        request.auth = {
          token: '',
          clientId: '',
          scopes: [],
          extra: { authenticatedMcp },
        };
        removeAuthorizationCredential(request);
        updateAuthenticationAudit(response, {
          category: 'authenticated',
          issuerDisposition: 'allowed',
          result: 'allowed',
        });
        next();
      }).catch((error: unknown) => {
        updateAuthenticationAudit(response, {
          category: identityFailureCategory(error),
          issuerDisposition: 'allowed',
          result: 'denied',
        });
        sendIdentityDenied(response);
      });
    });
  };
}
