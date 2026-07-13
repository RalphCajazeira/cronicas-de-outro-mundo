import {
  CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
  CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_LEVEL_CAP,
  CORE_V1_MAX_DAMAGE_COMPONENTS,
  CORE_V1_PRIMARY_ATTRIBUTES,
} from './core-v1.config.js';
import {
  CORE_V1_ACTIVATION_TYPES,
  CORE_V1_AREA_SHAPES,
  CORE_V1_CONTENT_ACTION_PROFILES,
  CORE_V1_CONTENT_EFFECTS,
  CORE_V1_CONTENT_KINDS,
  CORE_V1_CONTENT_REACTIONS,
  CORE_V1_CONTENT_RULESET_CODE,
  CORE_V1_CONTENT_SCHEMA_VERSION,
  CORE_V1_ELEMENTS,
  CORE_V1_EQUIPMENT_SLOTS,
  CORE_V1_MAX_CONTENT_EFFECTS,
  CORE_V1_MAX_CONTENT_REFERENCES,
  CORE_V1_MAX_CONTENT_TAGS,
  CORE_V1_MAX_CONTENT_TIER,
  CORE_V1_MAX_DURATION_ACTIONS,
  CORE_V1_MAX_DURATION_TICKS,
  CORE_V1_MAX_PASSIVE_MODIFIERS,
  CORE_V1_MAX_STATUS_STACKS,
  CORE_V1_MAX_TARGETS,
  CORE_V1_MODIFIER_SOURCE_RULES,
  CORE_V1_PASSIVE_MODIFIER_TARGETS,
  CORE_V1_RARITIES,
  CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS,
  CORE_V1_SECONDARY_MODIFIER_CODES,
  CORE_V1_TARGETING_TYPES,
  CORE_V1_TRIGGERS,
} from './core-v1.content-mechanics.config.js';
import type {
  CoreV1ActionProfile,
  CoreV1ContentKind,
  CoreV1ContentProfile,
  CoreV1ContentReference,
  CoreV1ContentValidationResult,
  CoreV1DefenseDefinition,
  CoreV1Duration,
  CoreV1Element,
  CoreV1Effect,
  CoreV1MechanicalContentProfile,
  CoreV1Rarity,
  CoreV1ReactionKind,
  CoreV1StatusStacking,
  CoreV1Targeting,
} from './core-v1.content-mechanics.types.js';
import {
  validateCost,
  validateTierBaseDamage,
  npcPrimaryAttributeBudget,
} from './core-v1.content.js';
import {
  getReactionDefinition,
  isValidZoneTransition,
  validateMultiTargetAction,
} from './core-v1.action-mechanics.js';
import {
  getRepresentativeTemporalProfile,
  getTemporalProfile,
} from './core-v1.temporal.js';
import {
  isPlainRecord,
  safeIntegerAdd,
} from './core-v1.math.js';
import type { ValidationIssue } from './core-v1.types.js';

const codePattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const rangeBands = new Set(['self', 'engaged', 'near', 'medium', 'far']);
const durationTypes = new Set(['instant', 'ticks', 'actions', 'scene', 'encounter', 'permanent']);
const stackingTypes = new Set(['none', 'refresh', 'stack_intensity', 'stack_duration', 'replace']);
const damageChannels = new Set(['physical', 'magical']);
const damageScalings = new Set(['none', 'half', 'full']);
const creatureRoles = new Set(['minion', 'standard', 'elite', 'boss']);
const narrativeKinds = new Set<CoreV1ContentKind>(['clothing', 'item', 'class']);
const defensiveModifierTargets = new Set([
  'physicalDefense', 'magicalDefense', 'physicalResistanceBps', 'magicalResistanceBps',
  'elementalResistanceBps', 'maxHp',
]);

interface ValidationContext {
  readonly issues: ValidationIssue[];
}

interface DamageBudget {
  componentCount: number;
  totalBaseDamage: number;
  readonly componentIds: Set<string>;
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

function invalid(context: ValidationContext): CoreV1ContentValidationResult {
  return {
    ok: false,
    code: 'INVALID_CORE_V1_CONTENT_PROFILE',
    retryable: true,
    issues: context.issues,
  };
}

function ownPropertyNames(value: object): readonly string[] {
  return Object.getOwnPropertyNames(value).filter((key) => key !== 'length').sort();
}

function record(
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

function requireField(context: ValidationContext, value: Record<string, unknown>, path: string, field: string): void {
  if (!Object.hasOwn(value, field)) {
    addIssue(context, path === '$' ? field : `${path}.${field}`, 'REQUIRED', 'Field is required');
  }
}

function denseArray(
  context: ValidationContext,
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    addIssue(context, path, 'ARRAY', 'Must be an array');
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
    if (!Object.hasOwn(value, index)) {
      addIssue(context, `${path}.${index}`, 'SPARSE_ARRAY', 'Sparse arrays are not supported');
    }
  }
  if (value.length < minimum || value.length > maximum) {
    addIssue(context, path, 'ARRAY_LENGTH', `Array length must be between ${minimum} and ${maximum}`, { minimum, maximum }, value.length);
  }
  return Array.from(value, (item: unknown) => item);
}

function enumValue(
  context: ValidationContext,
  value: unknown,
  path: string,
  values: readonly string[],
): value is string {
  if (typeof value !== 'string' || !values.includes(value)) {
    addIssue(context, path, 'ENUM', 'Must use an allowlisted value', values, value);
    return false;
  }
  return true;
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

function nonZeroInteger(context: ValidationContext, value: unknown, path: string): value is number {
  if (!safeInteger(context, value, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)) return false;
  if (value === 0) {
    addIssue(context, path, 'NON_ZERO', 'Must not be zero');
    return false;
  }
  return true;
}

function code(context: ValidationContext, value: unknown, path: string): value is string {
  if (typeof value !== 'string' || value.length > 100 || !codePattern.test(value) || uuidPattern.test(value)) {
    addIssue(context, path, 'CODE', 'Must be a public lowercase stable code, not a UUID', 'lowercase letters, numbers, hyphens or underscores', value);
    return false;
  }
  return true;
}

function text(context: ValidationContext, value: unknown, path: string, maximum: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    addIssue(context, path, 'TEXT', `Must be non-empty text with at most ${maximum} characters`, { maximum }, value);
    return false;
  }
  return true;
}

function optionalText(context: ValidationContext, value: unknown, path: string, maximum: number): void {
  if (value !== undefined) text(context, value, path, maximum);
}

function stringArray(
  context: ValidationContext,
  value: unknown,
  path: string,
  minimum = 0,
  maximum = CORE_V1_MAX_CONTENT_TAGS,
): readonly string[] | null {
  const values = denseArray(context, value, path, minimum, maximum);
  if (values === null) return null;
  const seen = new Set<string>();
  values.forEach((item, index) => {
    if (typeof item !== 'string' || item.length > 100 || !codePattern.test(item)) {
      addIssue(context, `${path}.${index}`, 'TAG_CODE', 'Must be a lowercase stable tag code', undefined, item);
    } else if (seen.has(item)) {
      addIssue(context, `${path}.${index}`, 'DUPLICATE', 'Duplicate values are not supported', undefined, item);
    } else {
      seen.add(item);
    }
  });
  return values.filter((item): item is string => typeof item === 'string');
}

function validatePresentation(context: ValidationContext, value: unknown, path: string): void {
  const input = record(context, value, path, ['summary', 'appearance', 'sensory']);
  if (input === null) return;
  optionalText(context, input.summary, `${path}.summary`, 1_000);
  optionalText(context, input.appearance, `${path}.appearance`, 2_000);
  optionalText(context, input.sensory, `${path}.sensory`, 1_000);
}

function validateActivation(context: ValidationContext, value: unknown, path: string): string | null {
  const input = record(context, value, path, ['type', 'trigger', 'reactionKind']);
  if (input === null) return null;
  requireField(context, input, path, 'type');
  if (!enumValue(context, input.type, `${path}.type`, CORE_V1_ACTIVATION_TYPES)) return null;
  if (input.type === 'passive' || input.type === 'active') {
    record(context, value, path, ['type']);
  } else if (input.type === 'triggered') {
    record(context, value, path, ['type', 'trigger']);
    requireField(context, input, path, 'trigger');
    enumValue(context, input.trigger, `${path}.trigger`, CORE_V1_TRIGGERS);
  } else {
    record(context, value, path, ['type', 'reactionKind']);
    requireField(context, input, path, 'reactionKind');
    enumValue(context, input.reactionKind, `${path}.reactionKind`, CORE_V1_CONTENT_REACTIONS);
  }
  return input.type;
}

function reactionRuntimeKind(kind: CoreV1ReactionKind): 'block' | 'active_dodge' | 'interrupt' | 'counter_attack' {
  return kind === 'dodge' ? 'active_dodge' : kind;
}

function validateActionProfile(context: ValidationContext, value: unknown, path: string): value is CoreV1ActionProfile {
  if (!enumValue(context, value, path, CORE_V1_CONTENT_ACTION_PROFILES)) return false;
  try {
    if (CORE_V1_CONTENT_REACTIONS.includes(value as CoreV1ReactionKind)) {
      getReactionDefinition(reactionRuntimeKind(value as CoreV1ReactionKind));
    } else if (['quick', 'normal', 'heavy', 'very_heavy'].includes(value)) {
      getTemporalProfile(value as Parameters<typeof getTemporalProfile>[0]);
    } else {
      getRepresentativeTemporalProfile(value as Parameters<typeof getRepresentativeTemporalProfile>[0]);
    }
    return true;
  } catch {
    addIssue(context, path, 'ACTION_PROFILE', 'Action profile is not supported by core-v1', CORE_V1_CONTENT_ACTION_PROFILES, value);
    return false;
  }
}

function validateTargetMultipliers(
  context: ValidationContext,
  value: unknown,
  path: string,
  maxTargets: number | null,
): readonly number[] | null {
  const values = denseArray(context, value, path, 1, CORE_V1_MAX_TARGETS);
  if (values === null) return null;
  let total = 0;
  values.forEach((item, index) => {
    if (safeInteger(context, item, `${path}.${index}`, 1, CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS)) {
      try {
        total = safeIntegerAdd(total, item, 'target damage multiplier total');
      } catch {
        addIssue(context, path, 'SAFE_INTEGER', 'Target damage multiplier total must remain a safe integer');
      }
    }
  });
  if (total > CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS) {
    addIssue(context, path, 'AREA_TOTAL_CAP', 'Target damage multipliers must total at most 150%', CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS, total);
  }
  if (maxTargets !== null && values.length !== maxTargets) {
    addIssue(context, path, 'TARGET_MULTIPLIER_COUNT', 'Must declare one multiplier for every possible target', maxTargets, values.length);
  }
  return values.filter((item): item is number => typeof item === 'number');
}

function validateTargeting(context: ValidationContext, value: unknown, path: string): CoreV1Targeting | null {
  const allFields = [
    'type', 'rangeBand', 'maxTargets', 'areaShape', 'chainCount', 'chainInterval',
    'targetFalloffBps', 'damageMultiplierPerTargetBps',
  ];
  const input = record(context, value, path, allFields);
  if (input === null) return null;
  requireField(context, input, path, 'type');
  requireField(context, input, path, 'rangeBand');
  if (!enumValue(context, input.type, `${path}.type`, CORE_V1_TARGETING_TYPES)) return null;
  enumValue(context, input.rangeBand, `${path}.rangeBand`, [...rangeBands]);

  const simple = input.type === 'self' || input.type === 'single_target' || input.type === 'weapon_attack';
  if (simple) {
    record(context, value, path, input.type === 'single_target' ? ['type', 'rangeBand', 'maxTargets'] : ['type', 'rangeBand']);
    if (input.type === 'self' && input.rangeBand !== 'self') {
      addIssue(context, `${path}.rangeBand`, 'SELF_RANGE', 'Self targeting requires the self range band', 'self', input.rangeBand);
    }
    if (input.type !== 'self' && input.rangeBand === 'self') {
      addIssue(context, `${path}.rangeBand`, 'TARGET_RANGE', 'Non-self targeting cannot use the self range band');
    }
    if (input.maxTargets !== undefined && safeInteger(context, input.maxTargets, `${path}.maxTargets`, 1, 1) && input.maxTargets > 1) {
      addIssue(context, `${path}.maxTargets`, 'SINGLE_TARGET_LIMIT', 'Single target cannot target more than one actor');
    }
    return input as unknown as CoreV1Targeting;
  }

  const allowedByType: Record<string, readonly string[]> = {
    multi_target: ['type', 'rangeBand', 'maxTargets', 'damageMultiplierPerTargetBps'],
    area: ['type', 'rangeBand', 'maxTargets', 'areaShape', 'damageMultiplierPerTargetBps'],
    chain: ['type', 'rangeBand', 'maxTargets', 'chainCount', 'chainInterval', 'targetFalloffBps', 'damageMultiplierPerTargetBps'],
    cleave: ['type', 'rangeBand', 'maxTargets', 'damageMultiplierPerTargetBps'],
  };
  record(context, value, path, allowedByType[input.type] ?? allFields);
  requireField(context, input, path, 'maxTargets');
  requireField(context, input, path, 'damageMultiplierPerTargetBps');
  const validMaxTargets = safeInteger(context, input.maxTargets, `${path}.maxTargets`, 2, CORE_V1_MAX_TARGETS)
    ? input.maxTargets
    : null;
  const multipliers = validateTargetMultipliers(
    context,
    input.damageMultiplierPerTargetBps,
    `${path}.damageMultiplierPerTargetBps`,
    validMaxTargets,
  );
  let chainCount = 0;
  let chainInterval = 0;
  let targetFalloffBps = 0;
  if (input.type === 'area') {
    requireField(context, input, path, 'areaShape');
    enumValue(context, input.areaShape, `${path}.areaShape`, CORE_V1_AREA_SHAPES);
  }
  if (input.type === 'chain') {
    for (const field of ['chainCount', 'chainInterval', 'targetFalloffBps']) requireField(context, input, path, field);
    if (safeInteger(context, input.chainCount, `${path}.chainCount`, 1, validMaxTargets ?? CORE_V1_MAX_TARGETS)) chainCount = input.chainCount;
    if (safeInteger(context, input.chainInterval, `${path}.chainInterval`, 50, CORE_V1_MAX_DURATION_TICKS)) chainInterval = input.chainInterval;
    if (safeInteger(context, input.targetFalloffBps, `${path}.targetFalloffBps`, 0, 10000)) targetFalloffBps = input.targetFalloffBps;
  }
  if (validMaxTargets !== null && multipliers !== null) {
    try {
      validateMultiTargetAction({
        actionKind: input.type as 'multi_target' | 'area' | 'chain' | 'cleave',
        maxTargets: validMaxTargets,
        chainCount,
        chainInterval: BigInt(chainInterval),
        targetFalloffBps,
        damageMultiplierPerTargetBps: multipliers,
        comboSteps: [],
        stopOnMiss: false,
        maxComboEvents: 0,
      });
    } catch (error) {
      addIssue(context, path, 'RC1_TARGETING', 'Targeting does not satisfy RC1.1 limits', undefined, error instanceof Error ? error.message : undefined);
    }
  }
  return input as unknown as CoreV1Targeting;
}

function validateDamageComponents(
  context: ValidationContext,
  value: unknown,
  path: string,
  budget: DamageBudget,
): void {
  const components = denseArray(context, value, path, 1, CORE_V1_MAX_DAMAGE_COMPONENTS);
  if (components === null) return;
  components.forEach((component, index) => {
    const componentPath = `${path}.${index}`;
    const input = record(context, component, componentPath, ['id', 'channel', 'element', 'baseDamage', 'scaling', 'canCrit']);
    if (input === null) return;
    for (const field of ['id', 'channel', 'element', 'baseDamage', 'scaling', 'canCrit']) requireField(context, input, componentPath, field);
    if (code(context, input.id, `${componentPath}.id`)) {
      if (budget.componentIds.has(input.id)) addIssue(context, `${componentPath}.id`, 'DUPLICATE_DAMAGE_ID', 'Damage component ids must be unique across the content action', undefined, input.id);
      budget.componentIds.add(input.id);
    }
    const validChannel = enumValue(context, input.channel, `${componentPath}.channel`, [...damageChannels]);
    if (validChannel) {
      if (input.channel === 'physical' && input.element !== null) {
        addIssue(context, `${componentPath}.element`, 'PHYSICAL_ELEMENT', 'Physical damage cannot declare an element', null, input.element);
      } else if (input.channel === 'magical' && input.element !== null) {
        enumValue(context, input.element, `${componentPath}.element`, CORE_V1_ELEMENTS);
      }
    }
    if (safeInteger(context, input.baseDamage, `${componentPath}.baseDamage`, 1, Number.MAX_SAFE_INTEGER)) {
      try {
        budget.totalBaseDamage = safeIntegerAdd(budget.totalBaseDamage, input.baseDamage, 'content damage budget');
      } catch {
        addIssue(context, path, 'SAFE_INTEGER', 'Damage budget must remain a safe integer');
      }
    }
    enumValue(context, input.scaling, `${componentPath}.scaling`, [...damageScalings]);
    if (typeof input.canCrit !== 'boolean') addIssue(context, `${componentPath}.canCrit`, 'BOOLEAN', 'Must be boolean', undefined, input.canCrit);
    budget.componentCount += 1;
  });
}

function validateElementList(context: ValidationContext, value: unknown, path: string): readonly string[] | null {
  const elements = denseArray(context, value, path, 1, CORE_V1_ELEMENTS.length);
  if (elements === null) return null;
  const seen = new Set<string>();
  elements.forEach((element, index) => {
    if (enumValue(context, element, `${path}.${index}`, CORE_V1_ELEMENTS)) {
      if (seen.has(element)) addIssue(context, `${path}.${index}`, 'DUPLICATE', 'Duplicate elements are not supported', undefined, element);
      seen.add(element);
    }
  });
  return elements.filter((element): element is string => typeof element === 'string');
}

function validateDefense(
  context: ValidationContext,
  value: unknown,
  path: string,
): { definition: CoreV1DefenseDefinition | null; propertyCount: number; recognized: boolean } {
  const input = record(context, value, path, [
    'physicalFlatDefense', 'magicalFlatDefense', 'physicalResistanceBps', 'magicalResistanceBps',
    'elementalResistanceBps', 'blockValue', 'immunities',
  ]);
  if (input === null) return { definition: null, propertyCount: 0, recognized: false };
  let propertyCount = 0;
  let recognized = false;
  const scalarCaps: Readonly<Record<string, number>> = {
    physicalFlatDefense: 300,
    magicalFlatDefense: 300,
    physicalResistanceBps: 4000,
    magicalResistanceBps: 4000,
    blockValue: 300,
  };
  for (const [field, maximum] of Object.entries(scalarCaps)) {
    const fieldValue = input[field];
    if (fieldValue === undefined) continue;
    if (safeInteger(context, fieldValue, `${path}.${field}`, 0, maximum) && fieldValue > 0) {
      propertyCount += 1;
      recognized = true;
    }
  }
  if (input.elementalResistanceBps !== undefined) {
    const resistances = record(context, input.elementalResistanceBps, `${path}.elementalResistanceBps`, CORE_V1_ELEMENTS);
    if (resistances !== null) {
      let hasResistance = false;
      for (const element of ownPropertyNames(resistances)) {
        if (safeInteger(context, resistances[element], `${path}.elementalResistanceBps.${element}`, 0, 7500)
          && resistances[element] > 0) hasResistance = true;
      }
      if (hasResistance) {
        propertyCount += 1;
        recognized = true;
      }
    }
  }
  if (input.immunities !== undefined) {
    const immunities = record(context, input.immunities, `${path}.immunities`, ['physical', 'magical', 'elements']);
    if (immunities !== null) {
      let hasImmunity = false;
      for (const channel of ['physical', 'magical']) {
        if (immunities[channel] !== undefined && typeof immunities[channel] !== 'boolean') {
          addIssue(context, `${path}.immunities.${channel}`, 'BOOLEAN', 'Must be boolean', undefined, immunities[channel]);
        }
        if (immunities[channel] === true) hasImmunity = true;
      }
      if (immunities.elements !== undefined) {
        const elements = validateElementList(context, immunities.elements, `${path}.immunities.elements`);
        if ((elements?.length ?? 0) > 0) hasImmunity = true;
      }
      if (hasImmunity) {
        propertyCount += 1;
        recognized = true;
      }
    }
  }
  if (!recognized) addIssue(context, path, 'EMPTY_DEFENSE', 'Defense must declare at least one recognized non-zero defense or explicit immunity');
  return { definition: input, propertyCount, recognized };
}

function validateDuration(context: ValidationContext, value: unknown, path: string): CoreV1Duration | null {
  const input = record(context, value, path, ['type', 'value']);
  if (input === null) return null;
  requireField(context, input, path, 'type');
  if (!enumValue(context, input.type, `${path}.type`, [...durationTypes])) return null;
  if (input.type === 'ticks' || input.type === 'actions') {
    record(context, value, path, ['type', 'value']);
    requireField(context, input, path, 'value');
    safeInteger(
      context,
      input.value,
      `${path}.value`,
      1,
      input.type === 'ticks' ? CORE_V1_MAX_DURATION_TICKS : CORE_V1_MAX_DURATION_ACTIONS,
    );
  } else {
    record(context, value, path, ['type']);
  }
  return input as unknown as CoreV1Duration;
}

function validateStacking(context: ValidationContext, value: unknown, path: string): CoreV1StatusStacking | null {
  const input = record(context, value, path, ['type', 'maxStacks']);
  if (input === null) return null;
  requireField(context, input, path, 'type');
  if (!enumValue(context, input.type, `${path}.type`, [...stackingTypes])) return null;
  if (input.type === 'stack_intensity' || input.type === 'stack_duration') {
    record(context, value, path, ['type', 'maxStacks']);
    requireField(context, input, path, 'maxStacks');
    safeInteger(context, input.maxStacks, `${path}.maxStacks`, 2, CORE_V1_MAX_STATUS_STACKS);
  } else {
    record(context, value, path, ['type']);
  }
  return input as unknown as CoreV1StatusStacking;
}

function validateContentReference(context: ValidationContext, value: unknown, path: string): CoreV1ContentReference | null {
  const input = record(context, value, path, ['contentKind', 'code']);
  if (input === null) return null;
  requireField(context, input, path, 'contentKind');
  requireField(context, input, path, 'code');
  enumValue(context, input.contentKind, `${path}.contentKind`, CORE_V1_CONTENT_KINDS);
  code(context, input.code, `${path}.code`);
  return input as unknown as CoreV1ContentReference;
}

function validateContentReferences(
  context: ValidationContext,
  value: unknown,
  path: string,
  minimum = 0,
): readonly CoreV1ContentReference[] | null {
  const values = denseArray(context, value, path, minimum, CORE_V1_MAX_CONTENT_REFERENCES);
  if (values === null) return null;
  const refs: CoreV1ContentReference[] = [];
  const seen = new Set<string>();
  values.forEach((item, index) => {
    const ref = validateContentReference(context, item, `${path}.${index}`);
    if (ref === null) return;
    const key = `${ref.contentKind}:${ref.code}`;
    if (seen.has(key)) addIssue(context, `${path}.${index}`, 'DUPLICATE_REFERENCE', 'Content references must be unique', undefined, key);
    seen.add(key);
    refs.push(ref);
  });
  return refs;
}

function validateRequirements(context: ValidationContext, value: unknown, path: string): boolean {
  const input = record(context, value, path, [
    'minimumLevel', 'minimumPrimaryAttributes', 'requiredContent', 'requiredWeaponTags',
    'requiredEquipmentTags', 'requiredRuleset',
  ]);
  if (input === null) return false;
  let recognized = false;
  if (input.minimumLevel !== undefined) {
    recognized = true;
    safeInteger(context, input.minimumLevel, `${path}.minimumLevel`, 1, CORE_V1_LEVEL_CAP);
  }
  if (input.minimumPrimaryAttributes !== undefined) {
    recognized = true;
    const attributes = record(context, input.minimumPrimaryAttributes, `${path}.minimumPrimaryAttributes`, CORE_V1_PRIMARY_ATTRIBUTES);
    if (attributes !== null) {
      for (const attribute of ownPropertyNames(attributes)) {
        safeInteger(context, attributes[attribute], `${path}.minimumPrimaryAttributes.${attribute}`, 1, CORE_V1_ATTRIBUTE_HARD_CAP);
      }
    }
  }
  if (input.requiredContent !== undefined) {
    recognized = true;
    validateContentReferences(context, input.requiredContent, `${path}.requiredContent`);
  }
  if (input.requiredWeaponTags !== undefined) {
    recognized = true;
    stringArray(context, input.requiredWeaponTags, `${path}.requiredWeaponTags`, 1);
  }
  if (input.requiredEquipmentTags !== undefined) {
    recognized = true;
    stringArray(context, input.requiredEquipmentTags, `${path}.requiredEquipmentTags`, 1);
  }
  if (input.requiredRuleset !== undefined) {
    recognized = true;
    if (input.requiredRuleset !== CORE_V1_CONTENT_RULESET_CODE) {
      addIssue(context, `${path}.requiredRuleset`, 'RULESET_REFERENCE', 'Required ruleset must be core-v1', CORE_V1_CONTENT_RULESET_CODE, input.requiredRuleset);
    }
  }
  if (!recognized) addIssue(context, path, 'EMPTY_REQUIREMENTS', 'Requirements must declare at least one recognized requirement');
  return recognized;
}

function validatePassiveModifiers(context: ValidationContext, value: unknown, path: string): number {
  const modifiers = denseArray(context, value, path, 1, CORE_V1_MAX_PASSIVE_MODIFIERS);
  if (modifiers === null) return 0;
  modifiers.forEach((modifier, index) => {
    const modifierPath = `${path}.${index}`;
    const input = record(context, modifier, modifierPath, ['target', 'amount', 'sourceRule']);
    if (input === null) return;
    for (const field of ['target', 'amount', 'sourceRule']) requireField(context, input, modifierPath, field);
    enumValue(context, input.target, `${modifierPath}.target`, CORE_V1_PASSIVE_MODIFIER_TARGETS);
    nonZeroInteger(context, input.amount, `${modifierPath}.amount`);
    enumValue(context, input.sourceRule, `${modifierPath}.sourceRule`, CORE_V1_MODIFIER_SOURCE_RULES);
  });
  return modifiers.length;
}

function validateEffect(
  context: ValidationContext,
  value: unknown,
  path: string,
  budget: DamageBudget,
): CoreV1Effect | null {
  const input = record(context, value, path, [
    'type', 'damageComponents', 'targeting', 'resource', 'amount', 'attributeCode', 'duration',
    'secondaryCode', 'statusRef', 'stacking', 'reactionKind', 'reactionDepth', 'from', 'to',
    'maximumTransitions',
  ]);
  if (input === null) return null;
  requireField(context, input, path, 'type');
  if (!enumValue(context, input.type, `${path}.type`, CORE_V1_CONTENT_EFFECTS)) return null;
  if (input.type === 'damage' || input.type === 'add_damage') {
    record(context, value, path, ['type', 'damageComponents', 'targeting']);
    requireField(context, input, path, 'damageComponents');
    requireField(context, input, path, 'targeting');
    validateDamageComponents(context, input.damageComponents, `${path}.damageComponents`, budget);
    const targeting = validateTargeting(context, input.targeting, `${path}.targeting`);
    if (input.type === 'add_damage' && targeting?.type !== 'weapon_attack') {
      addIssue(context, `${path}.targeting.type`, 'ADD_DAMAGE_TARGETING', 'add_damage requires weapon_attack targeting', 'weapon_attack', targeting?.type);
    } else if (input.type === 'damage' && targeting?.type === 'weapon_attack') {
      addIssue(context, `${path}.targeting.type`, 'WEAPON_ATTACK_EFFECT', 'weapon_attack targeting is reserved for add_damage effects', 'non-weapon_attack targeting', targeting.type);
    }
  } else if (input.type === 'restore_resource') {
    record(context, value, path, ['type', 'resource', 'amount', 'targeting']);
    for (const field of ['resource', 'amount', 'targeting']) requireField(context, input, path, field);
    enumValue(context, input.resource, `${path}.resource`, ['hp', 'mana', 'sp']);
    safeInteger(context, input.amount, `${path}.amount`, 1, Number.MAX_SAFE_INTEGER);
    validateTargeting(context, input.targeting, `${path}.targeting`);
  } else if (input.type === 'modify_primary_attribute') {
    record(context, value, path, ['type', 'attributeCode', 'amount', 'duration']);
    for (const field of ['attributeCode', 'amount', 'duration']) requireField(context, input, path, field);
    enumValue(context, input.attributeCode, `${path}.attributeCode`, CORE_V1_PRIMARY_ATTRIBUTES);
    nonZeroInteger(context, input.amount, `${path}.amount`);
    const duration = validateDuration(context, input.duration, `${path}.duration`);
    if (duration?.type === 'permanent') addIssue(context, `${path}.duration.type`, 'PERMANENT_BASE_CHANGE', 'Attribute effects cannot permanently change the base attribute');
  } else if (input.type === 'modify_secondary_attribute') {
    record(context, value, path, ['type', 'secondaryCode', 'amount', 'duration']);
    for (const field of ['secondaryCode', 'amount', 'duration']) requireField(context, input, path, field);
    enumValue(context, input.secondaryCode, `${path}.secondaryCode`, CORE_V1_SECONDARY_MODIFIER_CODES);
    nonZeroInteger(context, input.amount, `${path}.amount`);
    const duration = validateDuration(context, input.duration, `${path}.duration`);
    if (duration?.type === 'permanent') addIssue(context, `${path}.duration.type`, 'PERMANENT_BASE_CHANGE', 'Secondary effects cannot permanently change the base value');
  } else if (input.type === 'apply_status') {
    record(context, value, path, ['type', 'statusRef', 'duration', 'stacking']);
    for (const field of ['statusRef', 'duration', 'stacking']) requireField(context, input, path, field);
    code(context, input.statusRef, `${path}.statusRef`);
    const duration = validateDuration(context, input.duration, `${path}.duration`);
    const stacking = validateStacking(context, input.stacking, `${path}.stacking`);
    validatePermanentStacking(context, duration, stacking, `${path}.stacking`);
  } else if (input.type === 'remove_status') {
    record(context, value, path, ['type', 'statusRef']);
    requireField(context, input, path, 'statusRef');
    code(context, input.statusRef, `${path}.statusRef`);
  } else if (input.type === 'grant_reaction') {
    record(context, value, path, ['type', 'reactionKind', 'reactionDepth']);
    requireField(context, input, path, 'reactionKind');
    requireField(context, input, path, 'reactionDepth');
    if (enumValue(context, input.reactionKind, `${path}.reactionKind`, CORE_V1_CONTENT_REACTIONS)) {
      getReactionDefinition(reactionRuntimeKind(input.reactionKind as CoreV1ReactionKind));
      const expectedDepth = input.reactionKind === 'counter_attack' ? 2 : 1;
      if (safeInteger(context, input.reactionDepth, `${path}.reactionDepth`, 1, 2) && input.reactionDepth !== expectedDepth) {
        addIssue(context, `${path}.reactionDepth`, 'REACTION_DEPTH', 'Reaction depth must match the RC1.1 reaction chain', expectedDepth, input.reactionDepth);
      }
    }
  } else {
    record(context, value, path, ['type', 'from', 'to', 'maximumTransitions']);
    for (const field of ['from', 'to', 'maximumTransitions']) requireField(context, input, path, field);
    const zones = ['engaged', 'near', 'medium', 'far', 'out_of_range'];
    const validFrom = enumValue(context, input.from, `${path}.from`, zones);
    const validTo = enumValue(context, input.to, `${path}.to`, zones);
    const maximumTransitions = safeInteger(context, input.maximumTransitions, `${path}.maximumTransitions`, 1, 2)
      ? input.maximumTransitions
      : null;
    if (validFrom && validTo && maximumTransitions !== null
      && !isValidZoneTransition(input.from as Parameters<typeof isValidZoneTransition>[0], input.to as Parameters<typeof isValidZoneTransition>[1], maximumTransitions)) {
      addIssue(context, path, 'ZONE_TRANSITION', 'Movement must be a valid RC1.1 zone transition');
    }
  }
  return input as unknown as CoreV1Effect;
}

function validateEffects(context: ValidationContext, value: unknown, path: string, budget: DamageBudget): number {
  const effects = denseArray(context, value, path, 1, CORE_V1_MAX_CONTENT_EFFECTS);
  if (effects === null) return 0;
  effects.forEach((effect, index) => validateEffect(context, effect, `${path}.${index}`, budget));
  return effects.length;
}

function validatePermanentStacking(
  context: ValidationContext,
  duration: CoreV1Duration | null,
  stacking: CoreV1StatusStacking | null,
  path: string,
): void {
  if (duration?.type === 'permanent' && stacking !== null && !['none', 'replace'].includes(stacking.type)) {
    addIssue(context, path, 'PERMANENT_STACKING', 'Permanent status normally requires none or replace stacking', ['none', 'replace'], stacking.type);
  }
}

function validateCreatureTemplate(context: ValidationContext, value: unknown, path: string, tier: number): boolean {
  const input = record(context, value, path, ['role', 'primaryAttributeBudget', 'contentRefs', 'tags', 'limits']);
  if (input === null) return false;
  for (const field of ['role', 'primaryAttributeBudget', 'contentRefs', 'tags', 'limits']) requireField(context, input, path, field);
  let expectedBudget: number | null = null;
  if (enumValue(context, input.role, `${path}.role`, [...creatureRoles])) {
    expectedBudget = npcPrimaryAttributeBudget(input.role as Parameters<typeof npcPrimaryAttributeBudget>[0], tier);
  }
  if (safeInteger(context, input.primaryAttributeBudget, `${path}.primaryAttributeBudget`, 1, Number.MAX_SAFE_INTEGER)
    && expectedBudget !== null && input.primaryAttributeBudget !== expectedBudget) {
    addIssue(context, `${path}.primaryAttributeBudget`, 'NPC_ATTRIBUTE_BUDGET', 'Creature template must use the RC1 tier/role attribute budget', expectedBudget, input.primaryAttributeBudget);
  }
  const refs = validateContentReferences(context, input.contentRefs, `${path}.contentRefs`, 1);
  stringArray(context, input.tags, `${path}.tags`, 1);
  const limits = record(context, input.limits, `${path}.limits`, ['maxContentRefs', 'maxActiveAbilities']);
  if (limits !== null) {
    requireField(context, limits, `${path}.limits`, 'maxContentRefs');
    requireField(context, limits, `${path}.limits`, 'maxActiveAbilities');
    const maxRefs = safeInteger(context, limits.maxContentRefs, `${path}.limits.maxContentRefs`, 0, CORE_V1_MAX_CONTENT_REFERENCES)
      ? limits.maxContentRefs
      : null;
    const maxActive = safeInteger(context, limits.maxActiveAbilities, `${path}.limits.maxActiveAbilities`, 0, CORE_V1_MAX_CONTENT_REFERENCES)
      ? limits.maxActiveAbilities
      : null;
    if (maxRefs !== null && (refs?.length ?? 0) > maxRefs) {
      addIssue(context, `${path}.contentRefs`, 'CREATURE_CONTENT_LIMIT', 'Creature content references exceed the declared template limit', maxRefs, refs?.length);
    }
    if (maxRefs !== null && maxActive !== null && maxActive > maxRefs) {
      addIssue(context, `${path}.limits.maxActiveAbilities`, 'CREATURE_ACTIVE_LIMIT', 'Active ability limit cannot exceed the content reference limit', maxRefs, maxActive);
    }
  }
  return true;
}

function validateCostDefinition(
  context: ValidationContext,
  tier: number,
  value: unknown,
  path: string,
): string | null {
  const result = validateCost(tier, value);
  if (!result.ok) {
    for (const issue of result.issues) {
      addIssue(
        context,
        issue.path === '$' ? path : `${path}.${issue.path}`,
        issue.rule,
        issue.message,
        issue.expected,
        issue.received,
      );
    }
    return null;
  }
  return result.value.type;
}

function validateIdentity(context: ValidationContext, input: Record<string, unknown>): CoreV1ContentKind | null {
  for (const field of ['schemaVersion', 'rulesetCode', 'profileMode', 'contentKind', 'code', 'name']) {
    requireField(context, input, '$', field);
  }
  if (input.schemaVersion !== CORE_V1_CONTENT_SCHEMA_VERSION) {
    addIssue(context, 'schemaVersion', 'SCHEMA_VERSION', 'Content schema version must be 1', CORE_V1_CONTENT_SCHEMA_VERSION, input.schemaVersion);
  }
  if (input.rulesetCode !== CORE_V1_CONTENT_RULESET_CODE) {
    addIssue(context, 'rulesetCode', 'RULESET_CODE', 'Content ruleset must be core-v1', CORE_V1_CONTENT_RULESET_CODE, input.rulesetCode);
  }
  enumValue(context, input.profileMode, 'profileMode', ['mechanical', 'narrative']);
  const validKind = enumValue(context, input.contentKind, 'contentKind', CORE_V1_CONTENT_KINDS);
  code(context, input.code, 'code');
  text(context, input.name, 'name', 200);
  optionalText(context, input.description, 'description', 10_000);
  optionalText(context, input.lore, 'lore', 10_000);
  if (input.tags !== undefined) stringArray(context, input.tags, 'tags');
  if (input.presentation !== undefined) validatePresentation(context, input.presentation, 'presentation');
  return validKind ? input.contentKind as CoreV1ContentKind : null;
}

const identityFields = [
  'schemaVersion', 'rulesetCode', 'profileMode', 'contentKind', 'code', 'name',
  'description', 'lore', 'tags', 'presentation',
] as const;

const mechanicalFields = [
  ...identityFields,
  'tier', 'rarity', 'activation', 'cost', 'actionProfile', 'targeting', 'damageComponents',
  'defense', 'effects', 'passiveModifiers', 'requirements', 'handedness', 'weaponTags',
  'equipmentSlots', 'consumable', 'duration', 'stacking', 'grants', 'template',
] as const;

function rejectIncompatibleKindFields(
  context: ValidationContext,
  input: Record<string, unknown>,
  kind: CoreV1ContentKind,
): void {
  const kindSpecific = [
    'damageComponents', 'defense', 'handedness', 'weaponTags', 'equipmentSlots', 'consumable',
    'duration', 'stacking', 'grants', 'template',
  ];
  const allowed: Readonly<Record<CoreV1ContentKind, readonly string[]>> = {
    weapon: ['damageComponents', 'defense', 'handedness', 'weaponTags'],
    armor: ['defense', 'equipmentSlots'],
    shield: ['defense', 'equipmentSlots'],
    clothing: [],
    spell: [],
    skill: [],
    talent: [],
    item: ['defense'],
    consumable: ['consumable'],
    status_effect: ['duration', 'stacking'],
    race: ['grants'],
    class: ['grants'],
    creature_template: ['template'],
  };
  for (const field of kindSpecific) {
    if (input[field] !== undefined && !allowed[kind].includes(field)) {
      addIssue(context, field, 'CONTENT_KIND_FIELD', `Field is not compatible with content kind ${kind}`, allowed[kind], field);
    }
  }
}

function validateKindRules(
  context: ValidationContext,
  input: Record<string, unknown>,
  kind: CoreV1ContentKind,
  activationType: string | null,
  costType: string | null,
  rootDamageCount: number,
  defense: { propertyCount: number; recognized: boolean },
  effectCount: number,
  modifierCount: number,
  grantCount: number,
  requirementsRecognized: boolean,
  templateRecognized: boolean,
): number {
  rejectIncompatibleKindFields(context, input, kind);
  const reactionCapability = activationType === 'reaction' ? 1 : 0;
  const requirementsCapability = ['race', 'class'].includes(kind) && requirementsRecognized ? 1 : 0;
  const capabilityCount = (rootDamageCount > 0 ? 1 : 0)
    + defense.propertyCount
    + effectCount
    + modifierCount
    + grantCount
    + reactionCapability
    + requirementsCapability
    + (templateRecognized ? 1 : 0);
  if (capabilityCount === 0) {
    addIssue(context, '$', 'EMPTY_MECHANICAL_PROFILE', 'Mechanical content must declare at least one recognized capability');
  }

  const requireActionProfile = () => {
    if (input.actionProfile === undefined) addIssue(context, 'actionProfile', 'REQUIRED_ACTION_PROFILE', 'Active content requires an allowlisted action profile');
  };
  const requireEffects = () => {
    if (effectCount === 0) addIssue(context, 'effects', 'REQUIRED_EFFECT', `${kind} requires at least one effect`);
  };
  const requirePassive = () => {
    if (activationType !== 'passive') addIssue(context, 'activation.type', 'PASSIVE_CONTENT', `${kind} must use passive activation`, 'passive', activationType);
    if (costType !== 'none') addIssue(context, 'cost.type', 'PASSIVE_COST', `${kind} cannot have an activation cost`, 'none', costType);
  };

  if (kind === 'weapon') {
    if (rootDamageCount === 0) addIssue(context, 'damageComponents', 'WEAPON_DAMAGE', 'Mechanical weapon requires at least one base damage component');
    requireActionProfile();
    if (input.handedness === undefined) addIssue(context, 'handedness', 'REQUIRED', 'Weapon handedness is required');
    else enumValue(context, input.handedness, 'handedness', ['one_handed', 'two_handed', 'versatile']);
    if (input.weaponTags === undefined) addIssue(context, 'weaponTags', 'REQUIRED', 'Weapon family tags are required');
    else stringArray(context, input.weaponTags, 'weaponTags', 1);
    if (input.targeting === undefined) addIssue(context, 'targeting', 'REQUIRED', 'Weapon basic targeting is required');
    else if (isPlainRecord(input.targeting) && input.targeting.type !== 'single_target') {
      addIssue(context, 'targeting.type', 'WEAPON_TARGETING', 'Base weapon targeting must be single_target', 'single_target', input.targeting.type);
    }
  } else if (kind === 'armor') {
    requirePassive();
    const defensiveModifiers = countDefensiveModifiers(input.passiveModifiers);
    if (!defense.recognized && defensiveModifiers === 0) addIssue(context, 'defense', 'ARMOR_DEFENSE', 'Armor requires defense or a recognized defensive passive modifier');
    if (input.equipmentSlots === undefined) addIssue(context, 'equipmentSlots', 'REQUIRED', 'Armor conceptual slots are required');
    else if (Array.isArray(input.equipmentSlots)) {
      const armorSlots = new Set(['head', 'chest', 'hands', 'legs', 'feet', 'body']);
      input.equipmentSlots.forEach((slot, index) => {
        if (typeof slot === 'string' && !armorSlots.has(slot)) {
          addIssue(context, `equipmentSlots.${index}`, 'ARMOR_SLOT', 'Armor must use a compatible body slot', [...armorSlots], slot);
        }
      });
    }
  } else if (kind === 'shield') {
    requirePassive();
    if (!defense.recognized) addIssue(context, 'defense', 'SHIELD_DEFENSE', 'Shield requires defense or blockValue');
    if (!Array.isArray(input.equipmentSlots) || !input.equipmentSlots.includes('off_hand')) {
      addIssue(context, 'equipmentSlots', 'SHIELD_OFF_HAND', 'Shield must declare off_hand compatibility', ['off_hand'], input.equipmentSlots);
    }
  } else if (kind === 'clothing') {
    requirePassive();
    if (modifierCount + effectCount === 0) addIssue(context, '$', 'CLOTHING_MECHANICS', 'Mechanical clothing requires a recognized modifier or effect');
  } else if (kind === 'spell') {
    if (activationType === 'active') {
      requireActionProfile();
      requireEffects();
    }
  } else if (kind === 'skill') {
    if (activationType === 'active') {
      requireActionProfile();
      requireEffects();
    }
  } else if (kind === 'talent') {
    if (!['passive', 'triggered', 'active'].includes(activationType ?? '')) {
      addIssue(context, 'activation.type', 'TALENT_ACTIVATION', 'Talent activation must be passive, triggered or explicitly active');
    }
    if (activationType === 'active') requireEffects();
  } else if (kind === 'consumable') {
    if (activationType !== 'active') addIssue(context, 'activation.type', 'CONSUMABLE_ACTIVATION', 'Consumable must use active activation', 'active', activationType);
    if (input.consumable !== true) addIssue(context, 'consumable', 'CONSUMABLE_FLAG', 'Consumable profile must declare consumable: true', true, input.consumable);
    requireActionProfile();
    requireEffects();
  } else if (kind === 'status_effect') {
    requirePassive();
    if (input.duration === undefined) addIssue(context, 'duration', 'REQUIRED', 'Status effect duration is required');
    if (input.stacking === undefined) addIssue(context, 'stacking', 'REQUIRED', 'Status effect stacking is required');
    if (effectCount + modifierCount === 0) addIssue(context, '$', 'STATUS_CAPABILITY', 'Status effect requires at least one effect or modifier');
  } else if (kind === 'race') {
    requirePassive();
    if (modifierCount + grantCount + requirementsCapability === 0) addIssue(context, '$', 'RACE_MECHANICS', 'Mechanical race requires modifiers, grants or requirements');
  } else if (kind === 'class') {
    requirePassive();
    if (modifierCount + grantCount === 0) addIssue(context, '$', 'CLASS_MECHANICS', 'Mechanical class requires typed modifiers or content grants');
  } else if (kind === 'creature_template') {
    requirePassive();
    if (!templateRecognized) addIssue(context, 'template', 'CREATURE_TEMPLATE', 'Creature template blueprint is required');
  }
  return capabilityCount;
}

function countDefensiveModifiers(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((modifier) => isPlainRecord(modifier) && typeof modifier.target === 'string'
    && defensiveModifierTargets.has(modifier.target)).length;
}

function validateEquipmentSlots(context: ValidationContext, value: unknown, path: string): void {
  const slots = denseArray(context, value, path, 1, CORE_V1_EQUIPMENT_SLOTS.length);
  if (slots === null) return;
  const seen = new Set<string>();
  slots.forEach((slot, index) => {
    if (enumValue(context, slot, `${path}.${index}`, CORE_V1_EQUIPMENT_SLOTS)) {
      if (seen.has(slot)) addIssue(context, `${path}.${index}`, 'DUPLICATE', 'Equipment slots must be unique', undefined, slot);
      seen.add(slot);
    }
  });
}

function validateMechanicalProfile(
  context: ValidationContext,
  input: Record<string, unknown>,
  kind: CoreV1ContentKind,
): void {
  record(context, input, '$', mechanicalFields);
  for (const field of ['tier', 'rarity', 'activation', 'cost']) requireField(context, input, '$', field);
  const tier = safeInteger(context, input.tier, 'tier', 1, CORE_V1_MAX_CONTENT_TIER) ? input.tier : null;
  const rarity = enumValue(context, input.rarity, 'rarity', CORE_V1_RARITIES)
    ? input.rarity as CoreV1Rarity
    : null;
  const activationType = validateActivation(context, input.activation, 'activation');
  const costType = tier === null ? null : validateCostDefinition(context, tier, input.cost, 'cost');
  if (activationType === 'passive' && costType !== null && costType !== 'none') {
    addIssue(context, 'cost.type', 'PASSIVE_COST', 'Passive content must use the explicit none cost', 'none', costType);
  }
  if (activationType === 'passive' && input.actionProfile !== undefined) {
    addIssue(context, 'actionProfile', 'PASSIVE_ACTION_PROFILE', 'Passive content cannot declare an active action profile');
  }
  if (activationType === 'active' || activationType === 'reaction'
    || (activationType === 'triggered' && costType !== 'none')) {
    if (input.actionProfile === undefined) addIssue(context, 'actionProfile', 'REQUIRED_ACTION_PROFILE', 'Timed activation requires an action profile');
  }
  if (input.actionProfile !== undefined) {
    const valid = validateActionProfile(context, input.actionProfile, 'actionProfile');
    if (valid && activationType === 'reaction' && isPlainRecord(input.activation)
      && input.actionProfile !== input.activation.reactionKind) {
      addIssue(context, 'actionProfile', 'REACTION_PROFILE', 'Reaction action profile must match its reaction kind', input.activation.reactionKind, input.actionProfile);
    } else if (valid && activationType !== 'reaction'
      && CORE_V1_CONTENT_REACTIONS.includes(input.actionProfile as CoreV1ReactionKind)) {
      addIssue(context, 'actionProfile', 'REACTION_PROFILE', 'Reaction action profiles require reaction activation', 'reaction activation', input.actionProfile);
    }
  }
  if (input.targeting !== undefined) {
    const targeting = validateTargeting(context, input.targeting, 'targeting');
    if (targeting?.type === 'weapon_attack') {
      addIssue(context, 'targeting.type', 'WEAPON_ATTACK_EFFECT', 'weapon_attack targeting is valid only inside add_damage effects');
    }
  }

  const budget: DamageBudget = { componentCount: 0, totalBaseDamage: 0, componentIds: new Set<string>() };
  let rootDamageCount = 0;
  if (input.damageComponents !== undefined) {
    const before = budget.componentCount;
    validateDamageComponents(context, input.damageComponents, 'damageComponents', budget);
    rootDamageCount = budget.componentCount - before;
  }
  const defense = input.defense === undefined
    ? { definition: null, propertyCount: 0, recognized: false }
    : validateDefense(context, input.defense, 'defense');
  const effectCount = input.effects === undefined ? 0 : validateEffects(context, input.effects, 'effects', budget);
  const modifierCount = input.passiveModifiers === undefined ? 0 : validatePassiveModifiers(context, input.passiveModifiers, 'passiveModifiers');
  const requirementsRecognized = input.requirements === undefined ? false : validateRequirements(context, input.requirements, 'requirements');
  const grants = input.grants === undefined ? null : validateContentReferences(context, input.grants, 'grants', 1);
  const grantCount = grants?.length ?? 0;
  if (input.duration !== undefined) validateDuration(context, input.duration, 'duration');
  if (input.stacking !== undefined) {
    const stacking = validateStacking(context, input.stacking, 'stacking');
    const duration = input.duration === undefined ? null : validateDuration({ issues: [] }, input.duration, 'duration');
    validatePermanentStacking(context, duration, stacking, 'stacking');
  }
  if (input.equipmentSlots !== undefined) validateEquipmentSlots(context, input.equipmentSlots, 'equipmentSlots');
  if (input.weaponTags !== undefined && kind !== 'weapon') stringArray(context, input.weaponTags, 'weaponTags', 1);
  if (input.consumable !== undefined && typeof input.consumable !== 'boolean') addIssue(context, 'consumable', 'BOOLEAN', 'Must be boolean', undefined, input.consumable);
  const templateRecognized = input.template !== undefined && tier !== null
    ? validateCreatureTemplate(context, input.template, 'template', tier)
    : false;

  if (budget.componentCount > CORE_V1_MAX_DAMAGE_COMPONENTS) {
    addIssue(context, 'damageComponents', 'MAX_DAMAGE_COMPONENTS', 'A content action can declare at most six damage components', CORE_V1_MAX_DAMAGE_COMPONENTS, budget.componentCount);
  }
  if (tier !== null && budget.componentCount > 0) {
    const damageResult = validateTierBaseDamage(tier, budget.totalBaseDamage);
    if (!damageResult.ok) {
      for (const issue of damageResult.issues) {
        addIssue(context, 'damageBudget', issue.rule, issue.message, issue.expected, issue.received);
      }
    }
  }

  const capabilityCount = validateKindRules(
    context,
    input,
    kind,
    activationType,
    costType,
    rootDamageCount,
    defense,
    effectCount,
    modifierCount,
    grantCount,
    requirementsRecognized,
    templateRecognized,
  );
  if (rarity !== null) {
    const additionalProperties = Math.max(0, capabilityCount - 1);
    const maximum = CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS[rarity];
    if (additionalProperties > maximum) {
      addIssue(context, 'rarity', 'RARITY_PROPERTY_LIMIT', 'Rarity allows fewer additional mechanical properties', { rarity, maximum }, additionalProperties);
    }
  }
}

export function getCoreV1ContentElements(): readonly CoreV1Element[] {
  return [...CORE_V1_ELEMENTS];
}

export function getCoreV1ContentKinds(): readonly CoreV1ContentKind[] {
  return [...CORE_V1_CONTENT_KINDS];
}

export function getCoreV1RarityAdditionalPropertyLimits(): Readonly<Record<CoreV1Rarity, number>> {
  return { ...CORE_V1_RARITY_ADDITIONAL_PROPERTY_LIMITS };
}

export function validateCoreV1ContentProfile(input: unknown): CoreV1ContentValidationResult {
  const context: ValidationContext = { issues: [] };
  const value = record(context, input, '$', mechanicalFields);
  if (value === null) return invalid(context);
  const kind = validateIdentity(context, value);
  if (value.profileMode === 'narrative') {
    record(context, value, '$', identityFields);
    if (kind !== null && !narrativeKinds.has(kind)) {
      addIssue(context, 'contentKind', 'NARRATIVE_CONTENT_KIND', 'Narrative mode is supported only for clothing, item and class content', [...narrativeKinds], kind);
    }
  } else if (value.profileMode === 'mechanical' && kind !== null) {
    validateMechanicalProfile(context, value, kind);
  }
  if (context.issues.length > 0) return invalid(context);
  return { ok: true, value: structuredClone(value) as unknown as CoreV1ContentProfile };
}

export function isCoreV1MechanicalContentProfile(
  profile: CoreV1ContentProfile,
): profile is CoreV1MechanicalContentProfile {
  return profile.profileMode === 'mechanical';
}
