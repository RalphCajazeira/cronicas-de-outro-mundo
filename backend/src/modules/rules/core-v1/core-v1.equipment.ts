import {
  CORE_V1_EQUIPMENT_SLOT_CATALOG,
  CORE_V1_EQUIPMENT_SLOT_REFS,
  CORE_V1_MAX_EQUIPPED_ENTRIES,
} from './core-v1.inventory.config.js';
import type {
  CoreV1AggregatedEquipmentModifier,
  CoreV1CollectedEquipmentModifier,
  CoreV1EquipPlan,
  CoreV1EquipmentChange,
  CoreV1EquipmentConflict,
  CoreV1EquipmentLoadout,
  CoreV1EquipmentRequirementContext,
  CoreV1EquipmentRequirementEvaluation,
  CoreV1EquipmentSlotInstance,
  CoreV1EquipmentSlotRef,
  CoreV1InventoryInstance,
  CoreV1InventoryResult,
  CoreV1InventoryState,
  CoreV1PlanEquipInput,
} from './core-v1.inventory.types.js';
import type {
  CoreV1MechanicalContentProfile,
  CoreV1Requirements,
} from './core-v1.content-mechanics.types.js';
import { CORE_V1_PRIMARY_ATTRIBUTES } from './core-v1.config.js';
import { isPlainRecord, safeIntegerAdd } from './core-v1.math.js';
import { validateCoreV1InventoryState } from './core-v1.inventory.js';
import type { ValidationIssue } from './core-v1.types.js';

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

function exactRecord(
  context: ValidationContext,
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainRecord(value)) {
    addIssue(context, path, 'PLAIN_OBJECT', 'Must be a plain object');
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    addIssue(context, path, 'PLAIN_OBJECT', 'Unexpected object prototype');
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) addIssue(context, path, 'SYMBOL_KEYS', 'Symbol keys are not supported');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined
    || descriptor.set !== undefined || descriptor.enumerable !== true)) {
    addIssue(context, path, 'DATA_PROPERTIES', 'Object fields must be enumerable data properties');
    return null;
  }
  const allowed = new Set(keys);
  Object.getOwnPropertyNames(value).sort().forEach((key) => {
    if (!allowed.has(key)) addIssue(context, `${path}.${key}`, 'UNKNOWN_FIELD', 'Unsupported field', keys, key);
  });
  return value;
}

function validateDenseSlots(context: ValidationContext, value: unknown): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    addIssue(context, 'slots', 'ARRAY', 'Loadout slots must be an array');
    return null;
  }
  if (value.length !== CORE_V1_EQUIPMENT_SLOT_CATALOG.length) {
    addIssue(context, 'slots', 'SLOT_CATALOG', 'Loadout must contain every configured slot instance', CORE_V1_EQUIPMENT_SLOT_CATALOG.length, value.length);
    return null;
  }
  if (Object.getOwnPropertySymbols(value).length > 0
    || Object.getOwnPropertyNames(value).filter((key) => key !== 'length')
      .some((key) => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
    addIssue(context, 'slots', 'ARRAY_FIELDS', 'Loadout slot array cannot contain custom properties');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.entries(descriptors).some(([key, descriptor]) => key !== 'length'
    && (descriptor.get !== undefined || descriptor.set !== undefined || descriptor.enumerable !== true))) {
    addIssue(context, 'slots', 'DATA_PROPERTIES', 'Loadout slots must be enumerable data properties');
    return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) addIssue(context, `slots.${index}`, 'SPARSE_ARRAY', 'Sparse arrays are not supported');
  }
  return Array.from(value, (slot: unknown) => slot);
}

function slotCatalogIndex(slotRef: CoreV1EquipmentSlotRef): number {
  return CORE_V1_EQUIPMENT_SLOT_REFS.indexOf(slotRef);
}

function sortSlotRefs(slotRefs: readonly CoreV1EquipmentSlotRef[]): CoreV1EquipmentSlotRef[] {
  return [...new Set(slotRefs)].sort((left, right) => slotCatalogIndex(left) - slotCatalogIndex(right));
}

function slotTypeFor(slotRef: CoreV1EquipmentSlotRef) {
  const slot = CORE_V1_EQUIPMENT_SLOT_CATALOG.find((candidate) => candidate.slotRef === slotRef);
  if (slot === undefined) throw new Error(`Unknown configured slot ${slotRef}`);
  return slot.slotType;
}

function inventoryInstance(
  inventory: CoreV1InventoryState,
  entryRef: string,
): CoreV1InventoryInstance | null {
  const entry = inventory.entries.find((candidate) => candidate.entryRef === entryRef);
  return entry?.entryKind === 'instance' ? entry : null;
}

function equipmentProfile(entry: CoreV1InventoryInstance): CoreV1MechanicalContentProfile | null {
  return entry.profile?.profileMode === 'mechanical' ? entry.profile : null;
}

function handSlotsForProfile(
  context: ValidationContext,
  entry: CoreV1InventoryInstance,
  input: CoreV1PlanEquipInput,
): readonly CoreV1EquipmentSlotRef[] {
  const profile = equipmentProfile(entry);
  if (profile === null) return [];
  const handedness = entry.inventorySpec.handedness ?? profile.handedness;
  const target = input.targetSlotRef;
  if (handedness === 'one_handed') {
    if (target !== 'main_hand' && target !== 'off_hand') {
      addIssue(context, 'targetSlotRef', 'HAND_SLOT_REQUIRED', 'One-handed weapons require an explicit main_hand or off_hand target');
      return [];
    }
    if (input.versatileMode !== undefined) addIssue(context, 'versatileMode', 'NOT_VERSATILE', 'Only versatile weapons accept a versatile mode');
    return [target];
  }
  if (handedness === 'two_handed') {
    if (target !== undefined && target !== 'main_hand') {
      addIssue(context, 'targetSlotRef', 'TWO_HANDED_MAIN_HAND', 'Two-handed weapons must be equipped from main_hand', 'main_hand', target);
    }
    if (input.versatileMode !== undefined) addIssue(context, 'versatileMode', 'NOT_VERSATILE', 'Only versatile weapons accept a versatile mode');
    return ['main_hand', 'off_hand'];
  }
  if (handedness === 'versatile') {
    if (input.versatileMode === undefined) {
      addIssue(context, 'versatileMode', 'VERSATILE_MODE_REQUIRED', 'Versatile weapons require an explicit one_handed or two_handed mode');
      return [];
    }
    if (input.versatileMode === 'two_handed') {
      if (target !== undefined && target !== 'main_hand') {
        addIssue(context, 'targetSlotRef', 'TWO_HANDED_MAIN_HAND', 'Two-handed versatile mode must start in main_hand', 'main_hand', target);
      }
      return ['main_hand', 'off_hand'];
    }
    if (target !== 'main_hand' && target !== 'off_hand') {
      addIssue(context, 'targetSlotRef', 'HAND_SLOT_REQUIRED', 'One-handed versatile mode requires an explicit hand target');
      return [];
    }
    return [target];
  }
  addIssue(context, 'profile.handedness', 'HANDEDNESS_REQUIRED', 'Weapons require canonical handedness');
  return [];
}

function requiredSlotsForProfile(
  context: ValidationContext,
  entry: CoreV1InventoryInstance,
  loadout: CoreV1EquipmentLoadout,
  input: CoreV1PlanEquipInput,
): readonly CoreV1EquipmentSlotRef[] {
  const profile = equipmentProfile(entry);
  if (profile === null) return [];
  if (profile.contentKind === 'weapon' || entry.inventorySpec.handedness !== undefined) {
    return handSlotsForProfile(context, entry, input);
  }
  if (input.versatileMode !== undefined) addIssue(context, 'versatileMode', 'NOT_VERSATILE', 'Only versatile weapons accept a versatile mode');
  const declared = entry.inventorySpec.equipmentSlots ?? profile.equipmentSlots;
  if (declared === undefined || declared.length === 0) {
    addIssue(context, 'profile.equipmentSlots', 'EQUIPMENT_SLOTS_REQUIRED', 'Item has no physical equipment slots');
    return [];
  }
  const result: CoreV1EquipmentSlotRef[] = [];
  declared.forEach((slotType) => {
    if (slotType !== 'accessory') {
      result.push(slotType);
      return;
    }
    if (input.targetSlotRef !== undefined) {
      if (!['accessory_1', 'accessory_2'].includes(input.targetSlotRef)) {
        addIssue(context, 'targetSlotRef', 'ACCESSORY_SLOT', 'Accessory target must be accessory_1 or accessory_2');
      } else result.push(input.targetSlotRef);
      return;
    }
    const available = loadout.slots.find((slot) => slot.slotType === 'accessory' && slot.entryRef === null)
      ?? loadout.slots.find((slot) => slot.slotType === 'accessory');
    if (available !== undefined) result.push(available.slotRef);
  });
  if (input.targetSlotRef !== undefined && !declared.includes(slotTypeFor(input.targetSlotRef))) {
    addIssue(context, 'targetSlotRef', 'INCOMPATIBLE_SLOT', 'Target slot is not declared by the equipment profile', declared, input.targetSlotRef);
  }
  return sortSlotRefs(result);
}

function occupiedSlotRefs(loadout: CoreV1EquipmentLoadout, entryRef: string): readonly CoreV1EquipmentSlotRef[] {
  return sortSlotRefs(loadout.slots.filter((slot) => slot.entryRef === entryRef).map((slot) => slot.slotRef));
}

function validateOccupiedProfile(
  context: ValidationContext,
  entry: CoreV1InventoryInstance,
  slotRefs: readonly CoreV1EquipmentSlotRef[],
): void {
  const profile = equipmentProfile(entry);
  if (profile === null) {
    addIssue(context, `entries.${entry.entryRef}.profile`, 'MECHANICAL_EQUIPMENT', 'Equipped entries require a mechanical profile');
    return;
  }
  if (profile.contentKind === 'weapon') {
    const handedness = entry.inventorySpec.handedness ?? profile.handedness;
    const hands = new Set(slotRefs);
    if ([...hands].some((slot) => slot !== 'main_hand' && slot !== 'off_hand')) {
      addIssue(context, `entries.${entry.entryRef}`, 'WEAPON_HAND_SLOT', 'Weapons can occupy only hand slots');
    }
    if (handedness === 'two_handed' && !(hands.has('main_hand') && hands.has('off_hand') && hands.size === 2)) {
      addIssue(context, `entries.${entry.entryRef}`, 'TWO_HANDED_SLOTS', 'Two-handed weapon must occupy both hands');
    }
    if (handedness === 'one_handed' && hands.size !== 1) {
      addIssue(context, `entries.${entry.entryRef}`, 'ONE_HANDED_SLOTS', 'One-handed weapon must occupy exactly one hand');
    }
    if (handedness === 'versatile' && hands.size !== 1 && hands.size !== 2) {
      addIssue(context, `entries.${entry.entryRef}`, 'VERSATILE_SLOTS', 'Versatile weapon must occupy one or both hands');
    }
    return;
  }
  const declared = entry.inventorySpec.equipmentSlots ?? profile.equipmentSlots;
  if (declared === undefined || declared.length === 0) {
    addIssue(context, `entries.${entry.entryRef}.profile.equipmentSlots`, 'EQUIPMENT_SLOTS_REQUIRED', 'Equipped item has no physical slots');
    return;
  }
  const actualTypes = new Set(slotRefs.map(slotTypeFor));
  const declaredTypes = new Set(declared);
  if (actualTypes.size !== declaredTypes.size
    || [...declaredTypes].some((slotType) => !actualTypes.has(slotType))) {
    addIssue(context, `entries.${entry.entryRef}`, 'MULTISLOT_ATOMIC', 'Equipped item must occupy all and only its declared slot types', declared, [...actualTypes]);
  }
}

function validatedInventory(state: CoreV1InventoryState): CoreV1InventoryResult<CoreV1InventoryState> {
  return validateCoreV1InventoryState(state);
}

export function createCoreV1EmptyEquipmentLoadout(): CoreV1EquipmentLoadout {
  return { slots: CORE_V1_EQUIPMENT_SLOT_CATALOG.map((slot) => ({ ...slot })) };
}

export function validateEquipmentLoadout(
  inventory: CoreV1InventoryState,
  loadout: unknown,
): CoreV1InventoryResult<CoreV1EquipmentLoadout> {
  const validInventory = validatedInventory(inventory);
  if (!validInventory.ok) return validInventory;
  const context: ValidationContext = { issues: [] };
  const input = exactRecord(context, loadout, '$', ['slots']);
  if (input === null) return failure(context.issues);
  const rawSlots = validateDenseSlots(context, input.slots);
  if (rawSlots === null) return failure(context.issues);
  const slots: CoreV1EquipmentSlotInstance[] = [];
  const seenSlotRefs = new Set<string>();
  rawSlots.forEach((rawSlot, index) => {
    const slot = exactRecord(context, rawSlot, `slots.${index}`, ['slotRef', 'slotType', 'entryRef']);
    if (slot === null) return;
    const catalog = CORE_V1_EQUIPMENT_SLOT_CATALOG.find((candidate) => candidate.slotRef === slot.slotRef);
    if (catalog === undefined) {
      addIssue(context, `slots.${index}.slotRef`, 'SLOT_REF', 'Slot reference is not configured', CORE_V1_EQUIPMENT_SLOT_REFS, slot.slotRef);
      return;
    }
    if (seenSlotRefs.has(catalog.slotRef)) addIssue(context, `slots.${index}.slotRef`, 'DUPLICATE_SLOT_REF', 'Slot references must be unique');
    seenSlotRefs.add(catalog.slotRef);
    if (slot.slotType !== catalog.slotType) {
      addIssue(context, `slots.${index}.slotType`, 'SLOT_TYPE', 'Slot type must match its configured instance', catalog.slotType, slot.slotType);
    }
    if (slot.entryRef !== null && typeof slot.entryRef !== 'string') {
      addIssue(context, `slots.${index}.entryRef`, 'ENTRY_REF', 'Equipped entry reference must be a string or null');
    }
    slots.push(slot as unknown as CoreV1EquipmentSlotInstance);
  });
  CORE_V1_EQUIPMENT_SLOT_REFS.forEach((slotRef) => {
    if (!seenSlotRefs.has(slotRef)) addIssue(context, 'slots', 'MISSING_SLOT', 'Configured loadout slot is missing', slotRef);
  });

  const refs = [...new Set(slots.flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef]))];
  if (refs.length > CORE_V1_MAX_EQUIPPED_ENTRIES) {
    addIssue(context, 'slots', 'EQUIPPED_ENTRY_LIMIT', 'Loadout exceeds the equipped entry limit', CORE_V1_MAX_EQUIPPED_ENTRIES, refs.length);
  }
  refs.forEach((entryRef) => {
    const entry = inventoryInstance(validInventory.value, entryRef);
    if (entry === null) {
      addIssue(context, 'slots', 'EQUIPPED_ENTRY_NOT_FOUND', 'Equipped entry must be a unique inventory instance', undefined, entryRef);
      return;
    }
    if (entry.state !== 'equipped') addIssue(context, `entries.${entryRef}.state`, 'EQUIPPED_STATE', 'Loadout entry must use equipped state', 'equipped', entry.state);
    validateOccupiedProfile(context, entry, occupiedSlotRefs({ slots }, entryRef));
  });
  validInventory.value.entries.forEach((entry) => {
    if (entry.entryKind === 'instance' && entry.state === 'equipped' && !refs.includes(entry.entryRef)) {
      addIssue(context, `entries.${entry.entryRef}.state`, 'LOADOUT_LINK', 'Equipped inventory instance must occupy its loadout slots');
    }
  });
  if (context.issues.length > 0) return failure(context.issues);
  return success({ slots });
}

export function evaluateEquipmentRequirements(
  requirements: CoreV1Requirements | undefined,
  context: CoreV1EquipmentRequirementContext,
): CoreV1EquipmentRequirementEvaluation {
  const validation: ValidationContext = { issues: [] };
  if (!Number.isSafeInteger(context.level) || context.level < 1) {
    addIssue(validation, 'context.level', 'LEVEL', 'Actor level must be a positive safe integer');
  }
  CORE_V1_PRIMARY_ATTRIBUTES.forEach((attribute) => {
    const value = context.primaryAttributes[attribute];
    if (!Number.isSafeInteger(value) || value < 0) {
      addIssue(validation, `context.primaryAttributes.${attribute}`, 'PRIMARY_ATTRIBUTE', 'Primary attribute must be a non-negative safe integer');
    }
  });
  if (requirements === undefined) return { met: validation.issues.length === 0, issues: validation.issues };
  if (requirements.minimumLevel !== undefined && context.level < requirements.minimumLevel) {
    addIssue(validation, 'requirements.minimumLevel', 'MINIMUM_LEVEL', 'Actor level does not meet the equipment requirement', requirements.minimumLevel, context.level);
  }
  CORE_V1_PRIMARY_ATTRIBUTES.forEach((attribute) => {
    const minimum = requirements.minimumPrimaryAttributes?.[attribute];
    if (minimum !== undefined && context.primaryAttributes[attribute] < minimum) {
      addIssue(validation, `requirements.minimumPrimaryAttributes.${attribute}`, 'MINIMUM_PRIMARY_ATTRIBUTE', 'Actor attribute does not meet the equipment requirement', minimum, context.primaryAttributes[attribute]);
    }
  });
  const known = new Set(context.knownContentRefs.map((ref) => `${ref.contentKind}:${ref.code}`));
  requirements.requiredContent?.forEach((ref, index) => {
    if (!known.has(`${ref.contentKind}:${ref.code}`)) {
      addIssue(validation, `requirements.requiredContent.${index}`, 'REQUIRED_CONTENT', 'Actor does not know required content', ref);
    }
  });
  const weaponTags = new Set(context.equippedWeaponTags);
  requirements.requiredWeaponTags?.forEach((tag, index) => {
    if (!weaponTags.has(tag)) addIssue(validation, `requirements.requiredWeaponTags.${index}`, 'REQUIRED_WEAPON_TAG', 'Required weapon tag is not currently equipped', tag);
  });
  const equipmentTags = new Set(context.equippedEquipmentTags);
  requirements.requiredEquipmentTags?.forEach((tag, index) => {
    if (!equipmentTags.has(tag)) addIssue(validation, `requirements.requiredEquipmentTags.${index}`, 'REQUIRED_EQUIPMENT_TAG', 'Required equipment tag is not currently equipped', tag);
  });
  if (requirements.requiredRuleset !== undefined && context.rulesetCode !== requirements.requiredRuleset) {
    addIssue(validation, 'requirements.requiredRuleset', 'REQUIRED_RULESET', 'Actor ruleset does not meet the equipment requirement', requirements.requiredRuleset, context.rulesetCode);
  }
  return { met: validation.issues.length === 0, issues: validation.issues };
}

export function planEquipItem(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
  input: CoreV1PlanEquipInput,
  requirementContext: CoreV1EquipmentRequirementContext,
): CoreV1InventoryResult<CoreV1EquipPlan> {
  const validInventory = validatedInventory(inventory);
  if (!validInventory.ok) return validInventory;
  const validLoadout = validateEquipmentLoadout(validInventory.value, loadout);
  if (!validLoadout.ok) return validLoadout;
  const context: ValidationContext = { issues: [] };
  const inputRecord = exactRecord(context, input, 'input', ['entryRef', 'targetSlotRef', 'versatileMode']);
  if (inputRecord === null || typeof input.entryRef !== 'string') {
    addIssue(context, 'input.entryRef', 'ENTRY_REF', 'Entry reference is required');
    return failure(context.issues);
  }
  if (input.targetSlotRef !== undefined && !(CORE_V1_EQUIPMENT_SLOT_REFS as readonly string[]).includes(input.targetSlotRef)) {
    addIssue(context, 'input.targetSlotRef', 'SLOT_REF', 'Target slot is not configured', CORE_V1_EQUIPMENT_SLOT_REFS, input.targetSlotRef);
  }
  if (input.versatileMode !== undefined && !['one_handed', 'two_handed'].includes(input.versatileMode)) {
    addIssue(context, 'input.versatileMode', 'VERSATILE_MODE', 'Versatile mode must be one_handed or two_handed');
  }
  const entry = inventoryInstance(validInventory.value, input.entryRef);
  if (entry === null) {
    addIssue(context, 'input.entryRef', 'EQUIPPABLE_INSTANCE', 'Entry must exist as a unique inventory instance');
    return success({
      entryRef: input.entryRef, requiredSlots: [], occupiedConflicts: [],
      requirements: { met: false, issues: context.issues }, canEquip: false, issues: context.issues,
    });
  }
  if (entry.state !== 'available') addIssue(context, 'entry.state', 'AVAILABLE_REQUIRED', 'Item must be available before equip', 'available', entry.state);
  const profile = equipmentProfile(entry);
  if (profile === null) addIssue(context, 'entry.profile', 'MECHANICAL_EQUIPMENT', 'Narrative or missing profiles cannot be equipped');
  if (profile !== null && profile.rulesetCode !== requirementContext.rulesetCode) {
    addIssue(context, 'entry.profile.rulesetCode', 'RULESET_COMPATIBILITY', 'Equipment profile and actor ruleset must match', profile.rulesetCode, requirementContext.rulesetCode);
  }
  const requiredSlots = profile === null ? [] : requiredSlotsForProfile(context, entry, validLoadout.value, input);
  const occupiedConflicts: CoreV1EquipmentConflict[] = requiredSlots.flatMap((slotRef) => {
    const slot = validLoadout.value.slots.find((candidate) => candidate.slotRef === slotRef);
    return slot?.entryRef === null || slot?.entryRef === undefined
      ? []
      : [{ slotRef, entryRef: slot.entryRef }];
  });
  occupiedConflicts.forEach((conflict) => addIssue(
    context,
    `slots.${conflict.slotRef}`,
    'OCCUPIED_SLOT',
    'Required equipment slot is occupied and must be explicitly unequipped',
    null,
    conflict.entryRef,
  ));
  const requirements = evaluateEquipmentRequirements(profile?.requirements, requirementContext);
  const issues = [...context.issues, ...requirements.issues];
  return success({
    entryRef: entry.entryRef,
    requiredSlots,
    occupiedConflicts,
    requirements,
    canEquip: issues.length === 0 && requiredSlots.length > 0,
    issues,
  });
}

export function equipItem(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
  input: CoreV1PlanEquipInput,
  requirementContext: CoreV1EquipmentRequirementContext,
): CoreV1InventoryResult<CoreV1EquipmentChange> {
  const plan = planEquipItem(inventory, loadout, input, requirementContext);
  if (!plan.ok) return plan;
  if (!plan.value.canEquip) return failure(plan.value.issues);
  const entries = inventory.entries.map((entry) => entry.entryRef === input.entryRef && entry.entryKind === 'instance'
    ? { ...entry, state: 'equipped' as const }
    : entry);
  const slots = loadout.slots.map((slot) => plan.value.requiredSlots.includes(slot.slotRef)
    ? { ...slot, entryRef: input.entryRef }
    : slot);
  const nextInventory = { entries };
  const nextLoadout = { slots };
  const validation = validateEquipmentLoadout(nextInventory, nextLoadout);
  if (!validation.ok) return validation;
  return success({
    inventory: nextInventory,
    loadout: validation.value,
    entryRef: input.entryRef,
    changedSlots: plan.value.requiredSlots,
  });
}

export function unequipItem(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
  entryRef: string,
): CoreV1InventoryResult<CoreV1EquipmentChange> {
  const validLoadout = validateEquipmentLoadout(inventory, loadout);
  if (!validLoadout.ok) return validLoadout;
  const context: ValidationContext = { issues: [] };
  const entry = inventoryInstance(inventory, entryRef);
  if (entry === null) addIssue(context, 'entryRef', 'EQUIPPED_INSTANCE', 'Entry must exist as a unique inventory instance');
  else if (entry.state !== 'equipped') addIssue(context, 'entryRef', 'EQUIPPED_STATE', 'Entry is not equipped', 'equipped', entry.state);
  const changedSlots = occupiedSlotRefs(validLoadout.value, entryRef);
  if (changedSlots.length === 0) addIssue(context, 'entryRef', 'LOADOUT_LINK', 'Entry does not occupy any loadout slot');
  if (context.issues.length > 0 || entry === null) return failure(context.issues);
  const entries = inventory.entries.map((candidate) => candidate.entryRef === entryRef && candidate.entryKind === 'instance'
    ? { ...candidate, state: 'available' as const }
    : candidate);
  const slots = validLoadout.value.slots.map((slot) => slot.entryRef === entryRef ? { ...slot, entryRef: null } : slot);
  const nextInventory = { entries };
  const validation = validateEquipmentLoadout(nextInventory, { slots });
  if (!validation.ok) return validation;
  return success({ inventory: nextInventory, loadout: validation.value, entryRef, changedSlots });
}

export function collectEquippedModifiers(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
): CoreV1InventoryResult<readonly CoreV1CollectedEquipmentModifier[]> {
  const validLoadout = validateEquipmentLoadout(inventory, loadout);
  if (!validLoadout.ok) return validLoadout;
  const entryRefs = [...new Set(validLoadout.value.slots.flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef]))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const modifiers: CoreV1CollectedEquipmentModifier[] = [];
  entryRefs.forEach((entryRef) => {
    const entry = inventoryInstance(inventory, entryRef);
    const profile = entry === null ? null : equipmentProfile(entry);
    profile?.passiveModifiers?.forEach((modifier) => {
      modifiers.push({
        target: modifier.target,
        source: { type: 'equipment', ref: entryRef },
        value: modifier.amount,
      });
    });
  });
  return success(modifiers);
}

export function aggregateEquippedModifiers(
  inventory: CoreV1InventoryState,
  loadout: CoreV1EquipmentLoadout,
): CoreV1InventoryResult<readonly CoreV1AggregatedEquipmentModifier[]> {
  const collected = collectEquippedModifiers(inventory, loadout);
  if (!collected.ok) return collected;
  const totals = new Map<CoreV1CollectedEquipmentModifier['target'], number>();
  const context: ValidationContext = { issues: [] };
  collected.value.forEach((modifier, index) => {
    try {
      totals.set(modifier.target, safeIntegerAdd(totals.get(modifier.target) ?? 0, modifier.value, `${modifier.target} equipment modifier`));
    } catch {
      addIssue(context, `modifiers.${index}`, 'SAFE_INTEGER', 'Aggregated equipment modifier must remain a safe integer', undefined, modifier.target);
    }
  });
  if (context.issues.length > 0) return failure(context.issues);
  return success([...totals.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([target, value]) => ({ target, value })));
}
