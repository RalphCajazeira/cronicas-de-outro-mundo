import { canonicalJson } from '../../../shared/json/canonical-json.js';
import {
  CORE_V1_INVENTORY_CONTENT_TYPES,
  CORE_V1_INVENTORY_INSTANCE_STATES,
  CORE_V1_INVENTORY_RULES_CODE,
  CORE_V1_INVENTORY_RULESET_CODE,
  CORE_V1_INVENTORY_SCHEMA_VERSION,
  CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION,
  CORE_V1_MAX_STACK_QUANTITY,
} from './core-v1.inventory.config.js';
import { CORE_V1_EQUIPMENT_SLOTS } from './core-v1.content-mechanics.config.js';
import type {
  CoreV1AddInventoryInput,
  CoreV1ContentVersionReference,
  CoreV1InventoryChange,
  CoreV1InventoryEntry,
  CoreV1InventoryResult,
  CoreV1InventorySpec,
  CoreV1InventoryStack,
  CoreV1InventoryState,
  CoreV1InventoryWeight,
  CoreV1InventoryEncumbrance,
} from './core-v1.inventory.types.js';
import type { CoreV1ContentProfile } from './core-v1.content-mechanics.types.js';
import { validateCoreV1ContentProfile } from './core-v1.content-mechanics.js';
import { calculateEncumbrance } from './core-v1.temporal.js';
import {
  ceilDiv,
  isPlainRecord,
  safeIntegerAdd,
  safeIntegerMultiply,
} from './core-v1.math.js';
import type { ValidationIssue } from './core-v1.types.js';

const codePattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ValidationContext {
  readonly issues: ValidationIssue[];
}

function addIssue(
  context: ValidationContext,
  path: string,
  rule: string,
  message: string,
  expected?: unknown,
  received?: unknown,
): void {
  if (context.issues.some((issue) => issue.path === path && issue.rule === rule && issue.message === message)) return;
  const issue: ValidationIssue = { path, rule, message };
  if (expected !== undefined) issue.expected = expected;
  if (received !== undefined) issue.received = received;
  context.issues.push(issue);
}

function failure<T>(issues: readonly ValidationIssue[]): CoreV1InventoryResult<T> {
  return {
    ok: false,
    code: 'INVALID_CORE_V1_INVENTORY_OPERATION',
    retryable: true,
    issues: structuredClone(issues),
  };
}

function success<T>(value: T): CoreV1InventoryResult<T> {
  return { ok: true, value: structuredClone(value) };
}

function ownPropertyNames(value: object): readonly string[] {
  return Object.getOwnPropertyNames(value).filter((key) => key !== 'length').sort();
}

function closedRecord(
  context: ValidationContext,
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    addIssue(context, path, 'PLAIN_OBJECT', 'Must be a plain object');
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    addIssue(context, path, 'SYMBOL_KEYS', 'Symbol keys are not supported');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined
    || descriptor.set !== undefined || descriptor.enumerable !== true)) {
    addIssue(context, path, 'DATA_PROPERTIES', 'Object fields must be enumerable data properties');
    return null;
  }
  const allowed = new Set(allowedKeys);
  for (const key of ownPropertyNames(value)) {
    if (!allowed.has(key)) {
      addIssue(context, path === '$' ? key : `${path}.${key}`, 'UNKNOWN_FIELD', 'Unsupported field', allowedKeys, key);
    }
  }
  return value;
}

function denseArray(
  context: ValidationContext,
  value: unknown,
  path: string,
  maximum: number,
): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    addIssue(context, path, 'ARRAY', 'Must be an array');
    return null;
  }
  if (value.length > maximum) {
    addIssue(context, path, 'ARRAY_LENGTH', `Array must contain at most ${maximum} entries`, maximum, value.length);
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0
    || ownPropertyNames(value).some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
    addIssue(context, path, 'ARRAY_FIELDS', 'Array cannot contain custom properties');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, descriptor]) => key !== 'length'
    && (descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true))) {
    addIssue(context, path, 'DATA_PROPERTIES', 'Array entries must be enumerable data properties');
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) addIssue(context, `${path}.${index}`, 'SPARSE_ARRAY', 'Sparse arrays are not supported');
  }
  return Array.from(value, (item: unknown) => item);
}

function required(context: ValidationContext, value: Record<string, unknown>, path: string, field: string): void {
  if (!Object.hasOwn(value, field)) addIssue(context, path === '$' ? field : `${path}.${field}`, 'REQUIRED', 'Field is required');
}

function safeInteger(
  context: ValidationContext,
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    addIssue(context, path, 'SAFE_INTEGER', 'Must be a safe integer', { minimum, maximum }, value);
    return false;
  }
  if (value < minimum || value > maximum) {
    addIssue(context, path, 'INTEGER_RANGE', `Must be between ${minimum} and ${maximum}`, { minimum, maximum }, value);
    return false;
  }
  return true;
}

function stableCode(context: ValidationContext, value: unknown, path: string): value is string {
  if (typeof value !== 'string' || value.length > 100 || !codePattern.test(value) || uuidPattern.test(value)) {
    addIssue(context, path, 'CODE', 'Must be a public lowercase stable code, not a UUID', undefined, value);
    return false;
  }
  return true;
}

function entryReference(context: ValidationContext, value: unknown, path: string): value is string {
  if (typeof value !== 'string' || value.length > 160 || !codePattern.test(value) || uuidPattern.test(value)) {
    addIssue(context, path, 'ENTRY_REF', 'Must be a stable public entry reference, not a UUID', undefined, value);
    return false;
  }
  return true;
}

function validateSpec(context: ValidationContext, value: unknown, path: string): CoreV1InventorySpec | null {
  const input = closedRecord(context, value, path, [
    'schemaVersion', 'rulesetCode', 'inventoryRulesCode', 'unitWeight', 'stacking',
    'equipmentSlots', 'handedness',
  ]);
  if (input === null) return null;
  for (const field of ['schemaVersion', 'rulesetCode', 'inventoryRulesCode', 'unitWeight', 'stacking']) {
    required(context, input, path, field);
  }
  if (input.schemaVersion !== CORE_V1_INVENTORY_SCHEMA_VERSION) {
    addIssue(context, `${path}.schemaVersion`, 'SCHEMA_VERSION', 'Inventory schema version must be 1', 1, input.schemaVersion);
  }
  if (input.rulesetCode !== CORE_V1_INVENTORY_RULESET_CODE) {
    addIssue(context, `${path}.rulesetCode`, 'RULESET_CODE', 'Inventory ruleset must be core-v1', CORE_V1_INVENTORY_RULESET_CODE, input.rulesetCode);
  }
  if (input.inventoryRulesCode !== CORE_V1_INVENTORY_RULES_CODE) {
    addIssue(context, `${path}.inventoryRulesCode`, 'INVENTORY_RULES_CODE', 'Inventory rules code is not supported', CORE_V1_INVENTORY_RULES_CODE, input.inventoryRulesCode);
  }
  safeInteger(context, input.unitWeight, `${path}.unitWeight`, 0, Number.MAX_SAFE_INTEGER);
  const stacking = closedRecord(context, input.stacking, `${path}.stacking`, ['mode', 'maxStack']);
  if (stacking !== null) {
    required(context, stacking, `${path}.stacking`, 'mode');
    if (stacking.mode === 'unique') {
      closedRecord(context, input.stacking, `${path}.stacking`, ['mode']);
    } else if (stacking.mode === 'stackable') {
      required(context, stacking, `${path}.stacking`, 'maxStack');
      safeInteger(context, stacking.maxStack, `${path}.stacking.maxStack`, 2, CORE_V1_MAX_STACK_QUANTITY);
    } else {
      addIssue(context, `${path}.stacking.mode`, 'ENUM', 'Stacking mode must be unique or stackable', ['unique', 'stackable'], stacking.mode);
    }
  }
  if (input.equipmentSlots !== undefined) {
    const slots = denseArray(context, input.equipmentSlots, `${path}.equipmentSlots`, CORE_V1_EQUIPMENT_SLOTS.length);
    const seen = new Set<string>();
    slots?.forEach((slot, index) => {
      if (typeof slot !== 'string' || !(CORE_V1_EQUIPMENT_SLOTS as readonly string[]).includes(slot)) {
        addIssue(context, `${path}.equipmentSlots.${index}`, 'EQUIPMENT_SLOT', 'Physical equipment slot is not supported', CORE_V1_EQUIPMENT_SLOTS, slot);
      } else if (seen.has(slot)) {
        addIssue(context, `${path}.equipmentSlots.${index}`, 'DUPLICATE', 'Physical equipment slots must be unique', undefined, slot);
      } else seen.add(slot);
    });
  }
  if (input.handedness !== undefined
    && (typeof input.handedness !== 'string' || !['one_handed', 'two_handed', 'versatile'].includes(input.handedness))) {
    addIssue(context, `${path}.handedness`, 'HANDEDNESS', 'Physical handedness is not supported', ['one_handed', 'two_handed', 'versatile'], input.handedness);
  }
  if ((input.equipmentSlots !== undefined || input.handedness !== undefined) && stacking?.mode !== 'unique') {
    addIssue(context, `${path}.stacking.mode`, 'EQUIPMENT_UNIQUE', 'Physical equipment declarations require unique stacking', 'unique', stacking?.mode);
  }
  return input as unknown as CoreV1InventorySpec;
}

function validateContentVersion(
  context: ValidationContext,
  value: unknown,
  path: string,
): CoreV1ContentVersionReference | null {
  const input = closedRecord(context, value, path, ['scope', 'contentType', 'code', 'versionNumber']);
  if (input === null) return null;
  for (const field of ['scope', 'contentType', 'code', 'versionNumber']) required(context, input, path, field);
  if (input.scope !== 'world' && input.scope !== 'campaign') {
    addIssue(context, `${path}.scope`, 'ENUM', 'Scope must be world or campaign', ['world', 'campaign'], input.scope);
  }
  if (typeof input.contentType !== 'string'
    || !(CORE_V1_INVENTORY_CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
    addIssue(context, `${path}.contentType`, 'ENUM', 'Content type is not a physical inventory type', CORE_V1_INVENTORY_CONTENT_TYPES, input.contentType);
  }
  stableCode(context, input.code, `${path}.code`);
  safeInteger(context, input.versionNumber, `${path}.versionNumber`, 1, Number.MAX_SAFE_INTEGER);
  return input as unknown as CoreV1ContentVersionReference;
}

function validateProfile(
  context: ValidationContext,
  value: unknown,
  contentVersion: CoreV1ContentVersionReference | null,
  path: string,
): CoreV1ContentProfile | null {
  if (value === null) {
    if (contentVersion !== null && !['material', 'other'].includes(contentVersion.contentType)) {
      addIssue(context, path, 'CANONICAL_PROFILE', 'Canonical inventory content requires its core-v1 profile');
    }
    return null;
  }
  const validation = validateCoreV1ContentProfile(value);
  if (!validation.ok) {
    validation.issues.forEach((issue) => addIssue(
      context,
      issue.path === '$' ? path : `${path}.${issue.path}`,
      issue.rule,
      issue.message,
      issue.expected,
      issue.received,
    ));
    return null;
  }
  if (contentVersion !== null) {
    if (validation.value.contentKind !== contentVersion.contentType) {
      addIssue(context, `${path}.contentKind`, 'CONTENT_TYPE_MATCH', 'Profile kind must match the referenced content type', contentVersion.contentType, validation.value.contentKind);
    }
    if (validation.value.code !== contentVersion.code) {
      addIssue(context, `${path}.code`, 'CONTENT_CODE_MATCH', 'Profile code must match the referenced content code', contentVersion.code, validation.value.code);
    }
  }
  return validation.value;
}

function mechanicalEquipmentRequiresUnique(
  profile: CoreV1ContentProfile | null,
  spec?: CoreV1InventorySpec | null,
): boolean {
  if (spec?.equipmentSlots !== undefined || spec?.handedness !== undefined) return true;
  if (profile === null || profile.profileMode !== 'mechanical') return false;
  return ['weapon', 'armor', 'shield', 'clothing'].includes(profile.contentKind)
    || profile.handedness !== undefined
    || (profile.equipmentSlots?.length ?? 0) > 0;
}

function validateEntry(context: ValidationContext, value: unknown, path: string): CoreV1InventoryEntry | null {
  const broad = closedRecord(context, value, path, [
    'entryKind', 'entryRef', 'contentVersion', 'inventorySpec', 'profile', 'customName', 'state', 'quantity',
  ]);
  if (broad === null) return null;
  required(context, broad, path, 'entryKind');
  if (broad.entryKind !== 'instance' && broad.entryKind !== 'stack') {
    addIssue(context, `${path}.entryKind`, 'ENUM', 'Entry kind must be instance or stack', ['instance', 'stack'], broad.entryKind);
    return null;
  }
  const instance = broad.entryKind === 'instance';
  const allowed = instance
    ? ['entryKind', 'entryRef', 'contentVersion', 'inventorySpec', 'profile', 'customName', 'state']
    : ['entryKind', 'entryRef', 'contentVersion', 'inventorySpec', 'profile', 'quantity'];
  closedRecord(context, value, path, allowed);
  for (const field of ['entryRef', 'contentVersion', 'inventorySpec', 'profile']) required(context, broad, path, field);
  entryReference(context, broad.entryRef, `${path}.entryRef`);
  const contentVersion = validateContentVersion(context, broad.contentVersion, `${path}.contentVersion`);
  const spec = validateSpec(context, broad.inventorySpec, `${path}.inventorySpec`);
  const profile = validateProfile(context, broad.profile, contentVersion, `${path}.profile`);
  if (instance) {
    required(context, broad, path, 'state');
    if (typeof broad.state !== 'string'
      || !(CORE_V1_INVENTORY_INSTANCE_STATES as readonly string[]).includes(broad.state)) {
      addIssue(context, `${path}.state`, 'ENUM', 'Instance state is not supported', CORE_V1_INVENTORY_INSTANCE_STATES, broad.state);
    }
    if (broad.customName !== undefined
      && (typeof broad.customName !== 'string' || broad.customName.trim().length === 0 || broad.customName.length > 200)) {
      addIssue(context, `${path}.customName`, 'TEXT', 'Custom name must be non-empty text with at most 200 characters');
    }
    if (spec !== null && spec.stacking.mode !== 'unique') {
      addIssue(context, `${path}.inventorySpec.stacking.mode`, 'INSTANCE_UNIQUE', 'Physical instances require unique stacking', 'unique', spec.stacking.mode);
    }
  } else {
    required(context, broad, path, 'quantity');
    if (spec !== null) {
      if (spec.stacking.mode !== 'stackable') {
        addIssue(context, `${path}.inventorySpec.stacking.mode`, 'STACKABLE_REQUIRED', 'Stacks require stackable inventory specs', 'stackable', spec.stacking.mode);
      } else {
        safeInteger(context, broad.quantity, `${path}.quantity`, 1, spec.stacking.maxStack);
      }
    } else {
      safeInteger(context, broad.quantity, `${path}.quantity`, 1, CORE_V1_MAX_STACK_QUANTITY);
    }
    if (mechanicalEquipmentRequiresUnique(profile, spec)) {
      addIssue(context, path, 'EQUIPMENT_UNIQUE', 'Mechanical equipment cannot be stored in a stack');
    }
  }
  if (contentVersion?.contentType === 'consumable'
    && (profile === null || profile.profileMode !== 'mechanical' || profile.contentKind !== 'consumable')) {
    addIssue(context, `${path}.profile`, 'CONSUMABLE_PROFILE', 'Consumables require a canonical mechanical consumable profile');
  }
  if (spec?.handedness !== undefined && contentVersion?.contentType !== 'weapon') {
    addIssue(context, `${path}.inventorySpec.handedness`, 'WEAPON_HANDEDNESS', 'Physical handedness is valid only for weapon content', 'weapon', contentVersion?.contentType);
  }
  if (profile?.profileMode === 'mechanical' && spec !== null) {
    if (profile.handedness !== undefined && spec.handedness !== undefined && profile.handedness !== spec.handedness) {
      addIssue(context, `${path}.inventorySpec.handedness`, 'PHYSICAL_PROFILE_MATCH', 'Physical handedness must match the canonical profile', profile.handedness, spec.handedness);
    }
    if (profile.equipmentSlots !== undefined && spec.equipmentSlots !== undefined) {
      const profileSlots = [...profile.equipmentSlots].sort();
      const specSlots = [...spec.equipmentSlots].sort();
      if (canonical(profileSlots) !== canonical(specSlots)) {
        addIssue(context, `${path}.inventorySpec.equipmentSlots`, 'PHYSICAL_PROFILE_MATCH', 'Physical slots must match the canonical profile', profileSlots, specSlots);
      }
    }
  }
  if (mechanicalEquipmentRequiresUnique(profile, spec) && spec?.stacking.mode !== 'unique') {
    addIssue(context, `${path}.inventorySpec.stacking.mode`, 'EQUIPMENT_UNIQUE', 'Mechanical equipment must use unique stacking', 'unique', spec?.stacking.mode);
  }
  return broad as unknown as CoreV1InventoryEntry;
}

function validateState(context: ValidationContext, value: unknown, path = '$'): CoreV1InventoryState | null {
  const input = closedRecord(context, value, path, ['entries']);
  if (input === null) return null;
  required(context, input, path, 'entries');
  const entries = denseArray(
    context,
    input.entries,
    path === '$' ? 'entries' : `${path}.entries`,
    CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION,
  );
  if (entries === null) return null;
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const validated = validateEntry(context, entry, `entries.${index}`);
    if (validated === null) return;
    if (seen.has(validated.entryRef)) {
      addIssue(context, `entries.${index}.entryRef`, 'DUPLICATE_ENTRY_REF', 'Inventory entry references must be unique', undefined, validated.entryRef);
    }
    seen.add(validated.entryRef);
  });
  return input as unknown as CoreV1InventoryState;
}

function canonical(value: unknown): string {
  return canonicalJson(value);
}

function sameContentVersion(left: CoreV1ContentVersionReference, right: CoreV1ContentVersionReference): boolean {
  return left.scope === right.scope
    && left.contentType === right.contentType
    && left.code === right.code
    && left.versionNumber === right.versionNumber;
}

function compatibleStack(
  entry: CoreV1InventoryEntry,
  contentVersion: CoreV1ContentVersionReference,
  spec: CoreV1InventorySpec,
  profile: CoreV1ContentProfile | null,
): entry is CoreV1InventoryStack {
  return entry.entryKind === 'stack'
    && sameContentVersion(entry.contentVersion, contentVersion)
    && canonical(entry.inventorySpec) === canonical(spec)
    && canonical(entry.profile) === canonical(profile);
}

function validatedState(input: unknown): CoreV1InventoryResult<CoreV1InventoryState> {
  const context: ValidationContext = { issues: [] };
  const value = validateState(context, input);
  if (value === null || context.issues.length > 0) return failure(context.issues);
  return success(value);
}

function changeResult(change: CoreV1InventoryChange): CoreV1InventoryResult<CoreV1InventoryChange> {
  const validation = validatedState(change.inventory);
  if (!validation.ok) return validation;
  return success({ ...change, inventory: validation.value });
}

export function validateCoreV1InventorySpec(input: unknown): CoreV1InventoryResult<CoreV1InventorySpec> {
  const context: ValidationContext = { issues: [] };
  const value = validateSpec(context, input, '$');
  if (value === null || context.issues.length > 0) return failure(context.issues);
  return success(value);
}

export function validateCoreV1InventoryState(input: unknown): CoreV1InventoryResult<CoreV1InventoryState> {
  return validatedState(input);
}

export function addInventoryEntry(
  state: CoreV1InventoryState,
  input: CoreV1AddInventoryInput,
): CoreV1InventoryResult<CoreV1InventoryChange> {
  const current = validatedState(state);
  if (!current.ok) return current;
  const context: ValidationContext = { issues: [] };
  const inputRecord = closedRecord(context, input, 'input', input.entryKind === 'instance'
    ? ['entryKind', 'entry']
    : ['entryKind', 'contentVersion', 'inventorySpec', 'profile', 'quantity', 'newEntryRefs']);
  if (inputRecord === null) return failure(context.issues);
  if (input.entryKind === 'instance') {
    const entry = validateEntry(context, input.entry, 'input.entry');
    if (entry?.entryKind !== 'instance') addIssue(context, 'input.entry.entryKind', 'INSTANCE_REQUIRED', 'Instance addition requires an instance entry');
    if (entry?.entryKind === 'instance' && ['consumed', 'destroyed'].includes(entry.state)) {
      addIssue(context, 'input.entry.state', 'ADD_STATE', 'Consumed or destroyed instances cannot be added');
    }
    if (entry !== null && current.value.entries.some((item) => item.entryRef === entry.entryRef)) {
      addIssue(context, 'input.entry.entryRef', 'DUPLICATE_ENTRY_REF', 'Entry reference already exists', undefined, entry.entryRef);
    }
    if (current.value.entries.length >= CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION) {
      addIssue(context, 'entries', 'ENTRY_LIMIT', 'Inventory operation would exceed the entry limit', CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION);
    }
    if (context.issues.length > 0 || entry?.entryKind !== 'instance') return failure(context.issues);
    return changeResult({
      inventory: { entries: [...current.value.entries, entry] },
      createdEntryRefs: [entry.entryRef], changedEntryRefs: [], removedEntryRefs: [],
    });
  }

  const contentVersion = validateContentVersion(context, input.contentVersion, 'input.contentVersion');
  const spec = validateSpec(context, input.inventorySpec, 'input.inventorySpec');
  const profile = validateProfile(context, input.profile, contentVersion, 'input.profile');
  if (spec !== null && spec.stacking.mode !== 'stackable') {
    addIssue(context, 'input.inventorySpec.stacking.mode', 'STACKABLE_REQUIRED', 'Stack addition requires a stackable spec');
  }
  if (mechanicalEquipmentRequiresUnique(profile, spec)) {
    addIssue(context, 'input.profile', 'EQUIPMENT_UNIQUE', 'Mechanical equipment cannot be added as stack quantity');
  }
  const quantityValid = safeInteger(context, input.quantity, 'input.quantity', 1, Number.MAX_SAFE_INTEGER);
  const refs = denseArray(context, input.newEntryRefs, 'input.newEntryRefs', CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION);
  const refSet = new Set<string>();
  refs?.forEach((ref, index) => {
    if (entryReference(context, ref, `input.newEntryRefs.${index}`)) {
      if (refSet.has(ref) || current.value.entries.some((entry) => entry.entryRef === ref)) {
        addIssue(context, `input.newEntryRefs.${index}`, 'DUPLICATE_ENTRY_REF', 'New stack references must be unique and unused', undefined, ref);
      }
      refSet.add(ref);
    }
  });
  if (context.issues.length > 0 || contentVersion === null || spec === null
    || spec.stacking.mode !== 'stackable' || !quantityValid || refs === null) return failure(context.issues);

  const stacking = spec.stacking;
  const entries = current.value.entries.map((entry) => structuredClone(entry));
  const changedEntryRefs: string[] = [];
  let remaining = input.quantity;
  entries.forEach((entry, index) => {
    if (remaining === 0 || !compatibleStack(entry, contentVersion, spec, profile)) return;
    const capacity = stacking.maxStack - entry.quantity;
    if (capacity <= 0) return;
    const added = Math.min(capacity, remaining);
    entries[index] = { ...entry, quantity: safeIntegerAdd(entry.quantity, added, 'stack quantity') };
    remaining -= added;
    changedEntryRefs.push(entry.entryRef);
  });
  const neededRefs = remaining === 0 ? 0 : ceilDiv(remaining, stacking.maxStack);
  if (refs.length !== neededRefs) {
    addIssue(context, 'input.newEntryRefs', 'STACK_REF_COUNT', 'Must supply exactly one deterministic reference for every new stack', neededRefs, refs.length);
  }
  if (entries.length + neededRefs > CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION) {
    addIssue(context, 'entries', 'ENTRY_LIMIT', 'Stack addition would exceed the operation entry limit', CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION, entries.length + neededRefs);
  }
  if (context.issues.length > 0) return failure(context.issues);
  const createdEntryRefs: string[] = [];
  for (let index = 0; index < neededRefs; index += 1) {
    const entryRef = refs[index];
    if (typeof entryRef !== 'string') throw new Error('Validated stack reference is missing');
    const stackQuantity = Math.min(remaining, stacking.maxStack);
    entries.push({
      entryKind: 'stack', entryRef, contentVersion, inventorySpec: spec, profile, quantity: stackQuantity,
    });
    createdEntryRefs.push(entryRef);
    remaining -= stackQuantity;
  }
  if (remaining !== 0) throw new Error('Stack addition lost quantity');
  return changeResult({
    inventory: { entries }, createdEntryRefs, changedEntryRefs, removedEntryRefs: [],
  });
}

export function removeInventoryQuantity(
  state: CoreV1InventoryState,
  entryRef: string,
  quantity: number,
): CoreV1InventoryResult<CoreV1InventoryChange> {
  const current = validatedState(state);
  if (!current.ok) return current;
  const context: ValidationContext = { issues: [] };
  entryReference(context, entryRef, 'entryRef');
  safeInteger(context, quantity, 'quantity', 1, Number.MAX_SAFE_INTEGER);
  const index = current.value.entries.findIndex((entry) => entry.entryRef === entryRef);
  if (index < 0) addIssue(context, 'entryRef', 'ENTRY_NOT_FOUND', 'Inventory entry was not found', undefined, entryRef);
  const entry = current.value.entries[index];
  if (entry?.entryKind === 'instance') {
    if (quantity !== 1) addIssue(context, 'quantity', 'UNIQUE_QUANTITY', 'Unique instances can only be removed as one unit', 1, quantity);
    if (entry.state === 'equipped') addIssue(context, 'entryRef', 'EQUIPPED_REMOVAL', 'Equipped instances must be unequipped before removal');
  } else if (entry !== undefined && quantity > entry.quantity) {
    addIssue(context, 'quantity', 'INSUFFICIENT_QUANTITY', 'Removal quantity exceeds the stack quantity', entry.quantity, quantity);
  }
  if (context.issues.length > 0 || entry === undefined) return failure(context.issues);
  const entries = [...current.value.entries];
  if (entry.entryKind === 'instance' || quantity === entry.quantity) {
    entries.splice(index, 1);
    return changeResult({
      inventory: { entries }, createdEntryRefs: [], changedEntryRefs: [], removedEntryRefs: [entryRef],
    });
  }
  entries[index] = { ...entry, quantity: entry.quantity - quantity };
  return changeResult({
    inventory: { entries }, createdEntryRefs: [], changedEntryRefs: [entryRef], removedEntryRefs: [],
  });
}

export function splitInventoryStack(
  state: CoreV1InventoryState,
  entryRef: string,
  splitQuantity: number,
  newEntryRef: string,
): CoreV1InventoryResult<CoreV1InventoryChange> {
  const current = validatedState(state);
  if (!current.ok) return current;
  const context: ValidationContext = { issues: [] };
  entryReference(context, entryRef, 'entryRef');
  entryReference(context, newEntryRef, 'newEntryRef');
  if (current.value.entries.some((entry) => entry.entryRef === newEntryRef)) {
    addIssue(context, 'newEntryRef', 'DUPLICATE_ENTRY_REF', 'New stack reference already exists', undefined, newEntryRef);
  }
  const index = current.value.entries.findIndex((entry) => entry.entryRef === entryRef);
  const entry = current.value.entries[index];
  if (entry === undefined) addIssue(context, 'entryRef', 'ENTRY_NOT_FOUND', 'Inventory entry was not found', undefined, entryRef);
  else if (entry.entryKind !== 'stack') addIssue(context, 'entryRef', 'STACK_REQUIRED', 'Only stack entries can be split');
  else safeInteger(context, splitQuantity, 'splitQuantity', 1, entry.quantity - 1);
  if (current.value.entries.length >= CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION) {
    addIssue(context, 'entries', 'ENTRY_LIMIT', 'Split would exceed the operation entry limit', CORE_V1_MAX_INVENTORY_ENTRIES_PER_OPERATION);
  }
  if (context.issues.length > 0 || entry?.entryKind !== 'stack') return failure(context.issues);
  const entries = [...current.value.entries];
  entries[index] = { ...entry, quantity: entry.quantity - splitQuantity };
  entries.splice(index + 1, 0, { ...entry, entryRef: newEntryRef, quantity: splitQuantity });
  return changeResult({
    inventory: { entries }, createdEntryRefs: [newEntryRef], changedEntryRefs: [entryRef], removedEntryRefs: [],
  });
}

export function mergeInventoryStacks(
  state: CoreV1InventoryState,
  keptEntryRef: string,
  removedEntryRef: string,
): CoreV1InventoryResult<CoreV1InventoryChange> {
  const current = validatedState(state);
  if (!current.ok) return current;
  const context: ValidationContext = { issues: [] };
  entryReference(context, keptEntryRef, 'keptEntryRef');
  entryReference(context, removedEntryRef, 'removedEntryRef');
  if (keptEntryRef === removedEntryRef) addIssue(context, 'removedEntryRef', 'DISTINCT_REFS', 'Merge entries must be distinct');
  const keptIndex = current.value.entries.findIndex((entry) => entry.entryRef === keptEntryRef);
  const removedIndex = current.value.entries.findIndex((entry) => entry.entryRef === removedEntryRef);
  const kept = current.value.entries[keptIndex];
  const removed = current.value.entries[removedIndex];
  if (kept?.entryKind !== 'stack') addIssue(context, 'keptEntryRef', 'STACK_REQUIRED', 'Kept entry must be a stack');
  if (removed?.entryKind !== 'stack') addIssue(context, 'removedEntryRef', 'STACK_REQUIRED', 'Removed entry must be a stack');
  if (kept?.entryKind === 'stack' && removed?.entryKind === 'stack') {
    if (!sameContentVersion(kept.contentVersion, removed.contentVersion)) {
      addIssue(context, 'removedEntryRef', 'CONTENT_VERSION_MATCH', 'Stacks must reference the same exact content version');
    }
    if (canonical(kept.inventorySpec) !== canonical(removed.inventorySpec)
      || canonical(kept.profile) !== canonical(removed.profile)) {
      addIssue(context, 'removedEntryRef', 'HOMOGENEOUS_STACK', 'Stacks must use the same canonical spec and profile');
    }
    const maxStack = kept.inventorySpec.stacking.mode === 'stackable'
      ? kept.inventorySpec.stacking.maxStack
      : CORE_V1_MAX_STACK_QUANTITY;
    try {
      const total = safeIntegerAdd(kept.quantity, removed.quantity, 'merged stack quantity');
      if (total > maxStack) addIssue(context, 'removedEntryRef', 'MAX_STACK', 'Merged quantity exceeds maxStack', maxStack, total);
    } catch {
      addIssue(context, 'removedEntryRef', 'SAFE_INTEGER', 'Merged quantity must remain a safe integer');
    }
  }
  if (context.issues.length > 0 || kept?.entryKind !== 'stack' || removed?.entryKind !== 'stack') return failure(context.issues);
  const entries = current.value.entries
    .filter((entry) => entry.entryRef !== removedEntryRef)
    .map((entry) => entry.entryRef === keptEntryRef
      ? { ...kept, quantity: safeIntegerAdd(kept.quantity, removed.quantity, 'merged stack quantity') }
      : entry);
  return changeResult({
    inventory: { entries }, createdEntryRefs: [], changedEntryRefs: [keptEntryRef], removedEntryRefs: [removedEntryRef],
  });
}

export function calculateInventoryWeight(
  state: CoreV1InventoryState,
): CoreV1InventoryResult<CoreV1InventoryWeight> {
  const current = validatedState(state);
  if (!current.ok) return current;
  const context: ValidationContext = { issues: [] };
  const entryWeights: CoreV1InventoryWeight['entryWeights'][number][] = [];
  let totalCarriedWeight = 0;
  for (const entry of current.value.entries) {
    const quantity = entry.entryKind === 'stack' ? entry.quantity : 1;
    if (entry.entryKind === 'instance' && ['consumed', 'destroyed'].includes(entry.state)) continue;
    try {
      const weight = safeIntegerMultiply(entry.inventorySpec.unitWeight, quantity, `${entry.entryRef} weight`);
      totalCarriedWeight = safeIntegerAdd(totalCarriedWeight, weight, 'inventory weight');
      entryWeights.push({ entryRef: entry.entryRef, quantity, weight });
    } catch {
      addIssue(context, `entries.${entry.entryRef}`, 'SAFE_INTEGER_WEIGHT', 'Entry and total weight must remain safe integers');
      break;
    }
  }
  if (context.issues.length > 0) return failure(context.issues);
  return success({ totalCarriedWeight, entryWeights });
}

export function calculateInventoryEncumbrance(
  carriedWeight: number,
  carryingCapacity: number,
): CoreV1InventoryResult<CoreV1InventoryEncumbrance> {
  const context: ValidationContext = { issues: [] };
  const validWeight = safeInteger(context, carriedWeight, 'carriedWeight', 0, Number.MAX_SAFE_INTEGER);
  const validCapacity = safeInteger(context, carryingCapacity, 'carryingCapacity', 0, Number.MAX_SAFE_INTEGER);
  if (!validWeight || !validCapacity) return failure(context.issues);
  const encumbrance = calculateEncumbrance(carriedWeight, carryingCapacity);
  let ratioBps: number | null;
  if (carryingCapacity === 0) ratioBps = carriedWeight === 0 ? 0 : null;
  else {
    const ratio = BigInt(carriedWeight) * 10000n / BigInt(carryingCapacity);
    ratioBps = ratio <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(ratio) : null;
  }
  return success({
    carriedWeight,
    carryingCapacity,
    ratioBps,
    state: encumbrance.encumbranceState,
    penaltyBps: encumbrance.encumbrancePenaltyBps,
    canStartAttackOrMovement: encumbrance.canStartAttackOrMovement,
  });
}
