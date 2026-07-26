import type { UserStatus } from '../../generated/prisma/client.js';

export interface VerifiedExternalPrincipal {
  readonly issuer: string;
  readonly subject: string;
}

export interface IdentityUserRecord {
  readonly id: string;
  readonly status: UserStatus;
  readonly suspendedAt: Date | null;
  readonly deletedAt: Date | null;
}

export interface ExternalIdentityRecord {
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly user: IdentityUserRecord;
}

export interface ResolvedIdentity {
  readonly externalIdentityId: string;
  readonly userId: string;
  readonly user: IdentityUserRecord;
}

export interface IdentityRepository {
  findByPrincipal(principal: VerifiedExternalPrincipal): Promise<readonly ExternalIdentityRecord[]>;
}
