import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_CONFIG_CANONICAL_JSON,
  CORE_V1_CONFIG_HASH,
  CORE_V1_CONFIG_SNAPSHOT,
  CORE_V1_REVISION,
  CORE_V1_RULESET_CODE,
  CORE_V1_SCHEMA_VERSION,
  CORE_V1_VERSION_CODE,
} from './core-v1.manifest.js';

describe('core-v1 published manifest', () => {
  it('has the official identity and complete primary attribute set', () => {
    expect({
      ruleset: CORE_V1_RULESET_CODE,
      version: CORE_V1_VERSION_CODE,
      revision: CORE_V1_REVISION,
      schemaVersion: CORE_V1_SCHEMA_VERSION,
    }).toEqual({ ruleset: 'core', version: 'core-v1', revision: 'RC1.1', schemaVersion: 1 });
    expect(CORE_V1_CONFIG_SNAPSHOT.identity.numericalRevision).toBe('RC1');
    expect(CORE_V1_CONFIG_SNAPSHOT.attributes.primary).toHaveLength(9);
  });

  it('is recursively frozen and cannot be mutated through exported references', () => {
    expect(Object.isFrozen(CORE_V1_CONFIG_SNAPSHOT)).toBe(true);
    expect(Object.isFrozen(CORE_V1_CONFIG_SNAPSHOT.attributes)).toBe(true);
    expect(Object.isFrozen(CORE_V1_CONFIG_SNAPSHOT.attributes.primary)).toBe(true);
    expect(() => {
      (CORE_V1_CONFIG_SNAPSHOT.attributes.primary as unknown as string[]).push('courage');
    }).toThrow(TypeError);
  });

  it('has a stable official SHA-256 hash over canonical JSON', () => {
    expect(CORE_V1_CONFIG_CANONICAL_JSON).toBe(canonicalJson(CORE_V1_CONFIG_SNAPSHOT));
    expect(CORE_V1_CONFIG_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(CORE_V1_CONFIG_HASH).toBe('2cfe9c45585ef51f3a06f2c9dc11e5cd6a5274d3eb77f96271daf2613fc1e4df');
  });

  it('changes the hash when any included configuration changes', () => {
    const changed = structuredClone(CORE_V1_CONFIG_SNAPSHOT);
    changed.attributes.initialBudget += 1;
    const changedHash = createHash('sha256').update(canonicalJson(changed)).digest('hex');
    expect(changedHash).not.toBe(CORE_V1_CONFIG_HASH);
  });
});
