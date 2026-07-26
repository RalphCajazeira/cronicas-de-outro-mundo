import { UserStatus } from '../../generated/prisma/client.js';
import {
  ExternalIdentityConflictError,
  ExternalIdentityNotFoundError,
  InvalidExternalPrincipalError,
  UserIdentityIntegrityError,
  UserSuspendedError,
  UserUnavailableError,
} from './identity.errors.js';
import type { IdentityRepository, ResolvedIdentity, VerifiedExternalPrincipal } from './identity.types.js';

function isValidPrincipalPart(value: string, maximumLength: number): boolean {
  return value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\r\n]/u.test(value);
}

function validatePrincipal(principal: VerifiedExternalPrincipal): void {
  if (!isValidPrincipalPart(principal.issuer, 512) || !isValidPrincipalPart(principal.subject, 512)) {
    throw new InvalidExternalPrincipalError();
  }
}

export function createIdentityService(repository: IdentityRepository) {
  return {
    async resolveActiveUser(principal: VerifiedExternalPrincipal): Promise<ResolvedIdentity> {
      validatePrincipal(principal);
      const matches = await repository.findByPrincipal(principal);
      if (matches.length === 0) throw new ExternalIdentityNotFoundError();
      if (matches.length !== 1) throw new ExternalIdentityConflictError();

      const identity = matches[0];
      if (identity === undefined
        || identity.issuer !== principal.issuer
        || identity.subject !== principal.subject) {
        throw new ExternalIdentityConflictError();
      }

      const { user } = identity;
      if (user.status === UserStatus.SUSPENDED) throw new UserSuspendedError();
      if (user.status === UserStatus.DELETED) throw new UserUnavailableError();
      if (user.status !== UserStatus.ACTIVE || user.suspendedAt !== null || user.deletedAt !== null) {
        throw new UserIdentityIntegrityError();
      }

      return { externalIdentityId: identity.id, userId: user.id, user };
    },
  };
}
