import {
  CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS,
  CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS,
  CORE_V1_HYBRID_STANDARD_COST_BPS,
  CORE_V1_NPC_INVENTORY_LIMITS,
  CORE_V1_NPC_RESOURCE_MULTIPLIERS,
  CORE_V1_NPC_THREAT_MULTIPLIER_BPS,
  CORE_V1_TIER_DAMAGE_ENVELOPES,
} from './core-v1.config.js';
import {
  assertIntegerInRange, ceilDiv, hasExactOwnKeys, isPlainRecord, safeIntegerMultiply,
} from './core-v1.math.js';
import type {
  AreaDamageProposal, CoreV1Cost, CostBand, NpcResourceMultipliers, NpcRole, TierDamageEnvelope,
  ValidationResult,
} from './core-v1.types.js';

function valid<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function invalid<T>(path: string, rule: string, message: string, expected?: unknown, received?: unknown): ValidationResult<T> {
  return { ok: false, issues: [{ path, rule, message, expected, received }] };
}

function assertTier(tier: number): void {
  assertIntegerInRange(tier, 1, 10, 'tier');
}

export function getTierDamageEnvelope(tier: number): TierDamageEnvelope {
  assertTier(tier);
  return { ...CORE_V1_TIER_DAMAGE_ENVELOPES[tier as keyof typeof CORE_V1_TIER_DAMAGE_ENVELOPES] };
}

export function validateTierBaseDamage(tier: number, baseDamage: unknown): ValidationResult<number> {
  assertTier(tier);
  const envelope = getTierDamageEnvelope(tier);
  if (typeof baseDamage !== 'number' || !Number.isSafeInteger(baseDamage)) {
    return invalid('baseDamage', 'INTEGER', 'Base damage must be an integer', undefined, baseDamage);
  }
  if (baseDamage < envelope.minimum || baseDamage > envelope.maximum) {
    return invalid('baseDamage', 'TIER_DAMAGE_ENVELOPE', 'Base damage is outside the tier envelope', envelope, baseDamage);
  }
  return valid(baseDamage);
}

export function validateAreaDamageProposal(input: unknown): ValidationResult<AreaDamageProposal> {
  if (!isPlainRecord(input) || !hasExactOwnKeys(input, [
    'singleTargetEquivalentDamage', 'perTargetExpectedDamage', 'expectedTargetCount',
  ])) {
    return invalid('$', 'AREA_DAMAGE_SHAPE', 'Area damage proposal must contain exactly the approved fields');
  }
  if (typeof input.singleTargetEquivalentDamage !== 'number'
    || typeof input.perTargetExpectedDamage !== 'number'
    || typeof input.expectedTargetCount !== 'number') {
    return invalid('$', 'AREA_DAMAGE_INTEGER', 'Area damage proposal values must be integers');
  }
  if (!Number.isSafeInteger(input.singleTargetEquivalentDamage) || input.singleTargetEquivalentDamage < 1
    || !Number.isSafeInteger(input.perTargetExpectedDamage) || input.perTargetExpectedDamage < 0
    || !Number.isSafeInteger(input.expectedTargetCount) || input.expectedTargetCount < 1) {
    return invalid('$', 'AREA_DAMAGE_INTEGER', 'Area damage proposal values must be safe integers in range');
  }
  let perTargetScaled: number;
  let perTargetLimit: number;
  let totalScaled: number;
  let totalLimit: number;
  try {
    perTargetScaled = safeIntegerMultiply(input.perTargetExpectedDamage, 10000, 'area per-target scaled damage');
    perTargetLimit = safeIntegerMultiply(input.singleTargetEquivalentDamage, CORE_V1_AREA_PER_TARGET_DAMAGE_CAP_BPS, 'area per-target limit');
    totalScaled = safeIntegerMultiply(
      safeIntegerMultiply(input.perTargetExpectedDamage, input.expectedTargetCount, 'area total damage'),
      10000,
      'area total scaled damage',
    );
    totalLimit = safeIntegerMultiply(input.singleTargetEquivalentDamage, CORE_V1_AREA_TOTAL_DAMAGE_CAP_BPS, 'area total limit');
  } catch {
    return invalid('$', 'SAFE_INTEGER', 'Area damage calculation must remain within safe integer limits');
  }
  if (perTargetScaled > perTargetLimit) {
    return invalid('perTargetExpectedDamage', 'AREA_PER_TARGET_CAP', 'Area damage per target must not exceed 60% of the single-target equivalent');
  }
  if (totalScaled > totalLimit) {
    return invalid('perTargetExpectedDamage', 'AREA_TOTAL_CAP', 'Expected total area damage must not exceed 150% of the single-target equivalent');
  }
  return valid({
    singleTargetEquivalentDamage: input.singleTargetEquivalentDamage,
    perTargetExpectedDamage: input.perTargetExpectedDamage,
    expectedTargetCount: input.expectedTargetCount,
  });
}

export function getManaCostBand(tier: number): CostBand {
  assertTier(tier);
  return { minimum: 2 + tier, standard: 4 + 2 * tier, maximum: 6 + 3 * tier };
}

export function getSpCostBand(tier: number): CostBand {
  assertTier(tier);
  return { minimum: 2 + Math.ceil(tier / 2), standard: 3 + tier, maximum: 4 + 2 * tier };
}

export function getHybridCost(tier: number): { mana: number; sp: number } {
  const mana = getManaCostBand(tier).standard;
  const sp = getSpCostBand(tier).standard;
  return {
    mana: ceilDiv(safeIntegerMultiply(mana, CORE_V1_HYBRID_STANDARD_COST_BPS, 'hybrid mana cost'), 10000),
    sp: ceilDiv(safeIntegerMultiply(sp, CORE_V1_HYBRID_STANDARD_COST_BPS, 'hybrid SP cost'), 10000),
  };
}

export function validateCost(tier: number, cost: unknown): ValidationResult<CoreV1Cost> {
  assertTier(tier);
  if (!isPlainRecord(cost) || typeof cost.type !== 'string') {
    return invalid('$', 'COST_SHAPE', 'Cost must be a plain object with a supported type');
  }
  if (cost.type === 'none') {
    return hasExactOwnKeys(cost, ['type'])
      ? valid({ type: 'none' })
      : invalid('$', 'COST_FIELDS', 'Cost type none cannot contain other fields');
  }
  if (cost.type === 'mana') {
    if (!hasExactOwnKeys(cost, ['type', 'amount']) || typeof cost.amount !== 'number') {
      return invalid('$', 'COST_FIELDS', 'Mana cost must contain exactly type and amount');
    }
    const band = getManaCostBand(tier);
    return Number.isSafeInteger(cost.amount) && cost.amount >= band.minimum && cost.amount <= band.maximum
      ? valid({ type: 'mana', amount: cost.amount })
      : invalid('amount', 'MANA_COST_BAND', 'Mana cost is outside the approved tier band', band, cost.amount);
  }
  if (cost.type === 'sp') {
    if (!hasExactOwnKeys(cost, ['type', 'amount']) || typeof cost.amount !== 'number') {
      return invalid('$', 'COST_FIELDS', 'SP cost must contain exactly type and amount');
    }
    const band = getSpCostBand(tier);
    return Number.isSafeInteger(cost.amount) && cost.amount >= band.minimum && cost.amount <= band.maximum
      ? valid({ type: 'sp', amount: cost.amount })
      : invalid('amount', 'SP_COST_BAND', 'SP cost is outside the approved tier band', band, cost.amount);
  }
  if (cost.type === 'hybrid') {
    if (!hasExactOwnKeys(cost, ['type', 'mana', 'sp'])
      || typeof cost.mana !== 'number' || typeof cost.sp !== 'number'
      || !Number.isSafeInteger(cost.mana) || !Number.isSafeInteger(cost.sp)) {
      return invalid('$', 'HYBRID_COST', 'Hybrid cost requires exactly safe integer Mana and SP values');
    }
    const expected = getHybridCost(tier);
    return cost.mana === expected.mana && cost.sp === expected.sp
      ? valid({ type: 'hybrid', mana: cost.mana, sp: cost.sp })
      : invalid('$', 'HYBRID_COST', 'Hybrid cost must equal 60% of both standard costs, rounded up', expected, { mana: cost.mana, sp: cost.sp });
  }
  if (cost.type === 'active_defense') {
    if (!hasExactOwnKeys(cost, ['type', 'sp']) || typeof cost.sp !== 'number' || !Number.isSafeInteger(cost.sp)) {
      return invalid('$', 'ACTIVE_DEFENSE_COST', 'Active defense cost requires exactly a safe integer SP value');
    }
    const expected = 1 + Math.ceil(tier / 2);
    return cost.sp === expected
      ? valid({ type: 'active_defense', sp: cost.sp })
      : invalid('sp', 'ACTIVE_DEFENSE_COST', 'Active defense has a fixed tier cost', expected, cost.sp);
  }
  if (cost.type === 'special_dodge') {
    if (!hasExactOwnKeys(cost, ['type', 'sp']) || typeof cost.sp !== 'number' || !Number.isSafeInteger(cost.sp)) {
      return invalid('$', 'SPECIAL_DODGE_COST', 'Special dodge cost requires exactly a safe integer SP value');
    }
    const expected = 2 + Math.ceil(tier / 2);
    return cost.sp === expected
      ? valid({ type: 'special_dodge', sp: cost.sp })
      : invalid('sp', 'SPECIAL_DODGE_COST', 'Special dodge has a fixed tier cost', expected, cost.sp);
  }
  if (cost.type === 'maintenance') {
    if (!hasExactOwnKeys(cost, ['type', 'resource', 'amount', 'activationCost'])
      || (cost.resource !== 'mana' && cost.resource !== 'sp')
      || typeof cost.activationCost !== 'number' || typeof cost.amount !== 'number'
      || !Number.isSafeInteger(cost.activationCost) || cost.activationCost <= 0
      || !Number.isSafeInteger(cost.amount) || cost.amount <= 0) {
      return invalid('$', 'MAINTENANCE_INTEGER', 'Maintenance and activation costs must be positive integers');
    }
    const expected = { minimum: ceilDiv(cost.activationCost, 4), maximum: ceilDiv(cost.activationCost, 2) };
    return cost.amount >= expected.minimum && cost.amount <= expected.maximum
      ? valid({
        type: 'maintenance', resource: cost.resource, amount: cost.amount, activationCost: cost.activationCost,
      })
      : invalid('amount', 'MAINTENANCE_COST', 'Maintenance must be between one quarter and one half of activation cost', expected, cost.amount);
  }
  if (cost.type === 'hp') {
    if (!hasExactOwnKeys(cost, ['type', 'percentBps'])
      || typeof cost.percentBps !== 'number' || !Number.isSafeInteger(cost.percentBps)) {
      return invalid('$', 'HP_COST_BAND', 'HP cost requires exactly an integer percentBps value');
    }
    const expected = { minimum: (2 + tier) * 100, maximum: (5 + 2 * tier) * 100 };
    return cost.percentBps >= expected.minimum && cost.percentBps <= expected.maximum
      ? valid({ type: 'hp', percentBps: cost.percentBps })
      : invalid('percentBps', 'HP_COST_BAND', 'HP cost percentage is outside the approved tier band', expected, cost.percentBps);
  }
  if (cost.type === 'custom') {
    if (!hasExactOwnKeys(cost, ['type', 'resourceRef', 'amount'])
      || typeof cost.resourceRef !== 'string' || typeof cost.amount !== 'number') {
      return invalid('$', 'CUSTOM_COST_REFERENCE', 'Custom cost requires exactly a typed resource reference and an amount');
    }
    const validRef = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(cost.resourceRef);
    return validRef && Number.isSafeInteger(cost.amount) && cost.amount > 0
      ? valid({ type: 'custom', resourceRef: cost.resourceRef, amount: cost.amount })
      : invalid('$', 'CUSTOM_COST_REFERENCE', 'Custom cost requires a typed resource reference and a positive integer amount');
  }
  return invalid('$', 'COST_TYPE', 'Unsupported cost type');
}

export function npcPrimaryAttributeBudget(role: NpcRole, tier: number): number {
  assertTier(tier);
  if (role === 'minion') return 72 + 4 * (tier - 1);
  if (role === 'standard') return 81 + 5 * (tier - 1);
  if (role === 'elite') return 99 + 6 * (tier - 1);
  if (role === 'boss') return 108 + 7 * (tier - 1);
  throw new TypeError('NPC role is invalid');
}

export function npcResourceMultipliers(role: NpcRole): NpcResourceMultipliers {
  const multipliers = CORE_V1_NPC_RESOURCE_MULTIPLIERS[role];
  if (multipliers === undefined) throw new TypeError('NPC role is invalid');
  return { ...multipliers };
}

export function npcBaseThreatBps(role: NpcRole, tier: number): number {
  assertTier(tier);
  const multiplier = CORE_V1_NPC_THREAT_MULTIPLIER_BPS[role];
  if (multiplier === undefined) throw new TypeError('NPC role is invalid');
  return safeIntegerMultiply(safeIntegerMultiply(multiplier, tier, 'NPC base threat'), tier, 'NPC base threat');
}

export function npcInventoryLimits(role: NpcRole): { maxEntries: number; maxConsumableEntries: number } {
  const limits = CORE_V1_NPC_INVENTORY_LIMITS[role];
  if (limits === undefined) throw new TypeError('NPC role is invalid');
  return { ...limits };
}
