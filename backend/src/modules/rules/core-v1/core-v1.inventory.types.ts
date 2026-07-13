import type { EncumbranceState } from './core-v1.action-economy.types.js';
import type {
  CoreV1ContentProfile,
  CoreV1ContentReference,
  CoreV1EquipmentSlot,
  CoreV1Handedness,
  CoreV1PassiveModifierTarget,
} from './core-v1.content-mechanics.types.js';
import type {
  AuthorizedNumericModifier,
  PrimaryAttributes,
  ValidationIssue,
} from './core-v1.types.js';

export type CoreV1InventoryContentType =
  | 'weapon'
  | 'armor'
  | 'shield'
  | 'clothing'
  | 'item'
  | 'consumable'
  | 'material'
  | 'other';

export type CoreV1InventoryStacking =
  | { readonly mode: 'unique' }
  | { readonly mode: 'stackable'; readonly maxStack: number };

export interface CoreV1InventorySpec {
  readonly schemaVersion: 1;
  readonly rulesetCode: 'core-v1';
  readonly inventoryRulesCode: 'core-v1-inventory-v1';
  readonly unitWeight: number;
  readonly stacking: CoreV1InventoryStacking;
  readonly equipmentSlots?: readonly CoreV1EquipmentSlot[];
  readonly handedness?: CoreV1Handedness;
}

export interface CoreV1ContentVersionReference {
  readonly scope: 'world' | 'campaign';
  readonly contentType: CoreV1InventoryContentType;
  readonly code: string;
  readonly versionNumber: number;
}

export type CoreV1InventoryInstanceState =
  | 'available'
  | 'equipped'
  | 'reserved'
  | 'consumed'
  | 'destroyed';

interface CoreV1InventoryEntryBase {
  readonly entryRef: string;
  readonly contentVersion: CoreV1ContentVersionReference;
  readonly inventorySpec: CoreV1InventorySpec;
  readonly profile: CoreV1ContentProfile | null;
}

export interface CoreV1InventoryInstance extends CoreV1InventoryEntryBase {
  readonly entryKind: 'instance';
  readonly customName?: string;
  readonly state: CoreV1InventoryInstanceState;
}

export interface CoreV1InventoryStack extends CoreV1InventoryEntryBase {
  readonly entryKind: 'stack';
  readonly quantity: number;
}

export type CoreV1InventoryEntry = CoreV1InventoryInstance | CoreV1InventoryStack;

export interface CoreV1InventoryState {
  readonly entries: readonly CoreV1InventoryEntry[];
}

export type CoreV1InventoryResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly code: 'INVALID_CORE_V1_INVENTORY_OPERATION';
    readonly retryable: true;
    readonly issues: readonly ValidationIssue[];
  };

export type CoreV1AddInventoryInput =
  | { readonly entryKind: 'instance'; readonly entry: CoreV1InventoryInstance }
  | {
    readonly entryKind: 'stack';
    readonly contentVersion: CoreV1ContentVersionReference;
    readonly inventorySpec: CoreV1InventorySpec;
    readonly profile: CoreV1ContentProfile | null;
    readonly quantity: number;
    readonly newEntryRefs: readonly string[];
  };

export interface CoreV1InventoryChange {
  readonly inventory: CoreV1InventoryState;
  readonly createdEntryRefs: readonly string[];
  readonly changedEntryRefs: readonly string[];
  readonly removedEntryRefs: readonly string[];
}

export interface CoreV1InventoryWeight {
  readonly totalCarriedWeight: number;
  readonly entryWeights: readonly {
    readonly entryRef: string;
    readonly quantity: number;
    readonly weight: number;
  }[];
}

export interface CoreV1InventoryEncumbrance {
  readonly carriedWeight: number;
  readonly carryingCapacity: number;
  readonly ratioBps: number | null;
  readonly state: EncumbranceState;
  readonly penaltyBps: number;
  readonly canStartAttackOrMovement: boolean;
}

export type CoreV1EquipmentSlotRef =
  | 'main_hand'
  | 'off_hand'
  | 'head'
  | 'chest'
  | 'hands'
  | 'legs'
  | 'feet'
  | 'body'
  | 'accessory_1'
  | 'accessory_2';

export interface CoreV1EquipmentSlotInstance {
  readonly slotRef: CoreV1EquipmentSlotRef;
  readonly slotType: CoreV1EquipmentSlot;
  readonly entryRef: string | null;
}

export interface CoreV1EquipmentLoadout {
  readonly slots: readonly CoreV1EquipmentSlotInstance[];
}

export interface CoreV1EquipmentRequirementContext {
  readonly level: number;
  readonly primaryAttributes: PrimaryAttributes;
  readonly knownContentRefs: readonly CoreV1ContentReference[];
  readonly equippedWeaponTags: readonly string[];
  readonly equippedEquipmentTags: readonly string[];
  readonly rulesetCode: string;
}

export interface CoreV1EquipmentRequirementEvaluation {
  readonly met: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface CoreV1PlanEquipInput {
  readonly entryRef: string;
  readonly targetSlotRef?: CoreV1EquipmentSlotRef;
  readonly versatileMode?: 'one_handed' | 'two_handed';
}

export interface CoreV1EquipmentConflict {
  readonly slotRef: CoreV1EquipmentSlotRef;
  readonly entryRef: string;
}

export interface CoreV1EquipPlan {
  readonly entryRef: string;
  readonly requiredSlots: readonly CoreV1EquipmentSlotRef[];
  readonly occupiedConflicts: readonly CoreV1EquipmentConflict[];
  readonly requirements: CoreV1EquipmentRequirementEvaluation;
  readonly canEquip: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface CoreV1EquipmentChange {
  readonly inventory: CoreV1InventoryState;
  readonly loadout: CoreV1EquipmentLoadout;
  readonly entryRef: string;
  readonly changedSlots: readonly CoreV1EquipmentSlotRef[];
}

export interface CoreV1CollectedEquipmentModifier extends AuthorizedNumericModifier {
  readonly target: CoreV1PassiveModifierTarget;
  readonly source: { readonly type: 'equipment'; readonly ref: string };
}

export interface CoreV1AggregatedEquipmentModifier {
  readonly target: CoreV1PassiveModifierTarget;
  readonly value: number;
}
