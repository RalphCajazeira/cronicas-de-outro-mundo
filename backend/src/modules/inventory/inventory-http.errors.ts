import { AppError, type PublicErrorIssue } from '../../shared/errors/app-error.js';
import type { ValidationIssue } from '../rules/core-v1/core-v1.types.js';
import { InventoryOperationRejectedError, InventoryStateVersionRejectedError } from './inventory.errors.js';

type IssueCategory = 'correct_request' | 'load_inventory';

interface PublicIssueDefinition {
  readonly path: string;
  readonly category: IssueCategory;
  readonly message: string | ((issue: ValidationIssue) => string);
}

const publicSlotValues = new Set([
  'main_hand', 'off_hand', 'head', 'chest', 'hands', 'legs', 'feet', 'body',
  'accessory', 'accessory_1', 'accessory_2',
]);

function acceptedSlots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((slot): slot is string => typeof slot === 'string' && publicSlotValues.has(slot));
}

function incompatibleSlotMessage(issue: ValidationIssue): string {
  const slots = acceptedSlots(issue.expected);
  if (slots.length === 0) return 'The requested slot is not allowed for this item. Use a slot declared by the item.';
  const formatted = slots.map((slot) => `\`${slot}\``).join(', ');
  return `This item accepts ${formatted}. Use an accepted slot or omit targetSlotRef when the item can use its declared slots.`;
}

const issueDefinitions: Readonly<Record<string, PublicIssueDefinition>> = {
  INCOMPATIBLE_SLOT: {
    path: 'targetSlotRef', category: 'correct_request', message: incompatibleSlotMessage,
  },
  HAND_SLOT_REQUIRED: {
    path: 'targetSlotRef', category: 'correct_request',
    message: 'Set targetSlotRef to `main_hand` or `off_hand` for a one-handed weapon.',
  },
  TWO_HANDED_MAIN_HAND: {
    path: 'targetSlotRef', category: 'correct_request',
    message: 'A two-handed weapon must start in `main_hand`; it will occupy both hands.',
  },
  ACCESSORY_SLOT: {
    path: 'targetSlotRef', category: 'correct_request',
    message: 'Set targetSlotRef to `accessory_1` or `accessory_2` for an accessory.',
  },
  SLOT_REF: {
    path: 'targetSlotRef', category: 'correct_request',
    message: 'Use one of the public equipment slots documented by manageActorInventory.',
  },
  VERSATILE_MODE_REQUIRED: {
    path: 'versatileMode', category: 'correct_request',
    message: 'Set versatileMode to `one_handed` or `two_handed` for a versatile weapon.',
  },
  VERSATILE_MODE: {
    path: 'versatileMode', category: 'correct_request',
    message: 'versatileMode must be `one_handed` or `two_handed`.',
  },
  NOT_VERSATILE: {
    path: 'versatileMode', category: 'correct_request',
    message: 'Remove versatileMode because this item is not a versatile weapon.',
  },
  MECHANICAL_EQUIPMENT: {
    path: 'profile', category: 'correct_request',
    message: 'This content does not have an equippable mechanical profile. Changing only targetSlotRef will not make it equippable.',
  },
  EQUIPMENT_SLOTS_REQUIRED: {
    path: 'profile.equipmentSlots', category: 'correct_request',
    message: 'This item does not declare physical equipment slots and cannot be equipped.',
  },
  EQUIPPABLE_INSTANCE: {
    path: 'entryRef', category: 'correct_request',
    message: 'entryRef must identify an existing unique inventory instance that can be equipped.',
  },
  ENTRY_REF: {
    path: 'entryRef', category: 'correct_request',
    message: 'Provide a valid public inventory entryRef.',
  },
  PHYSICAL_PROFILE_MATCH: {
    path: 'contentRef', category: 'correct_request',
    message: 'The physical inventory specification must match the canonical content profile.',
  },
  MINIMUM_LEVEL: {
    path: 'requirements', category: 'correct_request',
    message: 'The actor does not meet the minimum level required by this equipment.',
  },
  MINIMUM_PRIMARY_ATTRIBUTE: {
    path: 'requirements', category: 'correct_request',
    message: 'The actor does not meet a minimum primary attribute required by this equipment.',
  },
  REQUIRED_CONTENT: {
    path: 'requirements', category: 'correct_request',
    message: 'The actor does not know content required by this equipment.',
  },
  REQUIRED_WEAPON_TAG: {
    path: 'requirements', category: 'correct_request',
    message: 'The actor does not have the required weapon type equipped.',
  },
  REQUIRED_EQUIPMENT_TAG: {
    path: 'requirements', category: 'correct_request',
    message: 'The actor does not have the required equipment type equipped.',
  },
  REQUIRED_RULESET: {
    path: 'requirements', category: 'correct_request',
    message: 'The equipment is not compatible with the actor ruleset.',
  },
  OCCUPIED_SLOT: {
    path: 'loadout', category: 'load_inventory',
    message: 'A required slot is occupied. Load the current inventory and unequip the conflicting item, or choose another allowed slot.',
  },
  AVAILABLE_REQUIRED: {
    path: 'entryRef', category: 'load_inventory',
    message: 'The item is not currently available to equip. Load the current inventory before choosing the next operation.',
  },
  EQUIPPED_STATE: {
    path: 'entryRef', category: 'load_inventory',
    message: 'The item is not currently equipped. Load the current inventory before choosing the next operation.',
  },
  LOADOUT_LINK: {
    path: 'loadout', category: 'load_inventory',
    message: 'The current loadout does not contain the requested equipment link. Load the inventory again.',
  },
  EQUIPPED_REMOVAL: {
    path: 'entryRef', category: 'load_inventory',
    message: 'The item is equipped and must be unequipped before removal. Load the current inventory, unequip it, and then remove it.',
  },
};

function publicIssue(issue: ValidationIssue): { issue: PublicErrorIssue; category: IssueCategory } {
  const definition = issueDefinitions[issue.rule];
  if (definition === undefined) {
    return {
      category: 'correct_request',
      issue: {
        path: 'operation',
        code: 'INVENTORY_RULE_REJECTED',
        message: 'The inventory operation does not satisfy an authoritative inventory rule.',
      },
    };
  }
  return {
    category: definition.category,
    issue: {
      path: definition.path,
      code: issue.rule,
      message: typeof definition.message === 'function' ? definition.message(issue) : definition.message,
    },
  };
}

export function inventoryOperationError(issues: readonly ValidationIssue[] = []): AppError {
  const mapped = issues.slice(0, 20).map(publicIssue);
  if (mapped.length === 0) {
    mapped.push(publicIssue({ path: '$', rule: 'INVENTORY_RULE_REJECTED', message: '' }));
  }
  const requiresRequestCorrection = mapped.some((entry) => entry.category === 'correct_request');
  const publicIssues = mapped.map((entry) => entry.issue);
  if (requiresRequestCorrection) {
    return new AppError(422, 'INVALID_INVENTORY_OPERATION', 'The inventory operation could not be completed', {
      retryable: false,
      recoveryAction: 'correct_request',
      auditCode: 'INVENTORY_OPERATION_REJECTED',
      issues: publicIssues,
    });
  }
  return new AppError(409, 'INVENTORY_LOADOUT_CONFLICT', 'The inventory loadout changed or conflicts with this operation', {
    retryable: false,
    recoveryAction: 'load_inventory',
    auditCode: 'INVENTORY_LOADOUT_CONFLICT',
    issues: publicIssues,
  });
}

export function inventoryStateVersionConflictError(): AppError {
  return new AppError(409, 'INVENTORY_STATE_VERSION_CONFLICT', 'Inventory state version does not match', {
    retryable: false,
    recoveryAction: 'load_inventory',
    auditCode: 'INVENTORY_STATE_VERSION_CONFLICT',
    issues: [{
      path: 'expectedInventoryStateVersion',
      code: 'STATE_VERSION_CONFLICT',
      message: 'Load the inventory again and use the returned inventoryStateVersion in a new request.',
    }],
  });
}

export function mapInventoryHttpError(error: unknown): AppError | null {
  if (error instanceof InventoryOperationRejectedError) return inventoryOperationError(error.domainIssues);
  if (error instanceof InventoryStateVersionRejectedError) return inventoryStateVersionConflictError();
  return null;
}
