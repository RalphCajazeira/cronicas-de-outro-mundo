import { describe, expect, it } from 'vitest';
import { CORE_V1_CONFIG_HASH } from './core-v1.manifest.js';
import {
  CORE_V1_2_CONFIG_CANONICAL_JSON,
  CORE_V1_2_CONFIG_HASH,
  CORE_V1_2_CONFIG_SNAPSHOT,
} from './core-v1.progression-v2.manifest.js';
import {
  CORE_V1_2_TECHNICAL_ATTRIBUTE_MAXIMUM,
  CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
  CORE_V1_2_XP_STORAGE_MAXIMUM,
  coreV12EarnedAttributePoints,
  nextCoreV12LevelXp,
} from './core-v1.progression-v2.js';

describe('core RC1.2 unbounded progression publication', () => {
  it('preserves the immutable RC1.1 hash and publishes a stable distinct hash', () => {
    expect(CORE_V1_CONFIG_HASH).toBe('2cfe9c45585ef51f3a06f2c9dc11e5cd6a5274d3eb77f96271daf2613fc1e4df');
    expect(CORE_V1_2_CONFIG_HASH).toBe('bc683f8126cac6c3dfc11adbcfc0923174905cd7d7d6ac7c974e0a316643782f');
    expect(CORE_V1_2_CONFIG_HASH).not.toBe(CORE_V1_CONFIG_HASH);
    expect(CORE_V1_2_CONFIG_CANONICAL_JSON).toContain('"gameplayLevelCap":null');
    expect(CORE_V1_2_CONFIG_CANONICAL_JSON).toContain('"effectiveGameplayCap":null');
  });

  it('declares ten points per level and no gameplay caps', () => {
    expect(CORE_V1_2_CONFIG_SNAPSHOT.progression.gameplayLevelCap).toBeNull();
    expect(CORE_V1_2_CONFIG_SNAPSHOT.attributes.effectiveGameplayCap).toBeNull();
    expect(CORE_V1_2_CONFIG_SNAPSHOT.attributes.progressionPointsPerAdditionalLevel).toBe(10);
    expect(CORE_V1_2_CONFIG_SNAPSHOT.technicalEnvelope.maximumRepresentablePrimaryAttribute)
      .toBe(CORE_V1_2_TECHNICAL_ATTRIBUTE_MAXIMUM);
    expect(CORE_V1_2_CONFIG_SNAPSHOT.technicalEnvelope.gameplayLimit).toBe(false);
  });

  it.each([
    [20, 190],
    [21, 200],
    [50, 490],
    [100, 990],
  ])('derives progression entitlement for level %i', (level, points) => {
    expect(coreV12EarnedAttributePoints(level)).toBe(points);
  });

  it('continues the existing XP formula beyond level 20 with overflow protection', () => {
    expect(nextCoreV12LevelXp(20)).toBe(2_570);
    expect(nextCoreV12LevelXp(50)).toBe(13_820);
    expect(nextCoreV12LevelXp(100)).toBe(52_570);
    expect(nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM - 1)).toBe(2_147_317_300);
    expect(nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM - 1))
      .toBeLessThanOrEqual(CORE_V1_2_XP_STORAGE_MAXIMUM);
    expect(nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM)).toBeNull();
    expect(() => nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM + 1)).toThrow();
  });
});
