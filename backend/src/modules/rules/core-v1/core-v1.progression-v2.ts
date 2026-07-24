import { assertIntegerInRange, safeIntegerMultiply } from './core-v1.math.js';

export const CORE_V1_2_VERSION_CODE = 'core-v1.2' as const;
export const CORE_V1_2_REVISION = 'RC1.2' as const;
export const CORE_V1_2_SCHEMA_VERSION = 1 as const;
export const CORE_V1_2_ATTRIBUTE_POINTS_PER_ADDITIONAL_LEVEL = 10 as const;
export const CORE_V1_2_XP_STORAGE_MAXIMUM = 2_147_483_647 as const;

// PostgreSQL INTEGER stores Actor.xp. This is the highest actor level whose
// preceding transition threshold still fits that storage type.
export const CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM = 20_722 as const;
export const CORE_V1_2_TECHNICAL_ATTRIBUTE_MAXIMUM = 207_226 as const;

export function isCoreV12Level(level: number): boolean {
  return Number.isSafeInteger(level) && level >= 1 && level <= CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM;
}

export function assertCoreV12Level(level: number): void {
  assertIntegerInRange(level, 1, CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM, 'level');
}

export function coreV12EarnedAttributePoints(level: number): number {
  assertCoreV12Level(level);
  return safeIntegerMultiply(
    CORE_V1_2_ATTRIBUTE_POINTS_PER_ADDITIONAL_LEVEL,
    level - 1,
    'earnedAttributePoints',
  );
}

export function nextCoreV12LevelXp(level: number): number | null {
  assertCoreV12Level(level);
  if (level === CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM) return null;
  const offset = level - 1;
  const threshold = 100 + 35 * offset + 5 * offset * offset;
  if (!Number.isSafeInteger(threshold) || threshold > CORE_V1_2_XP_STORAGE_MAXIMUM) {
    throw new RangeError('next level XP exceeds the Actor.xp technical storage range');
  }
  return threshold;
}
