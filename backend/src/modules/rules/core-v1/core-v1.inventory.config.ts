import type {
  CoreV1EquipmentSlotInstance,
  CoreV1EquipmentSlotRef,
  CoreV1InventoryContentType,
  CoreV1InventoryInstanceState,
} from './core-v1.inventory.types.js';

export const CORE_V1_INVENTORY_SCHEMA_VERSION = 1 as const;
export const CORE_V1_INVENTORY_RULESET_CODE = 'core-v1' as const;
export const CORE_V1_INVENTORY_RULES_CODE = 'core-v1-inventory-v1' as const;
export const CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION = 256;
export const CORE_V1_MAX_STACK_QUANTITY = 999;
export const CORE_V1_MAX_EQUIPPED_ENTRIES = 32;

export const CORE_V1_INVENTORY_CONTENT_TYPES = Object.freeze([
  'weapon', 'armor', 'shield', 'clothing', 'item', 'consumable', 'material', 'other',
] as const) satisfies readonly CoreV1InventoryContentType[];

export const CORE_V1_INVENTORY_INSTANCE_STATES = Object.freeze([
  'available', 'equipped', 'reserved', 'consumed', 'destroyed',
] as const) satisfies readonly CoreV1InventoryInstanceState[];

export const CORE_V1_EQUIPMENT_SLOT_CATALOG = Object.freeze([
  Object.freeze({ slotRef: 'main_hand', slotType: 'main_hand', entryRef: null }),
  Object.freeze({ slotRef: 'off_hand', slotType: 'off_hand', entryRef: null }),
  Object.freeze({ slotRef: 'head', slotType: 'head', entryRef: null }),
  Object.freeze({ slotRef: 'chest', slotType: 'chest', entryRef: null }),
  Object.freeze({ slotRef: 'hands', slotType: 'hands', entryRef: null }),
  Object.freeze({ slotRef: 'legs', slotType: 'legs', entryRef: null }),
  Object.freeze({ slotRef: 'feet', slotType: 'feet', entryRef: null }),
  Object.freeze({ slotRef: 'body', slotType: 'body', entryRef: null }),
  Object.freeze({ slotRef: 'accessory_1', slotType: 'accessory', entryRef: null }),
  Object.freeze({ slotRef: 'accessory_2', slotType: 'accessory', entryRef: null }),
] as const) satisfies readonly CoreV1EquipmentSlotInstance[];

export const CORE_V1_EQUIPMENT_SLOT_REFS = Object.freeze(
  CORE_V1_EQUIPMENT_SLOT_CATALOG.map((slot) => slot.slotRef),
) satisfies readonly CoreV1EquipmentSlotRef[];
