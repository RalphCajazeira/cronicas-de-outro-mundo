import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_V1_CONTENT_PROFILE_HASH,
  CORE_V1_CONTENT_PROFILE_SNAPSHOT,
} from './core-v1/core-v1.content-profile.manifest.js';
import { CORE_V1_CONFIG_HASH, CORE_V1_CONFIG_SNAPSHOT } from './core-v1/core-v1.manifest.js';
import {
  CoreContentProfileVersionDriftError,
  ensureCoreV1ContentProfileVersion,
  validateCoreV1ContentProfileVersion,
  type ContentProfileRegistryClient,
  type CoreContentProfileVersion,
} from './content-profile.registry.js';

const rulesetId = '00000000-0000-0000-0000-000000000001';
const rulesetVersionId = '00000000-0000-0000-0000-000000000002';

function uniqueError(modelName: string, target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: { modelName, target },
  });
}

function officialProfile(overrides: Partial<CoreContentProfileVersion> = {}): CoreContentProfileVersion {
  return {
    id: '00000000-0000-0000-0000-000000000003', rulesetVersionId,
    code: 'core-v1-content-v1', schemaVersion: 1, configHash: CORE_V1_CONTENT_PROFILE_HASH,
    configSnapshot: structuredClone(CORE_V1_CONTENT_PROFILE_SNAPSHOT),
    ...overrides,
  };
}

function officialRuleset() {
  return {
    id: rulesetVersionId, rulesetId, code: 'core-v1', revision: 'RC1.1', schemaVersion: 1,
    configHash: CORE_V1_CONFIG_HASH, configSnapshot: structuredClone(CORE_V1_CONFIG_SNAPSHOT) as unknown as Prisma.JsonValue,
    ruleset: { code: 'core' },
  };
}

function fakeClient(profileFind = vi.fn().mockResolvedValue(officialProfile())) {
  const update = vi.fn();
  const deleteRecord = vi.fn();
  const fake = {
    ruleset: { findUnique: vi.fn().mockResolvedValue({ id: rulesetId }), create: vi.fn(), update, delete: deleteRecord },
    rulesetVersion: { findUnique: vi.fn().mockResolvedValue(officialRuleset()), create: vi.fn(), update, delete: deleteRecord },
    contentProfileVersion: { findUnique: profileFind, create: vi.fn(), update, delete: deleteRecord },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
  return { fake, client: fake as unknown as ContentProfileRegistryClient, update, deleteRecord };
}

describe('core-v1 content profile registry', () => {
  it('returns an identical publication without update or delete', async () => {
    const setup = fakeClient();
    await expect(ensureCoreV1ContentProfileVersion(setup.client)).resolves.toEqual(officialProfile());
    expect(setup.fake.contentProfileVersion.create).not.toHaveBeenCalled();
    expect(setup.update).not.toHaveBeenCalled();
    expect(setup.deleteRecord).not.toHaveBeenCalled();
  });

  it('creates the official canonical publication when absent', async () => {
    const find = vi.fn().mockResolvedValue(null);
    const setup = fakeClient(find);
    setup.fake.contentProfileVersion.create.mockResolvedValue(officialProfile());
    await expect(ensureCoreV1ContentProfileVersion(setup.client)).resolves.toEqual(officialProfile());
    expect(JSON.stringify(setup.fake.contentProfileVersion.create.mock.calls)).toContain('core-v1-content-v1');
    expect(JSON.stringify(setup.fake.contentProfileVersion.create.mock.calls)).toContain(CORE_V1_CONTENT_PROFILE_HASH);
  });

  it('recovers only the expected concurrent P2002 and rereads the winner', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(officialProfile());
    const setup = fakeClient(find);
    setup.fake.contentProfileVersion.create.mockRejectedValue(uniqueError('ContentProfileVersion', ['code']));
    await expect(ensureCoreV1ContentProfileVersion(setup.client)).resolves.toEqual(officialProfile());
    expect(find).toHaveBeenCalledTimes(2);
    expect(setup.fake.$executeRawUnsafe).toHaveBeenNthCalledWith(2, 'ROLLBACK TO SAVEPOINT ensure_core_content_profile_version');
  });

  it('does not mask an unrelated P2002 collision', async () => {
    const error = uniqueError('Campaign', ['worldId', 'code']);
    const setup = fakeClient(vi.fn().mockResolvedValue(null));
    setup.fake.contentProfileVersion.create.mockRejectedValue(error);
    await expect(ensureCoreV1ContentProfileVersion(setup.client)).rejects.toBe(error);
  });

  it('rejects drift without exposing hash or snapshot values', () => {
    const changed = officialProfile({ schemaVersion: 2, configHash: '0'.repeat(64), configSnapshot: {} });
    let captured: unknown;
    try { validateCoreV1ContentProfileVersion(changed, rulesetVersionId); } catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(CoreContentProfileVersionDriftError);
    expect(captured).toMatchObject({ fields: ['schemaVersion', 'configHash', 'configSnapshot'] });
    expect(JSON.stringify(captured)).not.toContain(CORE_V1_CONTENT_PROFILE_HASH);
  });
});
