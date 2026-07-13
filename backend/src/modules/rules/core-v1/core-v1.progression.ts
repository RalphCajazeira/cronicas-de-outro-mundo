import {
  CORE_V1_ATTRIBUTE_HARD_CAP, CORE_V1_ATTRIBUTE_SOFT_CAP, CORE_V1_LEVEL_CAP, CORE_V1_MASTERY_XP,
} from './core-v1.config.js';
import { assertIntegerInRange, clamp, roundHalfUp } from './core-v1.math.js';

export function nextLevelXp(level: number): number | null {
  assertIntegerInRange(level, 1, CORE_V1_LEVEL_CAP, 'level');
  if (level === CORE_V1_LEVEL_CAP) return null;
  const offset = level - 1;
  return 100 + 35 * offset + 5 * offset * offset;
}

export function equivalentCombatXp(opponentTier: number, opponentLevel: number): number {
  assertIntegerInRange(opponentTier, 1, 10, 'opponentTier');
  assertIntegerInRange(opponentLevel, 1, CORE_V1_LEVEL_CAP, 'opponentLevel');
  const tierOffset = opponentTier - 1;
  return 20 + 10 * tierOffset + 2 * tierOffset * tierOffset + 2 * (opponentLevel - 1);
}

export function explorationXp(opponentTier: number, opponentLevel: number): number {
  return roundHalfUp(equivalentCombatXp(opponentTier, opponentLevel) / 2);
}

export function minorObjectiveXp(opponentTier: number, opponentLevel: number): number {
  return equivalentCombatXp(opponentTier, opponentLevel);
}

export function majorObjectiveXp(opponentTier: number, opponentLevel: number): number {
  return 3 * equivalentCombatXp(opponentTier, opponentLevel);
}

export function campaignMilestoneXp(opponentTier: number, opponentLevel: number): number {
  return 5 * equivalentCombatXp(opponentTier, opponentLevel);
}

export function attributeXpToNext(currentAttribute: number): number | null {
  assertIntegerInRange(currentAttribute, 1, CORE_V1_ATTRIBUTE_HARD_CAP, 'currentAttribute');
  if (currentAttribute === CORE_V1_ATTRIBUTE_HARD_CAP) return null;
  if (currentAttribute < CORE_V1_ATTRIBUTE_SOFT_CAP) return 12 * currentAttribute;
  if (currentAttribute < 25) return 30 * currentAttribute;
  return 60 * currentAttribute;
}

export function proficiencyXpToNextRank(currentRank: number): number | null {
  assertIntegerInRange(currentRank, 0, 10, 'currentRank');
  return currentRank === 10 ? null : 20 * (currentRank + 1);
}

export function maxProficiencyRankForLevel(level: number): number {
  assertIntegerInRange(level, 1, CORE_V1_LEVEL_CAP, 'level');
  return Math.min(10, 1 + Math.ceil(level / 2));
}

export function maxBankedXp(currentRank: number): number {
  const threshold = proficiencyXpToNextRank(currentRank);
  return threshold === null ? 0 : Math.floor(threshold / 2);
}

export function masteryProgressBps(masteryXp: number): number {
  assertIntegerInRange(masteryXp, 0, Number.MAX_SAFE_INTEGER, 'masteryXp');
  if (masteryXp >= CORE_V1_MASTERY_XP) return 10000;
  return clamp(0, 10000, roundHalfUp(masteryXp * 10000 / CORE_V1_MASTERY_XP));
}
