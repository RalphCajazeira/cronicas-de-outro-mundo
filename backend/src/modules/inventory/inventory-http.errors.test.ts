import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '../rules/core-v1/core-v1.types.js';
import {
  inventoryOperationError,
  inventoryStateVersionConflictError,
  mapInventoryHttpError,
} from './inventory-http.errors.js';
import { InventoryOperationRejectedError, InventoryStateVersionRejectedError } from './inventory.errors.js';

function issue(rule: string, overrides: Partial<ValidationIssue> = {}): ValidationIssue {
  return { path: 'input', rule, message: 'private internal message', ...overrides };
}

describe('inventory HTTP error mapper', () => {
  it('maps only inventory boundary errors and leaves unrelated failures untouched', () => {
    expect(mapInventoryHttpError(new InventoryOperationRejectedError([issue('HAND_SLOT_REQUIRED')]))).toMatchObject({
      statusCode: 422, code: 'INVALID_INVENTORY_OPERATION',
    });
    expect(mapInventoryHttpError(new InventoryStateVersionRejectedError())).toMatchObject({
      statusCode: 409, code: 'INVENTORY_STATE_VERSION_CONFLICT',
    });
    expect(mapInventoryHttpError(new Error('unrelated'))).toBeNull();
  });

  it('maps body requested for chest equipment to a safe actionable 422', () => {
    const mapped = inventoryOperationError([issue('INCOMPATIBLE_SLOT', {
      path: 'targetSlotRef', expected: ['chest'], received: 'body',
    })]);

    expect(mapped).toMatchObject({
      statusCode: 422,
      code: 'INVALID_INVENTORY_OPERATION',
      retryable: false,
      recoveryAction: 'correct_request',
      issues: [{
        path: 'targetSlotRef',
        code: 'INCOMPATIBLE_SLOT',
      }],
    });
    expect(mapped.issues?.[0]?.message).toContain('`chest`');
    expect(JSON.stringify(mapped.issues)).not.toContain('body');
  });

  it('explains that narrative content lacks an equippable profile', () => {
    const mapped = inventoryOperationError([issue('MECHANICAL_EQUIPMENT', {
      path: 'entry.profile', received: 'private narrative content',
    })]);

    expect(mapped).toMatchObject({
      statusCode: 422,
      issues: [{
        path: 'profile',
        code: 'MECHANICAL_EQUIPMENT',
      }],
    });
    expect(mapped.issues?.[0]?.message).toContain('mechanical profile');
    expect(mapped.issues?.[0]?.message).toContain('Changing only targetSlotRef will not make it equippable');
  });

  it.each([
    ['HAND_SLOT_REQUIRED', 'targetSlotRef', 'main_hand'],
    ['VERSATILE_MODE_REQUIRED', 'versatileMode', 'one_handed'],
  ])('maps %s to the required public field and correction', (rule, path, alternative) => {
    const mapped = inventoryOperationError([issue(rule)]);
    expect(mapped).toMatchObject({ statusCode: 422, recoveryAction: 'correct_request' });
    expect(mapped.issues?.[0]).toMatchObject({ path, code: rule });
    expect(mapped.issues?.[0]?.message).toContain(alternative);
  });

  it('distinguishes an occupied loadout from invalid request semantics', () => {
    const mapped = inventoryOperationError([issue('OCCUPIED_SLOT', {
      path: 'slots.chest', received: 'private-conflicting-entry',
    })]);

    expect(mapped).toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_LOADOUT_CONFLICT',
      retryable: false,
      recoveryAction: 'load_inventory',
      issues: [{ path: 'loadout', code: 'OCCUPIED_SLOT' }],
    });
    expect(JSON.stringify(mapped)).not.toContain('private-conflicting-entry');
  });

  it('maps equipped removal to a state conflict with an actionable sequence', () => {
    const mapped = inventoryOperationError([issue('EQUIPPED_REMOVAL')]);

    expect(mapped).toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_LOADOUT_CONFLICT',
      retryable: false,
      recoveryAction: 'load_inventory',
      issues: [{
        path: 'entryRef',
        code: 'EQUIPPED_REMOVAL',
      }],
    });
    expect(mapped.issues?.[0]?.message).toContain('unequipped before removal');
  });

  it('maps stale optimistic state to an explicit reload action', () => {
    expect(inventoryStateVersionConflictError()).toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_STATE_VERSION_CONFLICT',
      retryable: false,
      recoveryAction: 'load_inventory',
      issues: [{ path: 'expectedInventoryStateVersion', code: 'STATE_VERSION_CONFLICT' }],
    });
  });

  it('does not expose arbitrary data from unknown domain issues', () => {
    const mapped = inventoryOperationError([issue('PRIVATE_UNKNOWN_RULE', {
      path: 'entries.private-user-ref.secret',
      expected: ['postgresql://secret'],
      received: { apiKey: 'private-key' },
    })]);
    const serialized = JSON.stringify(mapped);

    expect(mapped).toMatchObject({
      statusCode: 422,
      issues: [{ path: 'operation', code: 'INVENTORY_RULE_REJECTED' }],
    });
    expect(serialized).not.toMatch(/postgres|secret|private-key|private-user-ref/i);
  });
});
