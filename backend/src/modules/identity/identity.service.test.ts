import { UserStatus } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createIdentityService } from './identity.service.js';
import type {
  ExternalIdentityRecord,
  IdentityRepository,
  VerifiedExternalPrincipal,
} from './identity.types.js';

const principal: VerifiedExternalPrincipal = {
  issuer: 'https://identity.example.test',
  subject: 'provider-subject-1',
};

function identity(status: UserStatus = UserStatus.ACTIVE): ExternalIdentityRecord {
  return {
    id: '10000000-0000-0000-0000-000000000001',
    issuer: principal.issuer,
    subject: principal.subject,
    user: {
      id: '20000000-0000-0000-0000-000000000001',
      status,
      suspendedAt: status === UserStatus.SUSPENDED ? new Date('2026-07-25T00:00:00.000Z') : null,
      deletedAt: status === UserStatus.DELETED ? new Date('2026-07-25T00:00:00.000Z') : null,
    },
  };
}

function repository(records: readonly ExternalIdentityRecord[]): IdentityRepository {
  return { findByPrincipal: () => Promise.resolve(records) };
}

describe('identity service', () => {
  it('resolves an active user only by the verified issuer and subject', async () => {
    await expect(createIdentityService(repository([identity()])).resolveActiveUser(principal)).resolves.toMatchObject({
      externalIdentityId: '10000000-0000-0000-0000-000000000001',
      userId: '20000000-0000-0000-0000-000000000001',
      user: {
        id: '20000000-0000-0000-0000-000000000001',
        status: UserStatus.ACTIVE,
      },
    });
  });

  it('rejects an identity that is not linked', async () => {
    await expect(createIdentityService(repository([])).resolveActiveUser(principal)).rejects.toMatchObject({
      statusCode: 401,
      code: 'EXTERNAL_IDENTITY_NOT_FOUND',
    });
  });

  it('rejects ambiguous and mismatched identity results', async () => {
    const service = createIdentityService(repository([identity(), identity()]));
    await expect(service.resolveActiveUser(principal)).rejects.toMatchObject({
      statusCode: 500,
      code: 'EXTERNAL_IDENTITY_CONFLICT',
    });

    await expect(createIdentityService(repository([{ ...identity(), subject: 'other' }]))
      .resolveActiveUser(principal)).rejects.toMatchObject({ code: 'EXTERNAL_IDENTITY_CONFLICT' });
  });

  it('rejects suspended and deleted users', async () => {
    await expect(createIdentityService(repository([identity(UserStatus.SUSPENDED)]))
      .resolveActiveUser(principal)).rejects.toMatchObject({ statusCode: 403, code: 'USER_SUSPENDED' });
    await expect(createIdentityService(repository([identity(UserStatus.DELETED)]))
      .resolveActiveUser(principal)).rejects.toMatchObject({ statusCode: 403, code: 'USER_UNAVAILABLE' });
  });

  it('fails closed for inconsistent lifecycle markers', async () => {
    const inconsistent = identity();
    const records = [{ ...inconsistent, user: { ...inconsistent.user, suspendedAt: new Date() } }];
    await expect(createIdentityService(repository(records)).resolveActiveUser(principal)).rejects.toMatchObject({
      statusCode: 500,
      code: 'USER_IDENTITY_INTEGRITY_ERROR',
    });
  });

  it('rejects malformed principals without consulting the repository', async () => {
    let consulted = false;
    const service = createIdentityService({
      findByPrincipal: () => {
        consulted = true;
        return Promise.resolve([]);
      },
    });
    await expect(service.resolveActiveUser({ issuer: ' https://identity.example.test', subject: 'subject' }))
      .rejects.toMatchObject({ code: 'EXTERNAL_PRINCIPAL_INVALID' });
    expect(consulted).toBe(false);
  });
});
