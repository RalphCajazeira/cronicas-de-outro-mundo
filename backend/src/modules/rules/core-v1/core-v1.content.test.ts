import { describe, expect, it } from 'vitest';
import {
  CORE_V1_MASTERY_XP,
  attributeXpToNext,
  campaignMilestoneXp,
  equivalentCombatXp,
  explorationXp,
  getHybridCost,
  getManaCostBand,
  getSpCostBand,
  getTierDamageEnvelope,
  majorObjectiveXp,
  masteryProgressBps,
  maxBankedXp,
  maxProficiencyRankForLevel,
  minorObjectiveXp,
  nextLevelXp,
  npcBaseThreatBps,
  npcInventoryLimits,
  npcPrimaryAttributeBudget,
  npcResourceMultipliers,
  proficiencyXpToNextRank,
  validateAreaDamageProposal,
  validateCost,
  validateTierBaseDamage,
} from './index.js';
import type { NpcRole } from './index.js';
import {
  CORE_V1_NPC_INVENTORY_LIMITS,
  CORE_V1_NPC_RESOURCE_MULTIPLIERS,
  CORE_V1_TIER_DAMAGE_ENVELOPES,
} from './core-v1.config.js';

describe('core-v1 tier envelopes and area limits', () => {
  const envelopes = [
    [1, 3, 10], [2, 5, 12], [3, 7, 16], [4, 10, 19], [5, 13, 24],
    [6, 16, 28], [7, 20, 33], [8, 24, 38], [9, 29, 43], [10, 34, 50],
  ] as const;

  it.each(envelopes)('validates the tier %i envelope', (tier, minimum, maximum) => {
    expect(getTierDamageEnvelope(tier)).toEqual({ minimum, maximum });
    expect(validateTierBaseDamage(tier, minimum).ok).toBe(true);
    expect(validateTierBaseDamage(tier, maximum).ok).toBe(true);
    expect(validateTierBaseDamage(tier, minimum - 1).ok).toBe(false);
    expect(validateTierBaseDamage(tier, maximum + 1).ok).toBe(false);
  });

  it('rejects non-integer damage and invalid tiers', () => {
    expect(validateTierBaseDamage(1, 4.5).ok).toBe(false);
    expect(() => getTierDamageEnvelope(0)).toThrow('tier must be between 1 and 10');
  });

  it('returns defensive tier copies and keeps versioned envelopes frozen', () => {
    const envelope = getTierDamageEnvelope(1);
    envelope.minimum = 999;
    expect(getTierDamageEnvelope(1)).toEqual({ minimum: 3, maximum: 10 });
    expect(Object.isFrozen(CORE_V1_TIER_DAMAGE_ENVELOPES)).toBe(true);
    expect(Object.isFrozen(CORE_V1_TIER_DAMAGE_ENVELOPES[1])).toBe(true);
    expect(() => {
      (CORE_V1_TIER_DAMAGE_ENVELOPES[1] as unknown as { minimum: number }).minimum = 999;
    }).toThrow(TypeError);
    expect(getTierDamageEnvelope(1).minimum).toBe(3);
  });

  it('enforces both area damage caps', () => {
    expect(validateAreaDamageProposal({ singleTargetEquivalentDamage: 10, perTargetExpectedDamage: 6, expectedTargetCount: 2 }).ok).toBe(true);
    expect(validateAreaDamageProposal({ singleTargetEquivalentDamage: 10, perTargetExpectedDamage: 7, expectedTargetCount: 2 }).ok).toBe(false);
    expect(validateAreaDamageProposal({ singleTargetEquivalentDamage: 10, perTargetExpectedDamage: 6, expectedTargetCount: 3 }).ok).toBe(false);
    expect(validateAreaDamageProposal({
      singleTargetEquivalentDamage: Number.MAX_SAFE_INTEGER,
      perTargetExpectedDamage: Number.MAX_SAFE_INTEGER,
      expectedTargetCount: 2,
    }).ok).toBe(false);
    expect(validateAreaDamageProposal({
      singleTargetEquivalentDamage: 10, perTargetExpectedDamage: 6, expectedTargetCount: 2, extra: true,
    }).ok).toBe(false);
    expect(validateAreaDamageProposal({
      singleTargetEquivalentDamage: 10.5, perTargetExpectedDamage: 6, expectedTargetCount: 2,
    }).ok).toBe(false);
    expect(validateAreaDamageProposal(null).ok).toBe(false);
  });
});

describe('core-v1 costs', () => {
  it('builds approved tier 1 and tier 10 bands', () => {
    expect(getManaCostBand(1)).toEqual({ minimum: 3, standard: 6, maximum: 9 });
    expect(getManaCostBand(10)).toEqual({ minimum: 12, standard: 24, maximum: 36 });
    expect(getSpCostBand(1)).toEqual({ minimum: 3, standard: 4, maximum: 6 });
    expect(getSpCostBand(10)).toEqual({ minimum: 7, standard: 13, maximum: 24 });
    expect(getHybridCost(1)).toEqual({ mana: 4, sp: 3 });
    expect(getHybridCost(10)).toEqual({ mana: 15, sp: 8 });
  });

  it.each([1, 3, 5, 7, 10])('accepts approved costs at tier %i', (tier) => {
    const mana = getManaCostBand(tier);
    const sp = getSpCostBand(tier);
    const hybrid = getHybridCost(tier);
    expect(validateCost(tier, { type: 'mana', amount: mana.standard }).ok).toBe(true);
    expect(validateCost(tier, { type: 'sp', amount: sp.standard }).ok).toBe(true);
    expect(validateCost(tier, { type: 'hybrid', ...hybrid }).ok).toBe(true);
    expect(validateCost(tier, { type: 'active_defense', sp: 1 + Math.ceil(tier / 2) }).ok).toBe(true);
    expect(validateCost(tier, { type: 'special_dodge', sp: 2 + Math.ceil(tier / 2) }).ok).toBe(true);
    expect(validateCost(tier, { type: 'maintenance', resource: 'mana', activationCost: mana.standard, amount: Math.ceil(mana.standard / 4) }).ok).toBe(true);
    expect(validateCost(tier, { type: 'hp', percentBps: (2 + tier) * 100 }).ok).toBe(true);
    expect(validateCost(tier, { type: 'none' }).ok).toBe(true);
    expect(validateCost(tier, { type: 'custom', resourceRef: 'rage_points', amount: 2 }).ok).toBe(true);
  });

  it('rejects out-of-band, malformed and unsupported cost values', () => {
    expect(validateCost(1, { type: 'mana', amount: 2 }).ok).toBe(false);
    expect(validateCost(1, { type: 'sp', amount: 7 }).ok).toBe(false);
    expect(validateCost(1, { type: 'hybrid', mana: 3, sp: 3 }).ok).toBe(false);
    expect(validateCost(1, { type: 'maintenance', resource: 'sp', activationCost: 8, amount: 1 }).ok).toBe(false);
    expect(validateCost(1, { type: 'hp', percentBps: 200 }).ok).toBe(false);
    expect(validateCost(1, { type: 'custom', resourceRef: 'Not Valid', amount: 1 }).ok).toBe(false);
    expect(validateCost(1, { type: 'custom', resourceRef: 'rage', amount: 0 }).ok).toBe(false);
    expect(validateCost(1, { type: 'mana', amount: 3.5 }).ok).toBe(false);
    expect(validateCost(1, { type: 'hybrid', mana: 4.5, sp: 3 }).ok).toBe(false);
    expect(validateCost(1, { type: 'none', amount: 0 }).ok).toBe(false);
    expect(validateCost(1, { type: 'hp', amount: 300 }).ok).toBe(false);
    expect(validateCost(1, { type: 'maintenance', resource: 'custom', activationCost: 8, amount: 2 }).ok).toBe(false);
    expect(validateCost(1, { type: 'custom', resourceRef: 'rage', amount: 1, note: 'gpt' }).ok).toBe(false);
    expect(validateCost(1, null).ok).toBe(false);
    expect(validateCost(1, []).ok).toBe(false);
    expect(() => validateCost(0, { type: 'none' })).toThrow('tier must be between 1 and 10');
  });
});

describe('core-v1 progression curves', () => {
  it('calculates every level transition from 1 through the level 20 cap', () => {
    for (let level = 1; level <= 20; level += 1) {
      const expected = level === 20 ? null : 100 + 35 * (level - 1) + 5 * (level - 1) ** 2;
      expect(nextLevelXp(level)).toBe(expected);
    }
    expect(() => nextLevelXp(0)).toThrow('level must be between 1 and 20');
    expect(() => nextLevelXp(21)).toThrow('level must be between 1 and 20');
  });

  it('calculates combat, exploration and objective XP from backend-owned inputs', () => {
    expect(equivalentCombatXp(1, 1)).toBe(20);
    expect(equivalentCombatXp(10, 19)).toBe(308);
    expect(explorationXp(10, 19)).toBe(154);
    expect(minorObjectiveXp(10, 19)).toBe(308);
    expect(majorObjectiveXp(10, 19)).toBe(924);
    expect(campaignMilestoneXp(10, 19)).toBe(1540);
  });

  it.each([
    [10, 120], [19, 228], [20, 600], [29, 1740], [30, null],
  ])('calculates attribute XP %i -> next as %s', (attribute, expected) => {
    expect(attributeXpToNext(attribute)).toBe(expected);
  });

  it('keeps progression curves monotonic and rejects invalid bounds', () => {
    let previousLevelXp = 0;
    for (let level = 1; level < 20; level += 1) {
      const threshold = nextLevelXp(level);
      expect(threshold).not.toBeNull();
      expect(threshold as number).toBeGreaterThan(previousLevelXp);
      previousLevelXp = threshold as number;
    }
    let previousAttributeXp = 0;
    for (let attribute = 1; attribute < 30; attribute += 1) {
      const threshold = attributeXpToNext(attribute);
      expect(threshold).not.toBeNull();
      expect(threshold as number).toBeGreaterThan(previousAttributeXp);
      previousAttributeXp = threshold as number;
    }
    expect(() => attributeXpToNext(0)).toThrow('currentAttribute must be between 1 and 30');
    expect(() => proficiencyXpToNextRank(-1)).toThrow('currentRank must be between 0 and 10');
    expect(() => proficiencyXpToNextRank(11)).toThrow('currentRank must be between 0 and 10');
    expect(() => masteryProgressBps(-1)).toThrow('masteryXp must be between 0');
    expect(() => masteryProgressBps(Number.MAX_SAFE_INTEGER + 1)).toThrow('safe number range');
  });

  it('calculates ranks 0 through 10, banked XP and mastery', () => {
    for (let rank = 0; rank <= 10; rank += 1) {
      const threshold = rank === 10 ? null : 20 * (rank + 1);
      expect(proficiencyXpToNextRank(rank)).toBe(threshold);
      expect(maxBankedXp(rank)).toBe(threshold === null ? 0 : Math.floor(threshold / 2));
    }
    expect(CORE_V1_MASTERY_XP).toBe(2000);
    expect(masteryProgressBps(0)).toBe(0);
    expect(masteryProgressBps(1000)).toBe(5000);
    expect(masteryProgressBps(2000)).toBe(10000);
    expect(masteryProgressBps(3000)).toBe(10000);
  });

  it.each([
    [1, 2], [3, 3], [5, 4], [7, 5], [17, 10], [20, 10],
  ])('caps proficiency at rank %i for level %i', (level, expected) => {
    expect(maxProficiencyRankForLevel(level)).toBe(expected);
  });
});

describe('core-v1 NPC role configuration', () => {
  const expectedBudgets: Record<number, Record<NpcRole, number>> = {
    1: { minion: 72, standard: 81, elite: 99, boss: 108 },
    3: { minion: 80, standard: 91, elite: 111, boss: 122 },
    5: { minion: 88, standard: 101, elite: 123, boss: 136 },
    7: { minion: 96, standard: 111, elite: 135, boss: 150 },
    10: { minion: 108, standard: 126, elite: 153, boss: 171 },
  };
  const threatMultipliers = { minion: 2500, standard: 10000, elite: 20000, boss: 40000 } as const;

  it.each([1, 3, 5, 7, 10])('calculates budgets and base threat at tier %i', (tier) => {
    for (const role of ['minion', 'standard', 'elite', 'boss'] as const) {
      expect(npcPrimaryAttributeBudget(role, tier)).toBe(expectedBudgets[tier]?.[role]);
      expect(npcBaseThreatBps(role, tier)).toBe(threatMultipliers[role] * tier * tier);
    }
  });

  it('exposes versioned resource and inventory limits without persistence', () => {
    expect(npcResourceMultipliers('minion')).toEqual({ hpBps: 3000, manaBps: 5000, spBps: 5000 });
    expect(npcResourceMultipliers('boss')).toEqual({ hpBps: 25000, manaBps: 17500, spBps: 17500 });
    expect(npcInventoryLimits('minion')).toEqual({ maxEntries: 2, maxConsumableEntries: 0 });
    expect(npcInventoryLimits('boss')).toEqual({ maxEntries: 20, maxConsumableEntries: 5 });
  });

  it('returns defensive NPC copies and keeps provisional configuration frozen', () => {
    const resources = npcResourceMultipliers('minion');
    const limits = npcInventoryLimits('minion');
    resources.hpBps = 9999;
    limits.maxEntries = 999;
    expect(npcResourceMultipliers('minion').hpBps).toBe(3000);
    expect(npcInventoryLimits('minion').maxEntries).toBe(2);
    expect(Object.isFrozen(CORE_V1_NPC_RESOURCE_MULTIPLIERS.minion)).toBe(true);
    expect(Object.isFrozen(CORE_V1_NPC_INVENTORY_LIMITS.minion)).toBe(true);
    expect(() => {
      (CORE_V1_NPC_RESOURCE_MULTIPLIERS.minion as unknown as { hpBps: number }).hpBps = 9999;
    }).toThrow(TypeError);
    expect(() => {
      (CORE_V1_NPC_INVENTORY_LIMITS.minion as unknown as { maxEntries: number }).maxEntries = 999;
    }).toThrow(TypeError);
    expect(npcResourceMultipliers('minion').hpBps).toBe(3000);
    expect(npcInventoryLimits('minion').maxEntries).toBe(2);
  });
});
