import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_EQUIPMENT_SLOT_CATALOG,
  CORE_V1_INVENTORY_CONTENT_TYPES,
  CORE_V1_INVENTORY_RULES_CODE,
  CORE_V1_INVENTORY_RULESET_CODE,
  CORE_V1_INVENTORY_SCHEMA_VERSION,
  CORE_V1_MAX_EQUIPPED_ENTRIES,
  CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION,
  CORE_V1_MAX_STACK_QUANTITY,
} from './core-v1.inventory.config.js';

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const CORE_V1_INVENTORY_RULES_SNAPSHOT = deepFreeze({
  identity: {
    code: CORE_V1_INVENTORY_RULES_CODE,
    schemaVersion: CORE_V1_INVENTORY_SCHEMA_VERSION,
    rulesetCode: CORE_V1_INVENTORY_RULESET_CODE,
  },
  physicalContentTypes: [...CORE_V1_INVENTORY_CONTENT_TYPES],
  stacking: { modes: ['unique', 'stackable'], maximumStackQuantity: CORE_V1_MAX_STACK_QUANTITY },
  limits: {
    maximumEntriesPerOperation: CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION,
    maximumStackQuantity: CORE_V1_MAX_STACK_QUANTITY,
    maximumEquippedEntries: CORE_V1_MAX_EQUIPPED_ENTRIES,
  },
  instanceLifecycle: ['available', 'reserved', 'consumed', 'destroyed'],
  publicDerivedStates: ['available', 'equipped', 'reserved', 'consumed', 'destroyed'],
  equipment: {
    slots: CORE_V1_EQUIPMENT_SLOT_CATALOG.map(({ slotRef, slotType }) => ({ slotRef, slotType })),
    handedness: ['one_handed', 'two_handed', 'versatile'],
    multislotAtomic: true,
    silentlyReplaceConflicts: false,
  },
  encumbrance: {
    thresholdsBps: { normalMaximum: 7000, encumberedMaximum: 10000, heavilyEncumberedMaximum: 12500 },
    penaltiesBps: { normal: 0, encumbered: 1000, heavily_encumbered: 2500, overloaded: 2500 },
  },
});

export const CORE_V1_INVENTORY_RULES_CANONICAL_JSON = canonicalJson(CORE_V1_INVENTORY_RULES_SNAPSHOT);
export const CORE_V1_INVENTORY_RULES_HASH = createHash('sha256')
  .update(CORE_V1_INVENTORY_RULES_CANONICAL_JSON)
  .digest('hex');
