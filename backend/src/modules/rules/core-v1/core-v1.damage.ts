import { CORE_V1_MAX_DAMAGE_COMPONENTS } from './core-v1.config.js';
import {
  assertInteger, assertIntegerInRange, hasExactOwnKeys, isPlainRecord, roundHalfUp,
  safeIntegerMultiply, safeIntegerSum,
} from './core-v1.math.js';
import type {
  DamageChannel, DamageComponentDefinition, DamageImmunities, DamageMitigationInput,
  DamageMitigationResult, DamageScaling, MitigatedDamageComponent, RawDamageComponent,
} from './core-v1.types.js';

function assertNonNegativeInteger(value: number, name: string): void {
  assertInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

function assertDamageComponentDefinition(definition: DamageComponentDefinition): void {
  if (!isPlainRecord(definition) || !hasExactOwnKeys(definition, [
    'id', 'channel', 'element', 'baseDamage', 'scaling', 'canCrit',
  ])) throw new TypeError('damage component definition has invalid fields');
  if (typeof definition.id !== 'string' || definition.id.trim().length === 0) {
    throw new TypeError('damage component id must not be empty');
  }
  if (definition.channel !== 'physical' && definition.channel !== 'magical') {
    throw new TypeError('damage channel is invalid');
  }
  if (definition.element !== null
    && (typeof definition.element !== 'string' || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(definition.element))) {
    throw new TypeError('element must be null or a valid code');
  }
  if (definition.scaling !== 'none' && definition.scaling !== 'half' && definition.scaling !== 'full') {
    throw new TypeError('damage scaling is invalid');
  }
  if (typeof definition.canCrit !== 'boolean') throw new TypeError('damage canCrit must be boolean');
  if (typeof definition.baseDamage !== 'number') throw new TypeError('baseDamage must be a number');
  assertNonNegativeInteger(definition.baseDamage, 'baseDamage');
}

function assertRawDamageComponents(components: readonly RawDamageComponent[]): void {
  if (!Array.isArray(components)) throw new TypeError('damage components must be an array');
  if (components.length === 0) throw new RangeError('at least one damage component is required');
  if (components.length > CORE_V1_MAX_DAMAGE_COMPONENTS) {
    throw new RangeError(`damage action must have at most ${CORE_V1_MAX_DAMAGE_COMPONENTS} components`);
  }
  const ids = new Set<string>();
  components.forEach((component, index) => {
    if (!isPlainRecord(component) || !hasExactOwnKeys(component, [
      'id', 'channel', 'element', 'amount', 'canCrit',
    ])) throw new TypeError(`components[${index}] has invalid fields`);
    if (typeof component.id !== 'string' || component.id.trim().length === 0) {
      throw new TypeError(`components[${index}].id must not be empty`);
    }
    if (ids.has(component.id)) throw new RangeError(`duplicate damage component id: ${component.id}`);
    ids.add(component.id);
    if (component.channel !== 'physical' && component.channel !== 'magical') {
      throw new TypeError(`components[${index}].channel is invalid`);
    }
    if (component.element !== null
      && (typeof component.element !== 'string' || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(component.element))) {
      throw new TypeError(`components[${index}].element is invalid`);
    }
    if (typeof component.canCrit !== 'boolean') throw new TypeError(`components[${index}].canCrit must be boolean`);
    if (typeof component.amount !== 'number') throw new TypeError(`components[${index}].amount must be a number`);
    assertNonNegativeInteger(component.amount, `components[${index}].amount`);
  });
}

function assertDamageMitigationMetadata(input: DamageMitigationInput): void {
  if (typeof input.actionHit !== 'boolean') throw new TypeError('actionHit must be boolean');
  if (typeof input.critical !== 'boolean') throw new TypeError('critical must be boolean');
  if (typeof input.completeBlock !== 'boolean') throw new TypeError('completeBlock must be boolean');
  if (!isPlainRecord(input.resistances) || !hasExactOwnKeys(
    input.resistances,
    input.resistances.elementalResistanceBps === undefined
      ? ['physicalResistanceBps', 'magicalResistanceBps']
      : ['physicalResistanceBps', 'magicalResistanceBps', 'elementalResistanceBps'],
  )) throw new TypeError('resistances has invalid fields');
  const elemental = input.resistances.elementalResistanceBps;
  if (elemental !== undefined) {
    if (!isPlainRecord(elemental)) throw new TypeError('elementalResistanceBps must be a plain object');
    for (const [element, resistance] of Object.entries(elemental)) {
      if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(element)) {
        throw new TypeError(`elementalResistanceBps.${element} is invalid`);
      }
      if (typeof resistance !== 'number') throw new TypeError(`elementalResistanceBps.${element} must be a number`);
      assertIntegerInRange(resistance, -5000, 7500, `elementalResistanceBps.${element}`);
    }
  }
  if (input.immunities !== undefined) {
    if (!isPlainRecord(input.immunities)
      || Object.keys(input.immunities).some((key) => ![
        'physical', 'magical', 'elements', 'componentIds',
      ].includes(key))) throw new TypeError('immunities has invalid fields');
    if (input.immunities.physical !== undefined && typeof input.immunities.physical !== 'boolean') {
      throw new TypeError('immunities.physical must be boolean');
    }
    if (input.immunities.magical !== undefined && typeof input.immunities.magical !== 'boolean') {
      throw new TypeError('immunities.magical must be boolean');
    }
    if (input.immunities.elements !== undefined
      && (!Array.isArray(input.immunities.elements)
        || input.immunities.elements.some((element) => typeof element !== 'string'
          || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(element)))) {
      throw new TypeError('immunities.elements must contain valid element codes');
    }
    if (input.immunities.componentIds !== undefined
      && (!Array.isArray(input.immunities.componentIds)
        || input.immunities.componentIds.some((id) => typeof id !== 'string' || id.trim().length === 0))) {
      throw new TypeError('immunities.componentIds must contain non-empty ids');
    }
  }
}

function calculateScalingContribution(actorPower: number, scaling: DamageScaling): number {
  assertNonNegativeInteger(actorPower, 'actorPower');
  if (scaling === 'none') return 0;
  if (scaling === 'half') return Math.floor(actorPower / 2);
  if (scaling === 'full') return actorPower;
  throw new TypeError('damage scaling is invalid');
}

export function basicPhysicalRaw(
  weaponBaseDamage: number,
  actorPhysicalPower: number,
  explicitActionBonuses = 0,
): number {
  assertNonNegativeInteger(weaponBaseDamage, 'weaponBaseDamage');
  assertNonNegativeInteger(actorPhysicalPower, 'actorPhysicalPower');
  assertInteger(explicitActionBonuses, 'explicitActionBonuses');
  return Math.max(0, safeIntegerSum([weaponBaseDamage, actorPhysicalPower, explicitActionBonuses], 'basicPhysicalRaw'));
}

export function weaponSkillRaw(
  weaponBaseDamage: number,
  skillBonusDamage: number,
  actorPhysicalPower: number,
  scaling: DamageScaling,
  explicitActionBonuses = 0,
): number {
  assertNonNegativeInteger(weaponBaseDamage, 'weaponBaseDamage');
  assertNonNegativeInteger(skillBonusDamage, 'skillBonusDamage');
  assertInteger(explicitActionBonuses, 'explicitActionBonuses');
  return Math.max(0, safeIntegerSum([
    weaponBaseDamage, skillBonusDamage, calculateScalingContribution(actorPhysicalPower, scaling), explicitActionBonuses,
  ], 'weaponSkillRaw'));
}

export function spellRaw(
  spellBaseDamage: number,
  actorMagicalPower: number,
  scaling: DamageScaling,
  individualSpellRank: number,
  explicitActionBonuses = 0,
): number {
  assertNonNegativeInteger(spellBaseDamage, 'spellBaseDamage');
  assertIntegerInRange(individualSpellRank, 0, 10, 'individualSpellRank');
  assertInteger(explicitActionBonuses, 'explicitActionBonuses');
  return Math.max(0, safeIntegerSum([
    spellBaseDamage, calculateScalingContribution(actorMagicalPower, scaling),
    Math.floor(individualSpellRank / 2), explicitActionBonuses,
  ], 'spellRaw'));
}

export function createRawDamageComponent(
  definition: DamageComponentDefinition,
  actorPower: number,
  explicitActionBonuses = 0,
): RawDamageComponent {
  assertDamageComponentDefinition(definition);
  assertInteger(explicitActionBonuses, 'explicitActionBonuses');
  return {
    id: definition.id,
    channel: definition.channel,
    element: definition.element,
    amount: Math.max(0, safeIntegerSum([
      definition.baseDamage, calculateScalingContribution(actorPower, definition.scaling), explicitActionBonuses,
    ], 'damageComponentRaw')),
    canCrit: definition.canCrit,
  };
}

export function addDamageEffect(
  components: readonly RawDamageComponent[],
  effect: DamageComponentDefinition,
  actorPower: number,
  explicitActionBonuses = 0,
): RawDamageComponent[] {
  if (components.length >= CORE_V1_MAX_DAMAGE_COMPONENTS) {
    throw new RangeError(`damage action must have at most ${CORE_V1_MAX_DAMAGE_COMPONENTS} components`);
  }
  const result = [...components, createRawDamageComponent(effect, actorPower, explicitActionBonuses)];
  assertRawDamageComponents(result);
  return result;
}

function isImmune(component: RawDamageComponent, immunities: DamageImmunities | undefined): boolean {
  if (immunities === undefined) return false;
  if (component.channel === 'physical' && immunities.physical === true) return true;
  if (component.channel === 'magical' && immunities.magical === true) return true;
  if (component.element !== null && immunities.elements?.includes(component.element) === true) return true;
  return immunities.componentIds?.includes(component.id) === true;
}

function distributeTotalByLargestRemainder(amounts: readonly number[], targetTotal: number): number[] {
  amounts.forEach((amount, index) => assertNonNegativeInteger(amount, `amounts[${index}]`));
  assertNonNegativeInteger(targetTotal, 'targetTotal');
  const sourceTotal = safeIntegerSum(amounts, 'damage source total');
  if (sourceTotal === 0 || targetTotal === 0) return amounts.map(() => 0);
  if (targetTotal > sourceTotal) throw new RangeError('targetTotal must not exceed source total');

  const allocations = amounts.map((amount, index) => {
    const product = safeIntegerMultiply(amount, targetTotal, 'damage allocation product');
    return { index, value: Math.floor(product / sourceTotal), remainder: product % sourceTotal };
  });
  let unallocated = targetTotal - safeIntegerSum(allocations.map((item) => item.value), 'allocated damage total');
  const ranked = [...allocations].sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const item of ranked) {
    if (unallocated === 0) break;
    const allocation = allocations[item.index];
    if (allocation === undefined) throw new RangeError('damage allocation index is invalid');
    allocation.value += 1;
    unallocated -= 1;
  }
  return allocations.map((item) => item.value);
}

function applyFlatReductionByChannel(
  components: readonly MitigatedDamageComponent[],
  channel: DamageChannel,
  defense: number,
): MitigatedDamageComponent[] {
  assertNonNegativeInteger(defense, `${channel}FlatDefense`);
  const channelComponents = components.filter((component) => component.channel === channel);
  const total = safeIntegerSum(channelComponents.map((component) => component.afterCritical), `${channel} damage total`);
  const targetTotal = Math.max(0, total - defense);
  const allocations = distributeTotalByLargestRemainder(channelComponents.map((component) => component.afterCritical), targetTotal);
  let allocationIndex = 0;
  return components.map((component) => {
    if (component.channel !== channel) return component;
    const afterFlatDefense = allocations[allocationIndex] ?? 0;
    allocationIndex += 1;
    return { ...component, afterFlatDefense, afterBlock: afterFlatDefense };
  });
}

function applyBlock(components: readonly MitigatedDamageComponent[], blockValue: number): MitigatedDamageComponent[] {
  assertNonNegativeInteger(blockValue, 'blockValue');
  const total = safeIntegerSum(components.map((component) => component.afterFlatDefense), 'block damage total');
  const targetTotal = Math.max(0, total - blockValue);
  const allocations = distributeTotalByLargestRemainder(components.map((component) => component.afterFlatDefense), targetTotal);
  return components.map((component, index) => ({ ...component, afterBlock: allocations[index] ?? 0 }));
}

function applyResistance(amount: number, resistanceBps: number, maximum: number, name: string): number {
  assertIntegerInRange(resistanceBps, -5000, maximum, name);
  const product = safeIntegerMultiply(amount, 10000 - resistanceBps, `${name} product`);
  return roundHalfUp(product / 10000);
}

export function mitigateDamage(input: DamageMitigationInput): DamageMitigationResult {
  assertRawDamageComponents(input.components);
  assertDamageMitigationMetadata(input);
  assertIntegerInRange(input.criticalDamageBps, 15000, 22000, 'criticalDamageBps');
  assertNonNegativeInteger(input.physicalFlatDefense, 'physicalFlatDefense');
  assertNonNegativeInteger(input.magicalFlatDefense, 'magicalFlatDefense');
  assertNonNegativeInteger(input.blockValue, 'blockValue');
  assertIntegerInRange(input.resistances.physicalResistanceBps, -5000, 4000, 'physicalResistanceBps');
  assertIntegerInRange(input.resistances.magicalResistanceBps, -5000, 4000, 'magicalResistanceBps');

  if (!input.actionHit) return { totalDamage: 0, components: [], appliedMinimumDamage: false, completeBlock: false };

  const active = input.components.filter((component) => !isImmune(component, input.immunities));
  let components: MitigatedDamageComponent[] = active.map((component) => {
    const afterCritical = input.critical && component.canCrit
      ? (() => {
        const product = safeIntegerMultiply(component.amount, input.criticalDamageBps, 'critical damage product');
        return roundHalfUp(product / 10000);
      })()
      : component.amount;
    return {
      id: component.id,
      channel: component.channel,
      element: component.element,
      afterCritical,
      afterFlatDefense: afterCritical,
      afterBlock: afterCritical,
      finalDamage: 0,
    };
  });

  if (active.length === 0) return { totalDamage: 0, components, appliedMinimumDamage: false, completeBlock: false };
  components = applyFlatReductionByChannel(components, 'physical', input.physicalFlatDefense);
  components = applyFlatReductionByChannel(components, 'magical', input.magicalFlatDefense);

  const totalBeforeBlock = safeIntegerSum(components.map((component) => component.afterFlatDefense), 'pre-block damage total');
  const blockAbsorbsAllDamage = totalBeforeBlock > 0 && input.blockValue >= totalBeforeBlock;
  if (input.completeBlock || blockAbsorbsAllDamage) {
    return {
      totalDamage: 0,
      components: components.map((component) => ({ ...component, afterBlock: 0, finalDamage: 0 })),
      appliedMinimumDamage: false,
      completeBlock: true,
    };
  }

  components = applyBlock(components, input.blockValue).map((component) => {
    const channelResistance = component.channel === 'physical'
      ? input.resistances.physicalResistanceBps
      : input.resistances.magicalResistanceBps;
    let finalDamage = applyResistance(component.afterBlock, channelResistance, 4000, `${component.channel}ResistanceBps`);
    if (component.element !== null) {
      const elementalResistance = input.resistances.elementalResistanceBps?.[component.element] ?? 0;
      finalDamage = applyResistance(finalDamage, elementalResistance, 7500, `elementalResistanceBps.${component.element}`);
    }
    return { ...component, finalDamage };
  });

  const calculatedTotal = safeIntegerSum(components.map((component) => component.finalDamage), 'final damage total');
  const appliedMinimumDamage = calculatedTotal === 0;
  return {
    totalDamage: appliedMinimumDamage ? 1 : calculatedTotal,
    components,
    appliedMinimumDamage,
    completeBlock: false,
  };
}
