import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import {
  CORE_V1_CONFIG_HASH,
  CORE_V1_CONFIG_SNAPSHOT,
  CORE_V1_REVISION,
  CORE_V1_SCHEMA_VERSION,
  CORE_V1_VERSION_CODE,
} from './core-v1/core-v1.manifest.js';
import {
  CORE_RULESET_VERSION_DRIFT,
  CoreRulesetVersionDriftError,
  ensureCoreV1RulesetVersion,
  validateCoreV1RulesetVersion,
  type CoreRulesetVersion,
  type RulesetRegistryClient,
} from './ruleset.registry.js';

function officialVersion(overrides: Partial<CoreRulesetVersion> = {}): CoreRulesetVersion {
  return {
    id: '00000000-0000-0000-0000-000000000002',
    rulesetId: '00000000-0000-0000-0000-000000000001',
    code: CORE_V1_VERSION_CODE,
    revision: CORE_V1_REVISION,
    schemaVersion: CORE_V1_SCHEMA_VERSION,
    configHash: CORE_V1_CONFIG_HASH,
    configSnapshot: JSON.parse(JSON.stringify(CORE_V1_CONFIG_SNAPSHOT)) as Prisma.JsonValue,
    ruleset: { code: 'core' },
    ...overrides,
  };
}

function uniqueError(modelName: string, target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('unique conflict', {
    code: 'P2002', clientVersion: 'test', meta: { modelName, target },
  });
}

function client(input: {
  rulesetFind?: ReturnType<typeof vi.fn>;
  rulesetCreate?: ReturnType<typeof vi.fn>;
  versionFind?: ReturnType<typeof vi.fn>;
  versionCreate?: ReturnType<typeof vi.fn>;
} = {}) {
  const update = vi.fn();
  const deleteRecord = vi.fn();
  const fake = {
    ruleset: {
      findUnique: input.rulesetFind ?? vi.fn().mockResolvedValue({ id: officialVersion().rulesetId }),
      create: input.rulesetCreate ?? vi.fn(), update, delete: deleteRecord,
    },
    rulesetVersion: {
      findUnique: input.versionFind ?? vi.fn().mockResolvedValue(officialVersion()),
      create: input.versionCreate ?? vi.fn(), update, delete: deleteRecord,
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
  return { fake, registryClient: fake as unknown as RulesetRegistryClient, update, deleteRecord };
}

describe('core-v1 ruleset registry', () => {
  it('creates Ruleset and RulesetVersion when both are absent', async () => {
    const version = officialVersion();
    const setup = client({
      rulesetFind: vi.fn().mockResolvedValue(null),
      rulesetCreate: vi.fn().mockResolvedValue({ id: version.rulesetId }),
      versionFind: vi.fn().mockResolvedValue(null),
      versionCreate: vi.fn().mockResolvedValue(version),
    });

    await expect(ensureCoreV1RulesetVersion(setup.registryClient)).resolves.toEqual(version);
    const rulesetCalls: unknown = setup.fake.ruleset.create.mock.calls;
    const versionCalls: unknown = setup.fake.rulesetVersion.create.mock.calls;
    expect(rulesetCalls).toEqual([[{ data: { code: 'core', name: 'Core Ruleset' }, select: { id: true } }]]);
    expect(JSON.stringify(versionCalls)).toContain(`"configHash":"${CORE_V1_CONFIG_HASH}"`);
    expect(JSON.stringify(versionCalls)).toContain('"code":"core-v1","revision":"RC1.1","schemaVersion":1');
    expect(setup.fake.$executeRawUnsafe).toHaveBeenCalledTimes(4);
  });

  it('returns an identical persisted version without update or delete operations', async () => {
    const version = officialVersion();
    const setup = client();
    await expect(ensureCoreV1RulesetVersion(setup.registryClient)).resolves.toEqual(version);
    expect(setup.fake.ruleset.create).not.toHaveBeenCalled();
    expect(setup.fake.rulesetVersion.create).not.toHaveBeenCalled();
    expect(setup.update).not.toHaveBeenCalled();
    expect(setup.deleteRecord).not.toHaveBeenCalled();
  });

  it('rolls back an expected P2002 savepoint, rereads and validates the winner', async () => {
    const version = officialVersion();
    const rulesetFind = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: version.rulesetId });
    const setup = client({
      rulesetFind,
      rulesetCreate: vi.fn().mockRejectedValue(uniqueError('Ruleset', ['code'])),
    });

    await expect(ensureCoreV1RulesetVersion(setup.registryClient)).resolves.toEqual(version);
    expect(rulesetFind).toHaveBeenCalledTimes(2);
    expect(setup.fake.$executeRawUnsafe).toHaveBeenNthCalledWith(2, 'ROLLBACK TO SAVEPOINT ensure_core_ruleset');
  });

  it('does not mask a P2002 collision unrelated to the expected key', async () => {
    const error = uniqueError('Campaign', ['worldId', 'code']);
    const setup = client({
      rulesetFind: vi.fn().mockResolvedValue(null),
      rulesetCreate: vi.fn().mockRejectedValue(error),
    });
    await expect(ensureCoreV1RulesetVersion(setup.registryClient)).rejects.toBe(error);
  });

  it('rejects drift without exposing the snapshot in its structured error', () => {
    const changedSnapshot = structuredClone(CORE_V1_CONFIG_SNAPSHOT);
    changedSnapshot.attributes.initialBudget += 1;
    const candidate = officialVersion({
      revision: 'changed', configHash: '0'.repeat(64),
      configSnapshot: JSON.parse(JSON.stringify(changedSnapshot)) as Prisma.JsonValue,
    });

    let captured: unknown;
    try {
      validateCoreV1RulesetVersion(candidate);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(CoreRulesetVersionDriftError);
    expect(captured).toMatchObject({
      code: CORE_RULESET_VERSION_DRIFT,
      fields: ['revision', 'configHash', 'configSnapshot'],
      message: 'Published core-v1 ruleset does not match the official configuration',
    });
    expect(JSON.stringify(captured)).not.toContain('initialBudget');
    expect((captured as Error).message).not.toContain(CORE_V1_CONFIG_HASH);
  });
});
