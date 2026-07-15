import {
  CORE_V1_EFFECT_RULES_CODE,
  CORE_V1_EFFECT_RULESET_CODE,
  CORE_V1_EFFECT_SCHEMA_VERSION,
  CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR,
  CORE_V1_MAX_ACTIVE_MODIFIERS_PER_ACTOR,
  CORE_V1_MAX_EFFECTS_PER_SEQUENCE,
  CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS,
  CORE_V1_MAX_RESOLUTION_ACTORS,
  CORE_V1_MAX_RESOLUTION_CHANGES,
  CORE_V1_MAX_ROLL_BPS,
  CORE_V1_MAX_RUNTIME_STATUS_STACKS,
  CORE_V1_MIN_ROLL_BPS,
} from './core-v1.effects.config.js';
import {
  CORE_V1_MAX_DAMAGE_COMPONENTS,
  CORE_V1_PRIMARY_ATTRIBUTES,
} from './core-v1.config.js';
import {
  calculateCriticalProfile,
  calculateHitChanceBps,
} from './core-v1.attributes.js';
import {
  createRawDamageComponent,
  mitigateDamage,
} from './core-v1.damage.js';
import {
  validateCoreV1ContentProfile,
} from './core-v1.content-mechanics.js';
import {
  removeInventoryQuantity,
  validateCoreV1InventoryState,
} from './core-v1.inventory.js';
import {
  assertInteger,
  assertIntegerInRange,
  ceilDiv,
  clamp,
  isPlainRecord,
  roundHalfUp,
  safeIntegerAdd,
  safeIntegerMultiply,
  sumAuthorizedModifiers,
} from './core-v1.math.js';
import { addTicks, assertTick } from './core-v1.ticks.js';
import { isValidZoneTransition } from './core-v1.action-mechanics.js';
import { validateCost } from './core-v1.content.js';
import type {
  CoreV1ApplyStatusInput,
  CoreV1ApplyStatusResult,
  CoreV1ActiveEffectChange,
  CoreV1ActiveEffectInstance,
  CoreV1ActiveEffectLifecycleResult,
  CoreV1ActiveEffectPayload,
  CoreV1ActorEffectContext,
  CoreV1CollectedActiveModifier,
  CoreV1ConceptualEvent,
  CoreV1ConsumableUseInput,
  CoreV1ConsumableUseResult,
  CoreV1CostAmountReport,
  CoreV1CostModifierSet,
  CoreV1CostResolution,
  CoreV1CustomResourceReference,
  CoreV1DamageApplicationInput,
  CoreV1DamageApplicationResult,
  CoreV1EffectContentVersionReference,
  CoreV1EffectResolutionErrorCode,
  CoreV1EffectResolutionResult,
  CoreV1EffectRulesIdentity,
  CoreV1EffectRulesLimits,
  CoreV1EffectSequenceInput,
  CoreV1EffectSequenceResult,
  CoreV1InjectedRolls,
  CoreV1MaintenancePlan,
  CoreV1MovementCommand,
  CoreV1RemoveStatusInput,
  CoreV1ResourceCode,
  CoreV1ResourceDelta,
  CoreV1ResourcePool,
  CoreV1ResourceRestorationResult,
  CoreV1ResourceState,
  CoreV1RuntimeDurationState,
  CoreV1StatusDefinitionBinding,
  CoreV1TargetResolutionContext,
} from './core-v1.effects.types.js';
import type {
  CoreV1Duration,
  CoreV1Effect,
  CoreV1MechanicalContentProfile,
} from './core-v1.content-mechanics.types.js';
import type {
  CoreV1ContentVersionReference,
  CoreV1InventoryState,
} from './core-v1.inventory.types.js';
import type {
  AuthorizedNumericModifier,
  CoreV1Cost,
  DamageComponentDefinition,
  ValidationIssue,
} from './core-v1.types.js';

const stableRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function issue(
  path: string,
  rule: string,
  message: string,
  expected?: unknown,
  received?: unknown,
): ValidationIssue {
  const value: ValidationIssue = { path, rule, message };
  if (expected !== undefined) value.expected = expected;
  if (received !== undefined) value.received = received;
  return value;
}

function failure<T>(
  issues: readonly ValidationIssue[],
  code: CoreV1EffectResolutionErrorCode = 'INVALID_CORE_V1_EFFECT_RESOLUTION',
): CoreV1EffectResolutionResult<T> {
  return { ok: false, code, retryable: true, issues: structuredClone(issues) };
}

function success<T>(value: T): CoreV1EffectResolutionResult<T> {
  return { ok: true, value: structuredClone(value) };
}

function caughtFailure<T>(error: unknown, path = '$'): CoreV1EffectResolutionResult<T> {
  const message = error instanceof RangeError ? 'Mechanical calculation exceeds an approved range'
    : error instanceof TypeError ? 'Mechanical input has an invalid type or shape'
      : 'Mechanical resolution could not be completed';
  return failure([issue(path, 'INVALID_MECHANICAL_INPUT', message)]);
}

function isStableRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160
    && stableRefPattern.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validatePool(value: unknown, path: string): ValidationIssue[] {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['current', 'maximum'])) {
    return [issue(path, 'RESOURCE_POOL_SHAPE', 'Resource pool must contain only current and maximum')];
  }
  const issues: ValidationIssue[] = [];
  if (!Number.isSafeInteger(value.current) || (value.current as number) < 0) {
    issues.push(issue(`${path}.current`, 'SAFE_INTEGER', 'Current resource must be a non-negative safe integer'));
  }
  if (!Number.isSafeInteger(value.maximum) || (value.maximum as number) < 0) {
    issues.push(issue(`${path}.maximum`, 'SAFE_INTEGER', 'Maximum resource must be a non-negative safe integer'));
  }
  if (Number.isSafeInteger(value.current) && Number.isSafeInteger(value.maximum)
    && (value.current as number) > (value.maximum as number)) {
    issues.push(issue(path, 'RESOURCE_RANGE', 'Current resource cannot exceed maximum'));
  }
  return issues;
}

function resourceIssues(value: unknown): ValidationIssue[] {
  if (!isPlainRecord(value)) return [issue('resources', 'PLAIN_OBJECT', 'Resources must be a plain object')];
  const allowed = value.customResources === undefined
    ? ['hp', 'mana', 'sp']
    : ['hp', 'mana', 'sp', 'customResources'];
  const issues: ValidationIssue[] = [];
  if (!hasOnlyKeys(value, allowed)) {
    issues.push(issue('resources', 'RESOURCE_STATE_SHAPE', 'Resource state contains unsupported or missing fields'));
  }
  issues.push(...validatePool(value.hp, 'resources.hp'));
  issues.push(...validatePool(value.mana, 'resources.mana'));
  issues.push(...validatePool(value.sp, 'resources.sp'));
  if (value.customResources !== undefined) {
    if (!Array.isArray(value.customResources)) {
      issues.push(issue('resources.customResources', 'ARRAY', 'Custom resources must be an array'));
    } else {
      const seen = new Set<string>();
      for (let index = 0; index < value.customResources.length; index += 1) {
        if (!Object.hasOwn(value.customResources, index)) {
          issues.push(issue(`resources.customResources.${index}`, 'SPARSE_ARRAY', 'Sparse arrays are not supported'));
          continue;
        }
        const entry: unknown = value.customResources[index];
        const path = `resources.customResources.${index}`;
        if (!isPlainRecord(entry) || !hasOnlyKeys(entry, ['resourceRef', 'pool'])) {
          issues.push(issue(path, 'CUSTOM_RESOURCE_SHAPE', 'Custom resource must contain only resourceRef and pool'));
          continue;
        }
        const ref = entry.resourceRef;
        if (!isPlainRecord(ref) || !hasOnlyKeys(ref, ['type', 'code'])
          || ref.type !== 'custom_resource' || !isStableRef(ref.code)) {
          issues.push(issue(`${path}.resourceRef`, 'CUSTOM_RESOURCE_REF', 'Custom resource reference is invalid'));
        } else if (seen.has(ref.code)) {
          issues.push(issue(`${path}.resourceRef.code`, 'DUPLICATE_CUSTOM_RESOURCE', 'Custom resource references must be unique'));
        } else seen.add(ref.code);
        issues.push(...validatePool(entry.pool, `${path}.pool`));
      }
    }
  }
  return issues;
}

function versionReferenceIssues(value: unknown, path: string): ValidationIssue[] {
  if (!isPlainRecord(value)
    || !hasOnlyKeys(value, ['scope', 'contentType', 'code', 'versionNumber'])) {
    return [issue(path, 'CONTENT_VERSION_REF', 'Content version reference has an invalid shape')];
  }
  const issues: ValidationIssue[] = [];
  if (value.scope !== 'world' && value.scope !== 'campaign') {
    issues.push(issue(`${path}.scope`, 'ENUM', 'Content scope must be world or campaign'));
  }
  if (!isStableRef(value.contentType) || !isStableRef(value.code)) {
    issues.push(issue(path, 'PUBLIC_REF', 'Content type and code must be stable public references'));
  }
  if (!Number.isSafeInteger(value.versionNumber) || (value.versionNumber as number) < 1) {
    issues.push(issue(`${path}.versionNumber`, 'SAFE_INTEGER', 'Content version number must be positive'));
  }
  return issues;
}

function durationStateIssues(value: unknown, path: string): ValidationIssue[] {
  if (!isPlainRecord(value) || typeof value.type !== 'string') {
    return [issue(path, 'RUNTIME_DURATION', 'Runtime duration state is invalid')];
  }
  try {
    if (value.type === 'ticks' && hasOnlyKeys(value, ['type', 'expiresAtTick'])) {
      assertTick(value.expiresAtTick as bigint, `${path}.expiresAtTick`);
      return [];
    }
    if (value.type === 'actions' && hasOnlyKeys(value, ['type', 'remainingActions'])
      && Number.isSafeInteger(value.remainingActions) && (value.remainingActions as number) > 0) return [];
    if ((value.type === 'scene' || value.type === 'encounter' || value.type === 'permanent')
      && hasOnlyKeys(value, ['type', 'scope']) && value.scope === value.type) return [];
  } catch {
    return [issue(path, 'RUNTIME_DURATION', 'Runtime duration state exceeds supported tick bounds')];
  }
  return [issue(path, 'RUNTIME_DURATION', 'Runtime duration state fields are incompatible')];
}

function actorIssues(value: unknown, path: string): ValidationIssue[] {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    'actorRef', 'primaryAttributes', 'resources', 'secondaryAttributes', 'activeEffects', 'stateVersion',
  ])) return [issue(path, 'ACTOR_CONTEXT_SHAPE', 'Actor effect context has an invalid shape')];
  const issues: ValidationIssue[] = [];
  if (!isStableRef(value.actorRef)) issues.push(issue(`${path}.actorRef`, 'PUBLIC_REF', 'Actor reference is invalid'));
  if (!Number.isSafeInteger(value.stateVersion) || (value.stateVersion as number) < 1) {
    issues.push(issue(`${path}.stateVersion`, 'SAFE_INTEGER', 'Actor state version must be positive'));
  }
  if (!isPlainRecord(value.primaryAttributes)
    || !hasOnlyKeys(value.primaryAttributes, CORE_V1_PRIMARY_ATTRIBUTES)) {
    issues.push(issue(`${path}.primaryAttributes`, 'PRIMARY_ATTRIBUTES', 'Actor must contain the exact primary attribute set'));
  } else {
    for (const code of CORE_V1_PRIMARY_ATTRIBUTES) {
      if (!Number.isSafeInteger(value.primaryAttributes[code])) {
        issues.push(issue(`${path}.primaryAttributes.${code}`, 'SAFE_INTEGER', 'Primary attribute must be a safe integer'));
      }
    }
  }
  if (!isPlainRecord(value.secondaryAttributes)
    || Object.values(value.secondaryAttributes).some((entry) => !Number.isSafeInteger(entry))) {
    issues.push(issue(`${path}.secondaryAttributes`, 'SECONDARY_ATTRIBUTES', 'Secondary attributes must contain safe integer values'));
  }
  issues.push(...resourceIssues(value.resources).map((entry) => ({
    ...entry,
    path: `${path}.${entry.path}`,
  })));
  if (!Array.isArray(value.activeEffects)) {
    issues.push(issue(`${path}.activeEffects`, 'ARRAY', 'Active effects must be an array'));
    return issues;
  }
  if (value.activeEffects.length > CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR) {
    issues.push(issue(`${path}.activeEffects`, 'ACTIVE_EFFECT_LIMIT', 'Actor active effect limit is exceeded'));
    return issues;
  }
  const refs = new Set<string>();
  for (let index = 0; index < value.activeEffects.length; index += 1) {
    const effectPath = `${path}.activeEffects.${index}`;
    if (!Object.hasOwn(value.activeEffects, index)) {
      issues.push(issue(effectPath, 'SPARSE_ARRAY', 'Sparse active effect arrays are not supported'));
      continue;
    }
    const entry: unknown = value.activeEffects[index];
    if (!isPlainRecord(entry) || !hasOnlyKeys(entry, [
      'effectRef', 'sourceActorRef', 'targetActorRef', 'sourceContent', 'effectIndex', 'kind',
      'stacks', 'appliedAtTick', 'durationState', 'payload',
    ])) {
      issues.push(issue(effectPath, 'ACTIVE_EFFECT_SHAPE', 'Active effect instance has an invalid shape'));
      continue;
    }
    if (!isStableRef(entry.effectRef) || refs.has(entry.effectRef)) {
      issues.push(issue(`${effectPath}.effectRef`, 'UNIQUE_PUBLIC_REF', 'Active effect reference must be valid and unique'));
    } else refs.add(entry.effectRef);
    if (!isStableRef(entry.sourceActorRef) || entry.targetActorRef !== value.actorRef) {
      issues.push(issue(effectPath, 'ACTIVE_EFFECT_ACTORS', 'Active effect actor references are invalid'));
    }
    if (!Number.isSafeInteger(entry.effectIndex) || (entry.effectIndex as number) < 0) {
      issues.push(issue(`${effectPath}.effectIndex`, 'SAFE_INTEGER', 'Effect index must be non-negative'));
    }
    if (!Number.isSafeInteger(entry.stacks) || (entry.stacks as number) < 1
      || (entry.stacks as number) > CORE_V1_MAX_RUNTIME_STATUS_STACKS) {
      issues.push(issue(`${effectPath}.stacks`, 'STACK_LIMIT', 'Active effect stacks are outside runtime limits'));
    }
    try {
      assertTick(entry.appliedAtTick as bigint, `${effectPath}.appliedAtTick`);
    } catch {
      issues.push(issue(`${effectPath}.appliedAtTick`, 'TICK', 'Applied tick is invalid'));
    }
    issues.push(...versionReferenceIssues(entry.sourceContent, `${effectPath}.sourceContent`));
    issues.push(...durationStateIssues(entry.durationState, `${effectPath}.durationState`));
    if (!isPlainRecord(entry.payload) || entry.kind !== entry.payload.type) {
      issues.push(issue(`${effectPath}.payload`, 'ACTIVE_EFFECT_PAYLOAD', 'Active effect kind and payload must match'));
    }
  }
  return issues;
}

export function validateCoreV1ResourceState(
  input: unknown,
): CoreV1EffectResolutionResult<CoreV1ResourceState> {
  const issues = resourceIssues(input);
  return issues.length > 0 ? failure(issues) : success(input as CoreV1ResourceState);
}

function assertRolls(rolls: CoreV1InjectedRolls): void {
  if (!isPlainRecord(rolls)) throw new TypeError('rolls must be a plain object');
  if (rolls.forcedMiss === true) {
    const keys = rolls.concentrationRoll === undefined ? ['forcedMiss'] : ['forcedMiss', 'concentrationRoll'];
    if (!hasOnlyKeys(rolls, keys)) throw new TypeError('forcedMiss rolls contain unsupported fields');
  } else {
    if (rolls.forcedMiss !== undefined && rolls.forcedMiss !== false) throw new TypeError('forcedMiss must be false when present');
    const keys = [
      ...(Object.hasOwn(rolls, 'forcedMiss') ? ['forcedMiss'] : []),
      'hitRollBps', 'criticalRollBps',
      ...(rolls.concentrationRoll === undefined ? [] : ['concentrationRoll']),
    ];
    if (!hasOnlyKeys(rolls, keys)) throw new TypeError('rolls contain unsupported or missing fields');
    assertIntegerInRange(rolls.hitRollBps, CORE_V1_MIN_ROLL_BPS, CORE_V1_MAX_ROLL_BPS, 'hitRollBps');
  }
  if (rolls.concentrationRoll !== undefined) assertInteger(rolls.concentrationRoll, 'concentrationRoll');
}

function cloneResources(resources: CoreV1ResourceState): CoreV1ResourceState {
  return structuredClone(resources);
}

function getCustomPool(
  resources: CoreV1ResourceState,
  code: string,
): { readonly ref: CoreV1CustomResourceReference; readonly pool: CoreV1ResourcePool } | null {
  const match = resources.customResources?.find((entry) => entry.resourceRef.code === code);
  return match === undefined ? null : { ref: match.resourceRef, pool: match.pool };
}

function modifierTotal(modifiers: readonly AuthorizedNumericModifier[] | undefined, name: string): number {
  return sumAuthorizedModifiers(modifiers, name);
}

function adjustedCost(base: number, modifierBps: number, name: string): CoreV1CostAmountReport['adjusted'] {
  assertInteger(base, `${name} base`);
  if (base < 0) throw new RangeError(`${name} base must not be negative`);
  const effectiveMultiplierBps = clamp(
    0,
    CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS,
    safeIntegerAdd(10_000, modifierBps, `${name} multiplier`),
  );
  if (base === 0 || effectiveMultiplierBps === 0) return 0;
  return Math.max(1, ceilDiv(safeIntegerMultiply(base, effectiveMultiplierBps, `${name} product`), 10_000));
}

function costAmount(
  resource: CoreV1ResourceCode,
  base: number,
  modifierBps: number,
  resourceRef?: CoreV1CustomResourceReference,
): CoreV1CostAmountReport {
  const effectiveMultiplierBps = clamp(
    0,
    CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS,
    safeIntegerAdd(10_000, modifierBps, `${resource} multiplier`),
  );
  const value: CoreV1CostAmountReport = {
    resource,
    base,
    modifierBps,
    effectiveMultiplierBps,
    adjusted: adjustedCost(base, modifierBps, resource),
  };
  return resourceRef === undefined ? value : { ...value, resourceRef };
}

function poolForAmount(resources: CoreV1ResourceState, amount: CoreV1CostAmountReport): CoreV1ResourcePool {
  if (amount.resource === 'custom') {
    const custom = amount.resourceRef === undefined ? null : getCustomPool(resources, amount.resourceRef.code);
    if (custom === null) throw new RangeError('custom resource is not available');
    return custom.pool;
  }
  return resources[amount.resource];
}

function deltaForCost(resources: CoreV1ResourceState, amount: CoreV1CostAmountReport): CoreV1ResourceDelta {
  const pool = poolForAmount(resources, amount);
  const after = pool.current - amount.adjusted;
  const value: CoreV1ResourceDelta = {
    resource: amount.resource,
    before: pool.current,
    after,
    delta: -amount.adjusted,
  };
  return amount.resourceRef === undefined ? value : { ...value, resourceRef: amount.resourceRef };
}

export function resolveCoreV1Cost(input: {
  readonly tier: number;
  readonly cost: CoreV1Cost;
  readonly resources: CoreV1ResourceState;
  readonly modifiers?: CoreV1CostModifierSet;
}): CoreV1EffectResolutionResult<CoreV1CostResolution> {
  const resources = validateCoreV1ResourceState(input.resources);
  if (!resources.ok) return resources;
  const costValidation = validateCost(input.tier, input.cost);
  if (!costValidation.ok) return failure(costValidation.issues);
  try {
    const manaModifier = modifierTotal(input.modifiers?.manaCostBps, 'manaCostBps');
    const spModifier = modifierTotal(input.modifiers?.spCostBps, 'spCostBps');
    const hpModifier = modifierTotal(input.modifiers?.hpCostBps, 'hpCostBps');
    const amounts: CoreV1CostAmountReport[] = [];
    let maintenancePlan: CoreV1MaintenancePlan | undefined;
    const cost = costValidation.value;
    if (cost.type === 'mana') amounts.push(costAmount('mana', cost.amount, manaModifier));
    else if (cost.type === 'sp') amounts.push(costAmount('sp', cost.amount, spModifier));
    else if (cost.type === 'hybrid') {
      amounts.push(costAmount('mana', cost.mana, manaModifier), costAmount('sp', cost.sp, spModifier));
    } else if (cost.type === 'active_defense' || cost.type === 'special_dodge') {
      amounts.push(costAmount('sp', cost.sp, spModifier));
    } else if (cost.type === 'maintenance') {
      const modifier = cost.resource === 'mana' ? manaModifier : spModifier;
      const activation = costAmount(cost.resource, cost.activationCost, modifier);
      amounts.push(activation);
      maintenancePlan = {
        activationCost: activation.adjusted,
        upkeepCost: adjustedCost(cost.amount, modifier, 'upkeep'),
        upkeepResource: cost.resource,
      };
    } else if (cost.type === 'hp') {
      const base = ceilDiv(
        safeIntegerMultiply(resources.value.hp.maximum, cost.percentBps, 'HP percentage cost'),
        10_000,
      );
      amounts.push(costAmount('hp', base, hpModifier));
    } else if (cost.type === 'custom') {
      const custom = getCustomPool(resources.value, cost.resourceRef);
      if (custom === null) {
        return failure([issue('cost.resourceRef', 'CUSTOM_RESOURCE_REQUIRED', 'Required custom resource is not present')]);
      }
      amounts.push(costAmount('custom', cost.amount, 0, custom.ref));
    }
    const affordable = amounts.every((amount) => {
      const pool = poolForAmount(resources.value, amount);
      return amount.resource === 'hp'
        ? pool.current - amount.adjusted >= 1
        : pool.current >= amount.adjusted;
    });
    const resolution: CoreV1CostResolution = {
      cost,
      amounts,
      resourceDeltas: amounts.map((amount) => deltaForCost(resources.value, amount)),
      affordable,
    };
    return success(maintenancePlan === undefined ? resolution : { ...resolution, maintenancePlan });
  } catch (error) {
    return caughtFailure(error, 'cost');
  }
}

function applyResourceDeltas(
  resources: CoreV1ResourceState,
  deltas: readonly CoreV1ResourceDelta[],
): CoreV1ResourceState {
  let next = cloneResources(resources);
  for (const delta of deltas) {
    if (delta.resource === 'custom') {
      if (delta.resourceRef === undefined) throw new TypeError('custom resource delta requires a reference');
      const customResources = next.customResources;
      if (customResources === undefined) throw new RangeError('custom resource delta cannot be applied');
      next = {
        ...next,
        customResources: customResources.map((entry) => entry.resourceRef.code === delta.resourceRef?.code
          ? { ...entry, pool: { ...entry.pool, current: delta.after } }
          : entry),
      };
    } else next = { ...next, [delta.resource]: { ...next[delta.resource], current: delta.after } };
  }
  return next;
}

function targetContextIssues(context: CoreV1TargetResolutionContext, targetingType?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isStableRef(context.targetRef)) issues.push(issue('targeting.targetRef', 'PUBLIC_REF', 'Target reference is invalid'));
  if (!Number.isSafeInteger(context.targetOrdinal) || context.targetOrdinal < 0) {
    issues.push(issue('targeting.targetOrdinal', 'SAFE_INTEGER', 'Target ordinal must be a non-negative safe integer'));
  }
  if (!Number.isSafeInteger(context.damageMultiplierBps)
    || context.damageMultiplierBps < 0 || context.damageMultiplierBps > 10_000) {
    issues.push(issue('targeting.damageMultiplierBps', 'MULTIPLIER_RANGE', 'Target multiplier must be between 0 and 10000'));
  }
  if (targetingType !== undefined && ['self', 'single_target', 'weapon_attack'].includes(targetingType)
    && context.damageMultiplierBps !== 10_000) {
    issues.push(issue('targeting.damageMultiplierBps', 'SINGLE_TARGET_MULTIPLIER', 'Single, self and weapon attacks require multiplier 10000'));
  }
  return issues;
}

function scaledDamageComponents(
  definitions: readonly DamageComponentDefinition[],
  actor: CoreV1ActorEffectContext,
  multiplierBps: number,
): ReturnType<typeof createRawDamageComponent>[] {
  if (definitions.length === 0 || definitions.length > CORE_V1_MAX_DAMAGE_COMPONENTS) {
    throw new RangeError('damage component count is invalid');
  }
  return definitions.map((definition) => {
    const actorPower = definition.channel === 'physical'
      ? actor.secondaryAttributes.actorPhysicalPower
      : actor.secondaryAttributes.actorMagicalPower;
    const raw = createRawDamageComponent(definition, actorPower);
    return {
      ...raw,
      amount: roundHalfUp(safeIntegerMultiply(raw.amount, multiplierBps, 'target damage multiplier') / 10_000),
    };
  });
}

export function resolveCoreV1DamageApplication(
  input: CoreV1DamageApplicationInput,
): CoreV1EffectResolutionResult<CoreV1DamageApplicationResult> {
  const targetingIssues = [
    ...actorIssues(input.attacker, 'attacker'),
    ...actorIssues(input.target, 'target'),
    ...targetContextIssues(input.targeting),
  ];
  if (input.target.actorRef !== input.targeting.targetRef) {
    targetingIssues.push(issue('targeting.targetRef', 'TARGET_MATCH', 'Target context must match the target actor'));
  }
  if (targetingIssues.length > 0) return failure(targetingIssues);
  try {
    assertRolls(input.rolls);
    assertIntegerInRange(input.relevantRank ?? 0, 0, 10, 'relevantRank');
    const components = input.addDamage === true
      ? [...(input.weaponDamageComponents ?? []), ...input.damageComponents]
      : [...input.damageComponents];
    if (input.addDamage === true && (input.weaponDamageComponents?.length ?? 0) === 0) {
      return failure([issue('weaponDamageComponents', 'WEAPON_DAMAGE_REQUIRED', 'add_damage requires resolved weapon damage')]);
    }
    if (components.length > CORE_V1_MAX_DAMAGE_COMPONENTS) {
      return failure([issue('damageComponents', 'MAX_DAMAGE_COMPONENTS', 'Damage resolution supports at most six components')]);
    }
    const hitChanceBps = calculateHitChanceBps(
      input.attacker.secondaryAttributes.accuracy,
      input.target.secondaryAttributes.evasion,
      input.situationalHitModifiersBps ?? 0,
    );
    const hit = input.rolls.forcedMiss !== true && input.rolls.hitRollBps <= hitChanceBps;
    const criticalProfile = calculateCriticalProfile(
      input.attacker.primaryAttributes,
      components.some((component) => component.canCrit),
    );
    let critical = false;
    if (hit && criticalProfile.canCrit) {
      assertIntegerInRange(
        input.rolls.criticalRollBps,
        CORE_V1_MIN_ROLL_BPS,
        CORE_V1_MAX_ROLL_BPS,
        'criticalRollBps',
      );
      critical = input.rolls.criticalRollBps <= criticalProfile.criticalChanceBps;
    }
    const raw = scaledDamageComponents(components, input.attacker, input.targeting.damageMultiplierBps);
    const resistances = input.defense.temporaryResistances ?? {
      physicalResistanceBps: input.target.secondaryAttributes.physicalResistanceBps,
      magicalResistanceBps: input.target.secondaryAttributes.magicalResistanceBps,
    };
    const mitigated = mitigateDamage({
      actionHit: hit,
      components: raw,
      critical,
      criticalDamageBps: criticalProfile.criticalDamageBps,
      physicalFlatDefense: input.target.secondaryAttributes.physicalDefense,
      magicalFlatDefense: input.target.secondaryAttributes.magicalDefense,
      blockValue: input.defense.blockValue,
      completeBlock: input.defense.completeBlock,
      resistances,
      ...(input.defense.temporaryImmunities === undefined
        ? {}
        : { immunities: input.defense.temporaryImmunities }),
    });
    const hpBefore = input.target.resources.hp.current;
    const hpAfter = Math.max(0, hpBefore - mitigated.totalDamage);
    return success({
      hpBefore,
      hpAfter,
      damageApplied: hpBefore - hpAfter,
      overkill: Math.max(0, mitigated.totalDamage - hpBefore),
      defeatedCandidate: hpAfter === 0,
      hitChanceBps,
      hit,
      criticalChanceBps: criticalProfile.criticalChanceBps,
      critical,
      componentBreakdown: mitigated.components,
    });
  } catch (error) {
    return caughtFailure(error, 'damage');
  }
}

export function resolveCoreV1ResourceRestoration(input: {
  readonly resources: CoreV1ResourceState;
  readonly resource: CoreV1ResourceCode;
  readonly amount: number;
  readonly resourceRef?: CoreV1CustomResourceReference;
}): CoreV1EffectResolutionResult<CoreV1ResourceRestorationResult> {
  const resources = validateCoreV1ResourceState(input.resources);
  if (!resources.ok) return resources;
  try {
    assertInteger(input.amount, 'amount');
    if (input.amount <= 0) return failure([issue('amount', 'POSITIVE_INTEGER', 'Restoration amount must be positive')]);
    let pool: CoreV1ResourcePool;
    if (input.resource === 'custom') {
      if (input.resourceRef === undefined) return failure([issue('resourceRef', 'REQUIRED', 'Custom restoration requires a resource reference')]);
      const custom = getCustomPool(resources.value, input.resourceRef.code);
      if (custom === null) return failure([issue('resourceRef', 'CUSTOM_RESOURCE_REQUIRED', 'Custom resource is not present')]);
      pool = custom.pool;
    } else pool = resources.value[input.resource];
    const after = Math.min(pool.maximum, safeIntegerAdd(pool.current, input.amount, 'resource restoration'));
    const applied = after - pool.current;
    const delta: CoreV1ResourceDelta = {
      resource: input.resource,
      before: pool.current,
      after,
      delta: applied,
      ...(input.resourceRef === undefined ? {} : { resourceRef: input.resourceRef }),
    };
    const next = applyResourceDeltas(resources.value, [delta]);
    const result: CoreV1ResourceRestorationResult = {
      resource: input.resource,
      before: pool.current,
      after,
      requested: input.amount,
      applied,
      wasted: input.amount - applied,
      resources: next,
      ...(input.resourceRef === undefined ? {} : { resourceRef: input.resourceRef }),
    };
    return success(result);
  } catch (error) {
    return caughtFailure(error, 'restoration');
  }
}

export function createCoreV1RuntimeDurationState(
  duration: CoreV1Duration,
  appliedAtTick: bigint,
): CoreV1EffectResolutionResult<CoreV1RuntimeDurationState | null> {
  try {
    assertTick(appliedAtTick, 'appliedAtTick');
    if (duration.type === 'instant') return success(null);
    if (duration.type === 'ticks') {
      assertInteger(duration.value, 'duration.value');
      if (duration.value <= 0) throw new RangeError('tick duration must be positive');
      return success({ type: 'ticks', expiresAtTick: addTicks(appliedAtTick, BigInt(duration.value), 'effect expiration') });
    }
    if (duration.type === 'actions') {
      assertInteger(duration.value, 'duration.value');
      if (duration.value <= 0) throw new RangeError('action duration must be positive');
      return success({ type: 'actions', remainingActions: duration.value });
    }
    if (duration.type === 'scene') return success({ type: 'scene', scope: 'scene' });
    if (duration.type === 'encounter') return success({ type: 'encounter', scope: 'encounter' });
    if (duration.type === 'permanent') return success({ type: 'permanent', scope: 'permanent' });
    return failure([issue('duration.type', 'DURATION_TYPE', 'Duration type is not supported')]);
  } catch (error) {
    return caughtFailure(error, 'duration');
  }
}

function cloneActor(actor: CoreV1ActorEffectContext): CoreV1ActorEffectContext {
  return structuredClone(actor);
}

function lifecycleChange(effect: CoreV1ActiveEffectInstance, change: CoreV1ActiveEffectChange['change']): CoreV1ActiveEffectChange {
  return {
    change,
    effectRef: effect.effectRef,
    stacksBefore: effect.stacks,
    stacksAfter: change === 'removed' || change === 'expired' ? 0 : effect.stacks,
    stacksAdded: 0,
    ignoredDuplicate: false,
  };
}

export function expireEffectsAtTick(
  actor: CoreV1ActorEffectContext,
  currentTick: bigint,
): CoreV1EffectResolutionResult<CoreV1ActiveEffectLifecycleResult> {
  const validation = actorIssues(actor, 'actor');
  if (validation.length > 0) return failure(validation, 'INVALID_ACTIVE_EFFECT_STATE');
  try {
    assertTick(currentTick, 'currentTick');
    const removed = actor.activeEffects.filter((effect) => effect.durationState.type === 'ticks'
      && effect.durationState.expiresAtTick <= currentTick);
    return success({
      actor: { ...cloneActor(actor), activeEffects: actor.activeEffects.filter((effect) => !removed.includes(effect)) },
      changes: removed.map((effect) => lifecycleChange(effect, 'expired')),
    });
  } catch (error) {
    return caughtFailure(error, 'currentTick');
  }
}

export function advanceActorActionDurations(
  actor: CoreV1ActorEffectContext,
  actorRef: string,
): CoreV1EffectResolutionResult<CoreV1ActiveEffectLifecycleResult> {
  const validation = actorIssues(actor, 'actor');
  if (validation.length > 0) return failure(validation, 'INVALID_ACTIVE_EFFECT_STATE');
  if (actor.actorRef !== actorRef) return failure([issue('actorRef', 'ACTOR_MATCH', 'Action actor must match the supplied actor state')]);
  const changes: CoreV1ActiveEffectChange[] = [];
  const activeEffects: CoreV1ActiveEffectInstance[] = [];
  for (const effect of actor.activeEffects) {
    if (effect.targetActorRef !== actorRef || effect.durationState.type !== 'actions') {
      activeEffects.push(structuredClone(effect));
      continue;
    }
    if (effect.durationState.remainingActions <= 1) {
      changes.push(lifecycleChange(effect, 'expired'));
    } else {
      activeEffects.push({
        ...structuredClone(effect),
        durationState: { type: 'actions', remainingActions: effect.durationState.remainingActions - 1 },
      });
    }
  }
  return success({ actor: { ...cloneActor(actor), activeEffects }, changes });
}

export function closeEffectScope(
  actor: CoreV1ActorEffectContext,
  scope: 'scene' | 'encounter',
): CoreV1EffectResolutionResult<CoreV1ActiveEffectLifecycleResult> {
  const validation = actorIssues(actor, 'actor');
  if (validation.length > 0) return failure(validation, 'INVALID_ACTIVE_EFFECT_STATE');
  const removed = actor.activeEffects.filter((effect) => effect.durationState.type === scope);
  return success({
    actor: { ...cloneActor(actor), activeEffects: actor.activeEffects.filter((effect) => !removed.includes(effect)) },
    changes: removed.map((effect) => lifecycleChange(effect, 'expired')),
  });
}

function sameContentVersion(
  left: CoreV1EffectContentVersionReference,
  right: CoreV1EffectContentVersionReference,
): boolean {
  return left.scope === right.scope && left.contentType === right.contentType
    && left.code === right.code && left.versionNumber === right.versionNumber;
}

function statusIdentity(
  effect: CoreV1ActiveEffectInstance,
  targetActorRef: string,
  version: CoreV1EffectContentVersionReference,
): boolean {
  return effect.kind === 'status' && effect.targetActorRef === targetActorRef
    && effect.payload.type === 'status' && sameContentVersion(effect.payload.contentVersion, version);
}

function maxDuration(
  current: CoreV1RuntimeDurationState,
  fresh: CoreV1RuntimeDurationState,
): CoreV1RuntimeDurationState {
  if (current.type === 'permanent') return current;
  if (fresh.type === 'permanent') return fresh;
  if (current.type !== fresh.type) throw new RangeError('stacked duration types must match');
  if (current.type === 'ticks' && fresh.type === 'ticks') {
    return current.expiresAtTick >= fresh.expiresAtTick ? current : fresh;
  }
  if (current.type === 'actions' && fresh.type === 'actions') {
    return current.remainingActions >= fresh.remainingActions ? current : fresh;
  }
  return current;
}

function validateStatusBinding(input: CoreV1ApplyStatusInput): ValidationIssue[] {
  const validation = validateCoreV1ContentProfile(input.profile);
  const issues: ValidationIssue[] = [];
  if (!validation.ok) issues.push(...validation.issues);
  if (input.profile.profileMode !== 'mechanical' || input.profile.contentKind !== 'status_effect') {
    issues.push(issue('profile.contentKind', 'STATUS_PROFILE', 'Applied status must use a mechanical status_effect profile'));
  }
  if (input.contentVersion.contentType !== 'status_effect'
    || input.contentVersion.code !== input.profile.code) {
    issues.push(issue('contentVersion', 'STATUS_VERSION_MATCH', 'Status profile must match the exact resolved content version'));
  }
  if (input.profile.duration === undefined || input.profile.stacking === undefined) {
    issues.push(issue('profile', 'STATUS_RUNTIME_FIELDS', 'Status profile must define duration and stacking'));
  } else if (JSON.stringify(input.profile.duration) !== JSON.stringify(input.duration)
    || JSON.stringify(input.profile.stacking) !== JSON.stringify(input.stacking)) {
    issues.push(issue('profile', 'STATUS_RUNTIME_MATCH', 'Applied duration and stacking must match the resolved status version'));
  }
  if (input.stacking.type === 'stack_duration'
    && input.duration.type !== 'ticks' && input.duration.type !== 'actions') {
    issues.push(issue('stacking', 'STACK_DURATION_COMPATIBILITY', 'stack_duration requires ticks or actions'));
  }
  return issues;
}

function createStatusInstance(
  input: CoreV1ApplyStatusInput,
  durationState: CoreV1RuntimeDurationState,
): CoreV1ActiveEffectInstance {
  return {
    effectRef: input.effectRef,
    sourceActorRef: input.sourceActorRef,
    targetActorRef: input.actor.actorRef,
    sourceContent: structuredClone(input.sourceContent),
    effectIndex: input.effectIndex,
    kind: 'status',
    stacks: 1,
    appliedAtTick: input.currentTick,
    durationState,
    payload: {
      type: 'status',
      contentVersion: structuredClone(input.contentVersion),
      profile: structuredClone(input.profile),
      stacking: structuredClone(input.stacking),
      baseDuration: structuredClone(input.duration),
    },
  };
}

export function applyCoreV1Status(
  input: CoreV1ApplyStatusInput,
): CoreV1EffectResolutionResult<CoreV1ApplyStatusResult> {
  const issues = [...actorIssues(input.actor, 'actor'), ...validateStatusBinding(input)];
  if (!isStableRef(input.effectRef)) issues.push(issue('effectRef', 'PUBLIC_REF', 'Effect reference is invalid'));
  if (!Number.isSafeInteger(input.effectIndex) || input.effectIndex < 0) {
    issues.push(issue('effectIndex', 'SAFE_INTEGER', 'Effect index must be a non-negative safe integer'));
  }
  if (issues.length > 0) return failure(issues, 'INVALID_ACTIVE_EFFECT_STATE');
  const duration = createCoreV1RuntimeDurationState(input.duration, input.currentTick);
  if (!duration.ok) return duration;
  if (duration.value === null) return failure([issue('duration', 'ACTIVE_DURATION', 'Instant status does not create an active state')], 'INVALID_ACTIVE_EFFECT_STATE');
  const existingIndex = input.actor.activeEffects.findIndex((effect) => statusIdentity(effect, input.actor.actorRef, input.contentVersion));
  const existing = input.actor.activeEffects[existingIndex];
  if (existing === undefined && input.actor.activeEffects.length >= CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR) {
    return failure([issue('actor.activeEffects', 'ACTIVE_EFFECT_LIMIT', 'Actor active effect limit would be exceeded')], 'INVALID_ACTIVE_EFFECT_STATE');
  }
  const fresh = createStatusInstance(input, duration.value);
  if (existing === undefined) {
    return success({
      actor: { ...cloneActor(input.actor), activeEffects: [...input.actor.activeEffects, fresh] },
      change: { change: 'created', effectRef: fresh.effectRef, stacksBefore: 0, stacksAfter: 1, stacksAdded: 1, ignoredDuplicate: false },
    });
  }
  if (input.stacking.type === 'none') {
    return success({
      actor: cloneActor(input.actor),
      change: { change: 'ignored', effectRef: existing.effectRef, stacksBefore: existing.stacks, stacksAfter: existing.stacks, stacksAdded: 0, ignoredDuplicate: true },
    });
  }
  let replacement: CoreV1ActiveEffectInstance;
  let change: CoreV1ActiveEffectChange['change'];
  let stacksAdded = 0;
  if (input.stacking.type === 'replace') {
    replacement = fresh;
    change = 'replaced';
  } else if (input.stacking.type === 'refresh') {
    replacement = {
      ...existing,
      durationState: existing.durationState.type === 'permanent' ? existing.durationState : duration.value,
      appliedAtTick: input.currentTick,
    };
    change = 'refreshed';
  } else if (input.stacking.type === 'stack_intensity') {
    const cap = Math.min(input.stacking.maxStacks, CORE_V1_MAX_RUNTIME_STATUS_STACKS);
    const stacks = Math.min(cap, existing.stacks + 1);
    stacksAdded = stacks - existing.stacks;
    replacement = { ...existing, stacks, durationState: maxDuration(existing.durationState, duration.value) };
    change = 'stacked';
  } else {
    if (input.duration.type !== 'ticks' && input.duration.type !== 'actions') {
      return failure([issue('stacking', 'STACK_DURATION_COMPATIBILITY', 'stack_duration requires ticks or actions')], 'INVALID_ACTIVE_EFFECT_STATE');
    }
    const cap = Math.min(input.stacking.maxStacks, CORE_V1_MAX_RUNTIME_STATUS_STACKS);
    const stacks = Math.min(cap, existing.stacks + 1);
    stacksAdded = stacks - existing.stacks;
    if (existing.durationState.type === 'ticks' && input.duration.type === 'ticks') {
      const maximum = addTicks(input.currentTick, BigInt(input.duration.value * cap), 'stack duration cap');
      const added = addTicks(existing.durationState.expiresAtTick, BigInt(input.duration.value), 'stack duration');
      replacement = { ...existing, stacks, durationState: { type: 'ticks', expiresAtTick: added > maximum ? maximum : added } };
    } else if (existing.durationState.type === 'actions' && input.duration.type === 'actions') {
      replacement = {
        ...existing,
        stacks,
        durationState: { type: 'actions', remainingActions: Math.min(input.duration.value * cap, existing.durationState.remainingActions + input.duration.value) },
      };
    } else return failure([issue('duration', 'STACK_DURATION_MATCH', 'Stacked runtime duration type must match')], 'INVALID_ACTIVE_EFFECT_STATE');
    change = 'stacked';
  }
  const activeEffects = input.actor.activeEffects.map((effect, index) => index === existingIndex ? replacement : structuredClone(effect));
  return success({
    actor: { ...cloneActor(input.actor), activeEffects },
    change: {
      change,
      effectRef: replacement.effectRef,
      stacksBefore: existing.stacks,
      stacksAfter: replacement.stacks,
      stacksAdded,
      ignoredDuplicate: false,
    },
  });
}

export function removeCoreV1Status(
  input: CoreV1RemoveStatusInput,
): CoreV1EffectResolutionResult<CoreV1ActiveEffectLifecycleResult> {
  const validation = actorIssues(input.actor, 'actor');
  if (validation.length > 0) return failure(validation, 'INVALID_ACTIVE_EFFECT_STATE');
  const versionIssues = versionReferenceIssues(input.contentVersion, 'contentVersion');
  if (versionIssues.length > 0) return failure(versionIssues, 'INVALID_ACTIVE_EFFECT_STATE');
  const removed = input.actor.activeEffects.filter((effect) => statusIdentity(effect, input.actor.actorRef, input.contentVersion));
  return success({
    actor: {
      ...cloneActor(input.actor),
      activeEffects: input.actor.activeEffects.filter((effect) => !removed.includes(effect)),
    },
    changes: removed.map((effect) => lifecycleChange(effect, 'removed')),
  });
}

function activeAtTick(effect: CoreV1ActiveEffectInstance, currentTick: bigint): boolean {
  return effect.durationState.type !== 'ticks' || effect.durationState.expiresAtTick > currentTick;
}

export function collectActiveEffectModifiers(
  actor: CoreV1ActorEffectContext,
  currentTick: bigint,
): CoreV1EffectResolutionResult<readonly CoreV1CollectedActiveModifier[]> {
  const validation = actorIssues(actor, 'actor');
  if (validation.length > 0) return failure(validation, 'INVALID_ACTIVE_EFFECT_STATE');
  try {
    assertTick(currentTick, 'currentTick');
    const collected: CoreV1CollectedActiveModifier[] = [];
    const sorted = actor.activeEffects.filter((effect) => activeAtTick(effect, currentTick))
      .sort((left, right) => left.effectRef.localeCompare(right.effectRef));
    for (const effect of sorted) {
      const source = { type: 'status' as const, ref: effect.effectRef };
      if (effect.payload.type === 'primary_modifier') {
        collected.push({ target: effect.payload.attributeCode, value: effect.payload.amount, source });
      } else if (effect.payload.type === 'secondary_modifier') {
        collected.push({ target: effect.payload.secondaryCode, value: effect.payload.amount, source });
      } else if (effect.payload.type === 'status') {
        for (const modifier of effect.payload.profile.passiveModifiers ?? []) {
          const multiplier = effect.payload.stacking.type === 'stack_intensity' ? effect.stacks : 1;
          collected.push({
            target: modifier.target,
            value: safeIntegerMultiply(modifier.amount, multiplier, 'active status modifier'),
            source,
          });
        }
      }
      if (collected.length > CORE_V1_MAX_ACTIVE_MODIFIERS_PER_ACTOR) {
        return failure([issue('actor.activeEffects', 'ACTIVE_MODIFIER_LIMIT', 'Actor active modifier limit would be exceeded')], 'INVALID_ACTIVE_EFFECT_STATE');
      }
    }
    return success(collected);
  } catch (error) {
    return caughtFailure(error, 'actor.activeEffects');
  }
}

function effectContentRef(ref: CoreV1ContentVersionReference): CoreV1EffectContentVersionReference {
  return { scope: ref.scope, contentType: ref.contentType as CoreV1EffectContentVersionReference['contentType'], code: ref.code, versionNumber: ref.versionNumber };
}

function actorWithResources(actor: CoreV1ActorEffectContext, resources: CoreV1ResourceState): CoreV1ActorEffectContext {
  return { ...actor, resources: cloneResources(resources) };
}

function actorWithHp(actor: CoreV1ActorEffectContext, hp: number): CoreV1ActorEffectContext {
  return { ...actor, resources: { ...actor.resources, hp: { ...actor.resources.hp, current: hp } } };
}

function resolvedEffects(profile: CoreV1MechanicalContentProfile): readonly CoreV1Effect[] {
  const effects: CoreV1Effect[] = [];
  if ((profile.damageComponents?.length ?? 0) > 0 && profile.targeting !== undefined) {
    effects.push({ type: 'damage', damageComponents: profile.damageComponents ?? [], targeting: profile.targeting });
  }
  effects.push(...(profile.effects ?? []));
  return effects;
}

function statusBinding(
  bindings: readonly CoreV1StatusDefinitionBinding[] | undefined,
  effectIndex: number,
): CoreV1StatusDefinitionBinding | undefined {
  return bindings?.find((binding) => binding.effectIndex === effectIndex);
}

function runtimeDuration(
  input: CoreV1EffectSequenceInput,
  effectIndex: number,
): CoreV1Duration | undefined {
  return input.runtimeDurations?.find((binding) => binding.effectIndex === effectIndex)?.duration;
}

function createActiveInstance(input: {
  readonly actor: CoreV1ActorEffectContext;
  readonly sourceActorRef: string;
  readonly sourceContent: CoreV1EffectContentVersionReference;
  readonly effectIndex: number;
  readonly effectRef: string;
  readonly currentTick: bigint;
  readonly duration: CoreV1Duration;
  readonly payload: CoreV1ActiveEffectPayload;
}): CoreV1EffectResolutionResult<{ readonly actor: CoreV1ActorEffectContext; readonly change: CoreV1ActiveEffectChange | null }> {
  const duration = createCoreV1RuntimeDurationState(input.duration, input.currentTick);
  if (!duration.ok) return duration;
  if (duration.value === null) return success({ actor: cloneActor(input.actor), change: null });
  const same = input.actor.activeEffects.findIndex((effect) => effect.effectRef === input.effectRef);
  const instance: CoreV1ActiveEffectInstance = {
    effectRef: input.effectRef,
    sourceActorRef: input.sourceActorRef,
    targetActorRef: input.actor.actorRef,
    sourceContent: structuredClone(input.sourceContent),
    effectIndex: input.effectIndex,
    kind: input.payload.type,
    stacks: 1,
    appliedAtTick: input.currentTick,
    durationState: duration.value,
    payload: structuredClone(input.payload),
  };
  if (same < 0 && input.actor.activeEffects.length >= CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR) {
    return failure([issue('actor.activeEffects', 'ACTIVE_EFFECT_LIMIT', 'Actor active effect limit would be exceeded')], 'INVALID_ACTIVE_EFFECT_STATE');
  }
  const activeEffects = same < 0
    ? [...input.actor.activeEffects, instance]
    : input.actor.activeEffects.map((effect, index) => index === same ? instance : structuredClone(effect));
  return success({
    actor: { ...cloneActor(input.actor), activeEffects },
    change: {
      change: same < 0 ? 'created' : 'replaced',
      effectRef: input.effectRef,
      stacksBefore: same < 0 ? 0 : 1,
      stacksAfter: 1,
      stacksAdded: same < 0 ? 1 : 0,
      ignoredDuplicate: false,
    },
  });
}

function conceptualEvent(
  event: Omit<CoreV1ConceptualEvent, 'sourceActorRef' | 'targetActorRef' | 'contentRef'>,
  sourceActorRef: string,
  targetActorRef: string,
  contentRef: CoreV1EffectContentVersionReference,
): CoreV1ConceptualEvent {
  return { ...event, sourceActorRef, targetActorRef, contentRef: structuredClone(contentRef) };
}

function prevalidateSequence(input: CoreV1EffectSequenceInput, effects: readonly CoreV1Effect[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  issues.push(...actorIssues(input.sourceActor, 'sourceActor'));
  issues.push(...actorIssues(input.targetActor, 'targetActor'));
  issues.push(...versionReferenceIssues(input.sourceContent, 'sourceContent'));
  const profile = validateCoreV1ContentProfile(input.profile);
  if (!profile.ok) issues.push(...profile.issues);
  if (input.profile.profileMode !== 'mechanical') issues.push(issue('profile.profileMode', 'MECHANICAL_PROFILE', 'Effect sequence requires a mechanical profile'));
  if (effects.length > CORE_V1_MAX_EFFECTS_PER_SEQUENCE) issues.push(issue('effects', 'EFFECT_LIMIT', 'Effect sequence exceeds the operational limit'));
  if (input.effectRefs.length !== effects.length) issues.push(issue('effectRefs', 'EFFECT_REF_COUNT', 'Every resolved effect requires one deterministic reference', effects.length, input.effectRefs.length));
  const refs = new Set<string>();
  input.effectRefs.forEach((ref, index) => {
    if (!isStableRef(ref)) issues.push(issue(`effectRefs.${index}`, 'PUBLIC_REF', 'Effect reference is invalid'));
    else if (refs.has(ref)) issues.push(issue(`effectRefs.${index}`, 'DUPLICATE_EFFECT_REF', 'Effect references must be unique'));
    refs.add(ref);
  });
  const runtimeDurationIndexes = new Set<number>();
  input.runtimeDurations?.forEach((binding, index) => {
    if (!Number.isSafeInteger(binding.effectIndex) || binding.effectIndex < 0 || binding.effectIndex >= effects.length) {
      issues.push(issue(`runtimeDurations.${index}.effectIndex`, 'EFFECT_INDEX', 'Runtime duration effect index is invalid'));
    } else if (runtimeDurationIndexes.has(binding.effectIndex)) {
      issues.push(issue(`runtimeDurations.${index}.effectIndex`, 'DUPLICATE_EFFECT_INDEX', 'Runtime duration bindings must be unique'));
    } else runtimeDurationIndexes.add(binding.effectIndex);
  });
  if (input.sourceActor.actorRef === input.targetActor.actorRef && input.sourceActor !== input.targetActor) {
    issues.push(issue('targetActor.actorRef', 'ACTOR_ALIAS', 'The same actor reference must use one coherent projection'));
  }
  if (input.targetActor.actorRef !== input.targeting.targetRef) issues.push(issue('targeting.targetRef', 'TARGET_MATCH', 'Target context must match target actor'));
  issues.push(...targetContextIssues(input.targeting, input.profile.targeting?.type));
  const estimatedChanges = effects.length + (input.profile.cost.type === 'hybrid' ? 2 : input.profile.cost.type === 'none' ? 0 : 1);
  if (estimatedChanges > CORE_V1_MAX_RESOLUTION_CHANGES) issues.push(issue('effects', 'CHANGE_LIMIT', 'Resolution would exceed the change limit'));
  for (let index = 0; index < effects.length; index += 1) {
    const effect = effects[index];
    if (effect === undefined) continue;
    if (['damage', 'add_damage'].includes(effect.type) && input.rolls === undefined) {
      issues.push(issue('rolls', 'ROLLS_REQUIRED', 'Offensive damage requires injected hit and critical rolls'));
    }
    if (effect.type === 'damage' || effect.type === 'add_damage' || effect.type === 'restore_resource') {
      issues.push(...targetContextIssues(input.targeting, effect.targeting.type));
    }
    if (effect.type === 'apply_status' || effect.type === 'remove_status') {
      const binding = statusBinding(input.statusDefinitions, index);
      if (binding === undefined) issues.push(issue(`statusDefinitions.${index}`, 'STATUS_VERSION_REQUIRED', 'Status effect requires an exact resolved public version'));
      else {
        if (binding.effectRef !== input.effectRefs[index]) {
          issues.push(issue(`statusDefinitions.${index}.effectRef`, 'EFFECT_REF_MATCH', 'Status binding must use the effect reference at its index'));
        }
        if (binding.contentVersion.code !== effect.statusRef) {
          issues.push(issue(`statusDefinitions.${index}.contentVersion.code`, 'STATUS_REF_MATCH', 'Resolved status version must match statusRef'));
        }
        if (effect.type === 'apply_status') {
          if (binding.profile === undefined) {
            issues.push(issue(`statusDefinitions.${index}.profile`, 'STATUS_PROFILE_REQUIRED', 'Applying status requires its resolved canonical profile'));
          } else {
            issues.push(...validateStatusBinding({
              actor: input.targetActor,
              sourceActorRef: input.sourceActor.actorRef,
              sourceContent: input.sourceContent,
              effectIndex: index,
              effectRef: binding.effectRef,
              contentVersion: binding.contentVersion,
              profile: binding.profile,
              duration: effect.duration,
              stacking: effect.stacking,
              currentTick: input.currentTick,
            }));
          }
        } else issues.push(...versionReferenceIssues(binding.contentVersion, `statusDefinitions.${index}.contentVersion`));
      }
    }
    if (effect.type === 'grant_reaction') {
      const duration = runtimeDuration(input, index);
      if (duration === undefined || duration.type === 'instant') {
        issues.push(issue(`runtimeDurations.${index}`, 'REACTION_DURATION_REQUIRED', 'Reaction grant requires an explicit active runtime duration'));
      }
    }
  }
  return issues;
}

export function resolveCoreV1EffectSequence(
  input: CoreV1EffectSequenceInput,
): CoreV1EffectResolutionResult<CoreV1EffectSequenceResult> {
  const effects = resolvedEffects(input.profile);
  const validationIssues = prevalidateSequence(input, effects);
  if (validationIssues.length > 0) return failure(validationIssues);
  const cost = resolveCoreV1Cost({
    tier: input.profile.tier,
    cost: input.profile.cost,
    resources: input.sourceActor.resources,
    ...(input.costModifiers === undefined ? {} : { modifiers: input.costModifiers }),
  });
  if (!cost.ok) return cost;
  if (!cost.value.affordable) {
    return failure([issue('sourceActor.resources', 'INSUFFICIENT_RESOURCE', 'Actor cannot afford the resolved cost')], 'INSUFFICIENT_RESOURCE');
  }
  let source = actorWithResources(cloneActor(input.sourceActor), applyResourceDeltas(input.sourceActor.resources, cost.value.resourceDeltas));
  let target = input.sourceActor.actorRef === input.targetActor.actorRef ? source : cloneActor(input.targetActor);
  const sourceBefore = cloneActor(input.sourceActor);
  const targetBefore = cloneActor(input.targetActor);
  const effectResults: { effectIndex: number; type: CoreV1Effect['type']; applied: boolean }[] = [];
  const activeEffectChanges: CoreV1ActiveEffectChange[] = [];
  const resourceChanges: CoreV1ResourceDelta[] = [...cost.value.resourceDeltas];
  const damageResults: CoreV1DamageApplicationResult[] = [];
  const movementCommands: CoreV1MovementCommand[] = [];
  const upkeepPlans: CoreV1MaintenancePlan[] = cost.value.maintenancePlan === undefined ? [] : [cost.value.maintenancePlan];
  const events: CoreV1ConceptualEvent[] = cost.value.resourceDeltas.map((delta) => conceptualEvent({
    eventType: 'resource_spent', amount: -delta.delta, resource: delta.resource,
  }, input.sourceActor.actorRef, input.sourceActor.actorRef, input.sourceContent));
  let offensiveHit: boolean | null = null;

  for (let index = 0; index < effects.length; index += 1) {
    const effect = effects[index];
    const effectRef = input.effectRefs[index];
    if (effect === undefined || effectRef === undefined) return failure([issue('effects', 'INTERNAL_EFFECT_ALIGNMENT', 'Validated effect alignment was lost')]);
    const selfTarget = effect.type === 'restore_resource'
      ? effect.targeting.type === 'self'
      : input.profile.targeting?.type === 'self';
    const skipForMiss = offensiveHit === false && !selfTarget && effect.type !== 'movement';
    if (skipForMiss) {
      effectResults.push({ effectIndex: index, type: effect.type, applied: false });
      continue;
    }
    if (effect.type === 'damage' || effect.type === 'add_damage') {
      const damage = resolveCoreV1DamageApplication({
        attacker: source,
        target,
        damageComponents: effect.damageComponents,
        ...(effect.type === 'add_damage' ? { addDamage: true } : {}),
        ...(input.weaponDamageComponents === undefined ? {} : { weaponDamageComponents: input.weaponDamageComponents }),
        rolls: input.rolls as CoreV1InjectedRolls,
        targeting: input.targeting,
        defense: input.defense ?? { blockValue: 0, completeBlock: false },
      });
      if (!damage.ok) return damage;
      offensiveHit = damage.value.hit;
      target = actorWithHp(target, damage.value.hpAfter);
      if (source.actorRef === target.actorRef) source = target;
      damageResults.push(damage.value);
      resourceChanges.push({ resource: 'hp', before: damage.value.hpBefore, after: damage.value.hpAfter, delta: -damage.value.damageApplied });
      events.push(conceptualEvent({ eventType: 'damage_applied', effectRef, amount: damage.value.damageApplied, resource: 'hp' }, source.actorRef, target.actorRef, input.sourceContent));
      effectResults.push({ effectIndex: index, type: effect.type, applied: damage.value.hit });
    } else if (effect.type === 'restore_resource') {
      const actor = effect.targeting.type === 'self' ? source : target;
      const restored = resolveCoreV1ResourceRestoration({ resources: actor.resources, resource: effect.resource, amount: effect.amount });
      if (!restored.ok) return restored;
      const delta: CoreV1ResourceDelta = { resource: effect.resource, before: restored.value.before, after: restored.value.after, delta: restored.value.applied };
      if (effect.targeting.type === 'self') {
        source = actorWithResources(source, restored.value.resources);
        if (source.actorRef === target.actorRef) target = source;
      } else target = actorWithResources(target, restored.value.resources);
      resourceChanges.push(delta);
      events.push(conceptualEvent({ eventType: 'resource_restored', effectRef, amount: restored.value.applied, resource: effect.resource }, source.actorRef, actor.actorRef, input.sourceContent));
      effectResults.push({ effectIndex: index, type: effect.type, applied: true });
    } else if (effect.type === 'apply_status') {
      const binding = statusBinding(input.statusDefinitions, index) as CoreV1StatusDefinitionBinding;
      if (binding.profile === undefined) return failure([issue(`statusDefinitions.${index}.profile`, 'STATUS_PROFILE_REQUIRED', 'Validated status profile is missing')]);
      const applied = applyCoreV1Status({
        actor: target,
        sourceActorRef: source.actorRef,
        sourceContent: input.sourceContent,
        effectIndex: index,
        effectRef,
        contentVersion: binding.contentVersion,
        profile: binding.profile,
        duration: effect.duration,
        stacking: effect.stacking,
        currentTick: input.currentTick,
      });
      if (!applied.ok) return applied;
      target = applied.value.actor;
      activeEffectChanges.push(applied.value.change);
      const eventType = applied.value.change.change === 'refreshed' ? 'status_refreshed'
        : applied.value.change.change === 'stacked' ? 'status_stacked' : 'status_applied';
      events.push(conceptualEvent({ eventType, effectRef: applied.value.change.effectRef, stacks: applied.value.change.stacksAfter }, source.actorRef, target.actorRef, binding.contentVersion));
      effectResults.push({ effectIndex: index, type: effect.type, applied: !applied.value.change.ignoredDuplicate });
    } else if (effect.type === 'remove_status') {
      const binding = statusBinding(input.statusDefinitions, index) as CoreV1StatusDefinitionBinding;
      const removed = removeCoreV1Status({ actor: target, contentVersion: binding.contentVersion });
      if (!removed.ok) return removed;
      target = removed.value.actor;
      activeEffectChanges.push(...removed.value.changes);
      removed.value.changes.forEach((change) => events.push(conceptualEvent({ eventType: 'status_removed', effectRef: change.effectRef }, source.actorRef, target.actorRef, binding.contentVersion)));
      effectResults.push({ effectIndex: index, type: effect.type, applied: removed.value.changes.length > 0 });
    } else if (effect.type === 'modify_primary_attribute' || effect.type === 'modify_secondary_attribute') {
      const payload: CoreV1ActiveEffectPayload = effect.type === 'modify_primary_attribute'
        ? { type: 'primary_modifier', attributeCode: effect.attributeCode, amount: effect.amount }
        : { type: 'secondary_modifier', secondaryCode: effect.secondaryCode, amount: effect.amount };
      const created = createActiveInstance({ actor: target, sourceActorRef: source.actorRef, sourceContent: input.sourceContent, effectIndex: index, effectRef, currentTick: input.currentTick, duration: effect.duration, payload });
      if (!created.ok) return created;
      target = created.value.actor;
      if (created.value.change !== null) activeEffectChanges.push(created.value.change);
      events.push(conceptualEvent({ eventType: 'modifier_applied', effectRef, amount: effect.amount }, source.actorRef, target.actorRef, input.sourceContent));
      effectResults.push({ effectIndex: index, type: effect.type, applied: true });
    } else if (effect.type === 'grant_reaction') {
      const duration = runtimeDuration(input, index);
      if (duration === undefined) return failure([issue(`runtimeDurations.${index}`, 'REACTION_DURATION_REQUIRED', 'Validated reaction duration is missing')]);
      const created = createActiveInstance({
        actor: target,
        sourceActorRef: source.actorRef,
        sourceContent: input.sourceContent,
        effectIndex: index,
        effectRef,
        currentTick: input.currentTick,
        duration,
        payload: { type: 'reaction_grant', reactionKind: effect.reactionKind, reactionDepth: effect.reactionDepth },
      });
      if (!created.ok) return created;
      target = created.value.actor;
      if (created.value.change !== null) activeEffectChanges.push(created.value.change);
      events.push(conceptualEvent({ eventType: 'reaction_granted', effectRef }, source.actorRef, target.actorRef, input.sourceContent));
      effectResults.push({ effectIndex: index, type: effect.type, applied: true });
    } else {
      if (!isValidZoneTransition(effect.from, effect.to, effect.maximumTransitions)) {
        return failure([issue(`effects.${index}`, 'ZONE_TRANSITION', 'Movement command is not a valid transition')]);
      }
      movementCommands.push({ from: effect.from, to: effect.to, maximumTransitions: effect.maximumTransitions });
      events.push(conceptualEvent({ eventType: 'movement_requested', effectRef }, source.actorRef, target.actorRef, input.sourceContent));
      effectResults.push({ effectIndex: index, type: effect.type, applied: true });
    }
    if (activeEffectChanges.length + resourceChanges.length + damageResults.length + movementCommands.length > CORE_V1_MAX_RESOLUTION_CHANGES) {
      return failure([issue('effects', 'CHANGE_LIMIT', 'Resolution exceeded the operational change limit')]);
    }
  }
  if (source.actorRef === target.actorRef) source = target;
  return success({
    sourceBefore,
    sourceAfter: source,
    targetBefore,
    targetAfter: target,
    costResolution: cost.value,
    effectResults,
    activeEffectChanges,
    resourceChanges,
    damageResults,
    movementCommands,
    upkeepPlans,
    events,
  });
}

function exactInventoryVersion(left: CoreV1ContentVersionReference, right: CoreV1ContentVersionReference): boolean {
  return left.scope === right.scope && left.contentType === right.contentType
    && left.code === right.code && left.versionNumber === right.versionNumber;
}

function consumeUnique(inventory: CoreV1InventoryState, entryRef: string): CoreV1InventoryState {
  return {
    entries: inventory.entries.map((entry) => entry.entryRef === entryRef && entry.entryKind === 'instance'
      ? { ...entry, state: 'consumed' as const }
      : structuredClone(entry)),
  };
}

export function resolveCoreV1ConsumableUse(
  input: CoreV1ConsumableUseInput,
): CoreV1EffectResolutionResult<CoreV1ConsumableUseResult> {
  const inventory = validateCoreV1InventoryState(input.inventory);
  if (!inventory.ok) return failure(inventory.issues);
  if (input.profile.contentKind !== 'consumable' || input.profile.profileMode !== 'mechanical') {
    return failure([issue('profile.contentKind', 'CONSUMABLE_PROFILE', 'Consumable use requires a mechanical consumable profile')]);
  }
  const effectTargetings = (input.profile.effects ?? []).flatMap((effect) => (
    'targeting' in effect ? [effect.targeting.type] : []
  ));
  const targeting = input.profile.targeting?.type;
  const requiresOrchestrator = targeting !== undefined
    ? targeting !== 'self' && targeting !== 'single_target'
    : effectTargetings.some((type) => type !== 'self' && type !== 'single_target');
  if (requiresOrchestrator) {
    return failure([issue('profile.targeting.type', 'ACTION_ORCHESTRATOR_REQUIRED', 'Multi-target consumables require an action orchestrator')], 'REQUIRES_ACTION_ORCHESTRATOR');
  }
  const entry = inventory.value.entries.find((candidate) => candidate.entryRef === input.entryRef);
  if (entry === undefined) return failure([issue('entryRef', 'ENTRY_NOT_FOUND', 'Consumable inventory entry was not found')]);
  if (!exactInventoryVersion(entry.contentVersion, input.contentVersionRef)
    || input.contentVersionRef.contentType !== 'consumable'
    || input.profile.code !== input.contentVersionRef.code) {
    return failure([issue('contentVersionRef', 'CONTENT_VERSION_MATCH', 'Inventory entry, profile and requested version must match exactly')]);
  }
  if (entry.entryKind === 'instance' && entry.state !== 'available') {
    return failure([issue('entryRef', 'CONSUMABLE_STATE', 'Unique consumable instance must be available')]);
  }
  const sequence = resolveCoreV1EffectSequence({
    profile: input.profile,
    sourceContent: effectContentRef(input.contentVersionRef),
    sourceActor: input.sourceActor,
    targetActor: input.targetActor,
    currentTick: input.currentTick,
    effectRefs: input.effectRefs,
    ...(input.statusDefinitions === undefined ? {} : { statusDefinitions: input.statusDefinitions }),
    ...(input.runtimeDurations === undefined ? {} : { runtimeDurations: input.runtimeDurations }),
    ...(input.rolls === undefined ? {} : { rolls: input.rolls }),
    targeting: input.targeting,
    ...(input.defense === undefined ? {} : { defense: input.defense }),
    ...(input.weaponDamageComponents === undefined ? {} : { weaponDamageComponents: input.weaponDamageComponents }),
    ...(input.costModifiers === undefined ? {} : { costModifiers: input.costModifiers }),
  });
  if (!sequence.ok) return sequence;
  let inventoryAfter: CoreV1InventoryState;
  if (entry.entryKind === 'stack') {
    const removed = removeInventoryQuantity(inventory.value, entry.entryRef, 1);
    if (!removed.ok) return failure(removed.issues);
    inventoryAfter = removed.value.inventory;
  } else {
    inventoryAfter = consumeUnique(inventory.value, entry.entryRef);
    const validated = validateCoreV1InventoryState(inventoryAfter);
    if (!validated.ok) return failure(validated.issues);
    inventoryAfter = validated.value;
  }
  const consumedEvent = conceptualEvent(
    { eventType: 'consumable_consumed' },
    input.sourceActor.actorRef,
    input.targetActor.actorRef,
    effectContentRef(input.contentVersionRef),
  );
  return success({
    inventoryBefore: inventory.value,
    inventoryAfter,
    sequence: sequence.value,
    actionProfile: input.profile.actionProfile ?? null,
    consumedEntryRef: input.entryRef,
    events: [...sequence.value.events, consumedEvent],
  });
}

export function getCoreV1EffectRulesIdentity(): CoreV1EffectRulesIdentity {
  return {
    rulesetCode: CORE_V1_EFFECT_RULESET_CODE,
    effectRulesCode: CORE_V1_EFFECT_RULES_CODE,
    schemaVersion: CORE_V1_EFFECT_SCHEMA_VERSION,
  };
}

export function getCoreV1EffectRulesLimits(): CoreV1EffectRulesLimits {
  return {
    maxActors: CORE_V1_MAX_RESOLUTION_ACTORS,
    maxEffectsPerSequence: CORE_V1_MAX_EFFECTS_PER_SEQUENCE,
    maxChanges: CORE_V1_MAX_RESOLUTION_CHANGES,
    maxActiveEffectsPerActor: CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR,
    maxActiveModifiersPerActor: CORE_V1_MAX_ACTIVE_MODIFIERS_PER_ACTOR,
    maxStacksPerState: CORE_V1_MAX_RUNTIME_STATUS_STACKS,
    rollBps: { minimum: CORE_V1_MIN_ROLL_BPS, maximum: CORE_V1_MAX_ROLL_BPS },
    multiplierBps: { minimum: 0, maximum: CORE_V1_MAX_OPERATIONAL_MULTIPLIER_BPS },
  };
}

export function isCoreV1ActorEffectContext(value: unknown): value is CoreV1ActorEffectContext {
  return actorIssues(value, 'actor').length === 0;
}

export function countCoreV1ResolutionActors(actors: readonly CoreV1ActorEffectContext[]): CoreV1EffectResolutionResult<number> {
  const runtimeActors: unknown = actors;
  if (!Array.isArray(runtimeActors) || actors.length > CORE_V1_MAX_RESOLUTION_ACTORS) {
    return failure([issue('actors', 'ACTOR_LIMIT', 'Resolution supports at most sixteen actors')]);
  }
  const refs = new Set(actors.map((actor) => actor.actorRef));
  if (refs.size !== actors.length) return failure([issue('actors', 'DUPLICATE_ACTOR_REF', 'Actor references must be unique')]);
  return success(actors.length);
}
