import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_INVENTORY_RULES_CANONICAL_JSON,
  CORE_V1_INVENTORY_RULES_HASH,
  CORE_V1_INVENTORY_RULES_SNAPSHOT,
} from './core-v1.inventory.manifest.js';

describe('core-v1 inventory rules manifest', () => {
  it('publishes the fixed canonical identity and SHA-256 hash', () => {
    expect(CORE_V1_INVENTORY_RULES_SNAPSHOT.identity).toEqual({
      code: 'core-v1-inventory-v1', schemaVersion: 1, rulesetCode: 'core-v1',
    });
    expect(CORE_V1_INVENTORY_RULES_CANONICAL_JSON).toBe(canonicalJson(CORE_V1_INVENTORY_RULES_SNAPSHOT));
    expect(CORE_V1_INVENTORY_RULES_HASH).toBe('0c588e947f24eca375cb6b46314a98a042ab269681cad42e77f47959a99c58cc');
    expect(createHash('sha256').update(CORE_V1_INVENTORY_RULES_CANONICAL_JSON).digest('hex')).toBe(CORE_V1_INVENTORY_RULES_HASH);
  });

  it('captures physical catalogs, limits, slots and encumbrance without executable functions', () => {
    expect(CORE_V1_INVENTORY_RULES_SNAPSHOT.limits).toEqual({
      maximumEntriesPerOperation: 256, maximumStackQuantity: 999, maximumEquippedEntries: 32,
    });
    expect(CORE_V1_INVENTORY_RULES_SNAPSHOT.equipment.slots).toHaveLength(10);
    expect(CORE_V1_INVENTORY_RULES_SNAPSHOT.encumbrance.thresholdsBps).toEqual({
      normalMaximum: 7000, encumberedMaximum: 10000, heavilyEncumberedMaximum: 12500,
    });
    expect(CORE_V1_INVENTORY_RULES_CANONICAL_JSON).not.toContain('function');
    expect(Object.isFrozen(CORE_V1_INVENTORY_RULES_SNAPSHOT.equipment.slots)).toBe(true);
  });
});
