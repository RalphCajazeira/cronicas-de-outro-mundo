import { Prisma } from '../../generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { CORE_V1_CONFIG_HASH, CORE_V1_CONFIG_SNAPSHOT } from './core-v1/core-v1.manifest.js';
import { CORE_V1_2_CONFIG_HASH, CORE_V1_2_CONFIG_SNAPSHOT } from './core-v1/core-v1.progression-v2.manifest.js';
import { CORE_V1_EFFECT_RULES_HASH, CORE_V1_EFFECT_RULES_SNAPSHOT } from './core-v1/core-v1.effects.manifest.js';
import {
  CoreEffectRulesVersionDriftError,
  CORE_V1_2_EFFECT_HASH,
  CORE_V1_2_EFFECT_RULES_CODE,
  ensureCoreV12EffectRulesVersion,
  ensureCoreV1EffectRulesVersion,
  validateCoreV1EffectRulesVersion,
  type CoreEffectRulesVersion,
  type EffectRulesRegistryClient,
} from './effect-rules.registry.js';
import type { CoreRulesetVersion } from './ruleset.registry.js';

const rulesetId = '00000000-0000-0000-0000-000000000001';
const rulesetVersionId = '00000000-0000-0000-0000-000000000002';

function official(overrides: Partial<CoreEffectRulesVersion> = {}): CoreEffectRulesVersion {
  return {
    id: '00000000-0000-0000-0000-000000000003', rulesetVersionId,
    code: 'core-v1-effects-v1', schemaVersion: 1, configHash: CORE_V1_EFFECT_RULES_HASH,
    configSnapshot: structuredClone(CORE_V1_EFFECT_RULES_SNAPSHOT), ...overrides,
  };
}

function currentRuleset(): CoreRulesetVersion {
  return {
    id: '00000000-0000-0000-0000-000000000012',
    rulesetId,
    code: 'core-v1.2',
    revision: 'RC1.2',
    schemaVersion: 1,
    configHash: CORE_V1_2_CONFIG_HASH,
    configSnapshot: structuredClone(CORE_V1_2_CONFIG_SNAPSHOT),
    ruleset: { code: 'core' },
  };
}

function officialV12(overrides: Partial<CoreEffectRulesVersion> = {}): CoreEffectRulesVersion {
  const snapshot = structuredClone(CORE_V1_EFFECT_RULES_SNAPSHOT) as unknown as {
    identity: { code: string };
  };
  snapshot.identity.code = CORE_V1_2_EFFECT_RULES_CODE;
  return {
    id: '00000000-0000-0000-0000-000000000013',
    rulesetVersionId: currentRuleset().id,
    code: CORE_V1_2_EFFECT_RULES_CODE,
    schemaVersion: 1,
    configHash: CORE_V1_2_EFFECT_HASH,
    configSnapshot: snapshot,
    ...overrides,
  };
}

function client(find = vi.fn().mockResolvedValue(official())) {
  const fake = {
    ruleset: { findUnique: vi.fn().mockResolvedValue({ id: rulesetId }), create: vi.fn() },
    rulesetVersion: { findUnique: vi.fn().mockResolvedValue({
      id: rulesetVersionId, rulesetId, code: 'core-v1', revision: 'RC1.1', schemaVersion: 1,
      configHash: CORE_V1_CONFIG_HASH, configSnapshot: structuredClone(CORE_V1_CONFIG_SNAPSHOT), ruleset: { code: 'core' },
    }), create: vi.fn() },
    effectRulesVersion: { findUnique: find, create: vi.fn() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  };
  return { fake, client: fake as unknown as EffectRulesRegistryClient };
}

describe('core-v1 effect rules registry', () => {
  it('publishes a fixed canonical manifest hash', () => {
    expect(CORE_V1_EFFECT_RULES_HASH).toBe('a18db0b524a830a75eb55367a44d4fea8a2e195b13c56fc4911b53e6a749c23a');
    expect(CORE_V1_EFFECT_RULES_SNAPSHOT.atomicity).toMatchObject({ replayDoesNotReroll: true, failureLeavesNoPartialState: true });
  });

  it('returns the official immutable publication without writes', async () => {
    const setup = client();
    await expect(ensureCoreV1EffectRulesVersion(setup.client)).resolves.toEqual(official());
    expect(setup.fake.effectRulesVersion.create).not.toHaveBeenCalled();
  });

  it('recovers the expected concurrent code collision', async () => {
    const find = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(official());
    const setup = client(find);
    setup.fake.effectRulesVersion.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002', clientVersion: 'test', meta: { modelName: 'EffectRulesVersion', target: ['code'] },
    }));
    await expect(ensureCoreV1EffectRulesVersion(setup.client)).resolves.toEqual(official());
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('rejects drift without exposing the official snapshot', () => {
    expect(() => validateCoreV1EffectRulesVersion(official({ configHash: '0'.repeat(64), configSnapshot: {} }), rulesetVersionId))
      .toThrow(CoreEffectRulesVersionDriftError);
    try {
      validateCoreV1EffectRulesVersion(official({ configHash: '0'.repeat(64), configSnapshot: {} }), rulesetVersionId);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(CORE_V1_EFFECT_RULES_HASH);
    }
  });

  it('rejects RC1.2 effect registry schema drift', async () => {
    const setup = client(vi.fn().mockResolvedValue(officialV12({ schemaVersion: 2 })));
    await expect(ensureCoreV12EffectRulesVersion(setup.client, currentRuleset()))
      .rejects.toBeInstanceOf(CoreEffectRulesVersionDriftError);
  });
});
