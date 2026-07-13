import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { CORE_V1_CONFIG_HASH, CORE_V1_CONFIG_SNAPSHOT } from './core-v1/core-v1.manifest.js';
import { CORE_V1_INVENTORY_RULES_HASH, CORE_V1_INVENTORY_RULES_SNAPSHOT } from './core-v1/core-v1.inventory.manifest.js';
import {
  CoreInventoryRulesVersionDriftError,
  ensureCoreV1InventoryRulesVersion,
  validateCoreV1InventoryRulesVersion,
  type CoreInventoryRulesVersion,
  type InventoryRulesRegistryClient,
} from './inventory-rules.registry.js';

const rulesetId = '00000000-0000-0000-0000-000000000001';
const rulesetVersionId = '00000000-0000-0000-0000-000000000002';

function official(overrides: Partial<CoreInventoryRulesVersion> = {}): CoreInventoryRulesVersion {
  return {
    id: '00000000-0000-0000-0000-000000000003', rulesetVersionId,
    code: 'core-v1-inventory-v1', schemaVersion: 1, configHash: CORE_V1_INVENTORY_RULES_HASH,
    configSnapshot: structuredClone(CORE_V1_INVENTORY_RULES_SNAPSHOT), ...overrides,
  };
}

function client(find = vi.fn().mockResolvedValue(official())) {
  const fake = {
    ruleset: { findUnique: vi.fn().mockResolvedValue({ id: rulesetId }), create: vi.fn() },
    rulesetVersion: { findUnique: vi.fn().mockResolvedValue({
      id: rulesetVersionId, rulesetId, code: 'core-v1', revision: 'RC1.1', schemaVersion: 1,
      configHash: CORE_V1_CONFIG_HASH, configSnapshot: structuredClone(CORE_V1_CONFIG_SNAPSHOT), ruleset: { code: 'core' },
    }), create: vi.fn() },
    inventoryRulesVersion: { findUnique: find, create: vi.fn() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
  return { fake, client: fake as unknown as InventoryRulesRegistryClient };
}

describe('core-v1 inventory rules registry', () => {
  it('returns the official immutable publication without writes', async () => {
    const setup = client();
    await expect(ensureCoreV1InventoryRulesVersion(setup.client)).resolves.toEqual(official());
    expect(setup.fake.inventoryRulesVersion.create).not.toHaveBeenCalled();
  });

  it('creates and recovers only the expected concurrent code collision', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(official());
    const setup = client(find);
    setup.fake.inventoryRulesVersion.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'test', meta: { modelName: 'InventoryRulesVersion', target: ['code'] },
    }));
    await expect(ensureCoreV1InventoryRulesVersion(setup.client)).resolves.toEqual(official());
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('rejects drift without exposing the official hash or snapshot', () => {
    let captured: unknown;
    try {
      validateCoreV1InventoryRulesVersion(official({ schemaVersion: 2, configHash: '0'.repeat(64), configSnapshot: {} }), rulesetVersionId);
    } catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(CoreInventoryRulesVersionDriftError);
    expect(captured).toMatchObject({ fields: ['schemaVersion', 'configHash', 'configSnapshot'] });
    expect(JSON.stringify(captured)).not.toContain(CORE_V1_INVENTORY_RULES_HASH);
  });
});
