import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { manageActorProgressionSchema, progressionPrimaryAttributesSchema } from '../gpt/gpt.schemas.js';
import {
  CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
  nextCoreV12LevelXp,
} from '../rules/core-v1/index.js';
import {
  actorProgressionPolicy,
  emptyProgressionPrimaryAttributes,
  validateActorProgressionAttributes,
} from './actor-mechanics.service.js';
import { mapActorProgressionUniqueConflict } from './actor-progression.service.js';

const base = {
  strength: 10,
  vitality: 10,
  agility: 10,
  dexterity: 10,
  intelligence: 10,
  wisdom: 10,
  perception: 10,
  willpower: 10,
  luck: 10,
};
const scope = { playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign', actorRef: 'hero' };

function progression(overrides: Partial<typeof base> = {}) {
  return { ...emptyProgressionPrimaryAttributes(), ...overrides };
}

describe('actor progression attribute entitlement', () => {
  it('accepts level 1 with exactly 90 base points and no progression gains', () => {
    const result = validateActorProgressionAttributes(base, progression(), 1);
    expect(result).toMatchObject({
      ok: true,
      value: {
        attributePointsEarned: 0,
        attributePointsAllocated: 0,
        attributePointsAvailable: 0,
        totalAttributeEntitlement: 90,
      },
    });
  });

  it.each([
    [{ ...base, luck: 9 }, 89],
    [{ ...base, luck: 11 }, 91],
  ])('rejects a base distribution totaling %s instead of 90', (invalidBase, total) => {
    const result = validateActorProgressionAttributes(invalidBase, progression(), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'INITIAL_ATTRIBUTE_BUDGET', received: { total } }),
    ]));
  });

  it('rejects progression gains at level 1', () => {
    const result = validateActorProgressionAttributes(base, progression({ intelligence: 1 }), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'ATTRIBUTE_POINTS_EXCEEDED' }),
    ]));
  });

  it.each([
    [2, 10, 100],
    [5, 40, 130],
    [20, 190, 280],
  ])('derives level %i entitlement as %i earned and %i total', (level, earned, total) => {
    const result = validateActorProgressionAttributes(base, progression(), level);
    expect(result).toMatchObject({
      ok: true,
      value: {
        attributePointsEarned: earned,
        attributePointsAvailable: earned,
        totalAttributeEntitlement: total,
      },
    });
  });

  it('allows effective attributes above the initial creation cap of 16', () => {
    const specializedBase = { ...base, strength: 16, luck: 4 };
    const result = validateActorProgressionAttributes(specializedBase, progression({ strength: 5 }), 2);
    expect(result).toMatchObject({
      ok: true,
      value: { effectivePrimaryAttributes: { strength: 21 } },
    });
  });

  it('accepts a level 5 NPC with all 40 progression points allocated', () => {
    const result = validateActorProgressionAttributes(base, progression({
      strength: 5, vitality: 5, agility: 5, dexterity: 5,
      intelligence: 5, wisdom: 5, perception: 5, willpower: 5,
    }), 5);
    expect(result).toMatchObject({
      ok: true,
      value: { attributePointsAllocated: 40, attributePointsAvailable: 0 },
    });
  });

  it('accepts a level 5 NPC with only part of its progression allocated', () => {
    const result = validateActorProgressionAttributes(base, progression({ intelligence: 10, wisdom: 5 }), 5);
    expect(result).toMatchObject({
      ok: true,
      value: { attributePointsAllocated: 15, attributePointsAvailable: 25 },
    });
  });

  it('rejects gains above the entitlement for the actor level', () => {
    const result = validateActorProgressionAttributes(base, progression({
      strength: 6, vitality: 5, agility: 5, dexterity: 5,
      intelligence: 5, wisdom: 5, perception: 5, willpower: 5,
    }), 5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'ATTRIBUTE_POINTS_EXCEEDED', expected: 40, received: 41 }),
    ]));
  });

  it('reuses the versioned effective cap instead of creating a second cap', () => {
    const specializedBase = { ...base, strength: 16, luck: 4 };
    const result = validateActorProgressionAttributes(specializedBase, progression({ strength: 15 }), 20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'ATTRIBUTE_EFFECTIVE_CAP', expected: 30, received: 31 }),
    ]));
  });

  it.each([
    [21, 200, 290],
    [50, 490, 580],
    [100, 990, 1_080],
  ])('supports unbounded progression level %i with %i earned and %i total points', (level, earned, total) => {
    const result = validateActorProgressionAttributes(base, progression(), level, 'unbounded_core_v1_2');
    expect(result).toMatchObject({
      ok: true,
      value: {
        attributePointsEarned: earned,
        attributePointsAvailable: earned,
        totalAttributeEntitlement: total,
      },
    });
  });

  it('can allocate every high-level point to one attribute without a fixed effective cap', () => {
    const result = validateActorProgressionAttributes(
      base,
      progression({ intelligence: 990 }),
      100,
      'unbounded_core_v1_2',
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        effectivePrimaryAttributes: { intelligence: 1_000 },
        attributePointsAllocated: 990,
        attributePointsAvailable: 0,
      },
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects technically invalid level %s', (level) => {
    expect(validateActorProgressionAttributes(
      base,
      progression(),
      level,
      'unbounded_core_v1_2',
    ).ok).toBe(false);
  });

  it('rejects unsupported ruleset codes instead of silently applying RC1.1', () => {
    expect(() => actorProgressionPolicy('unsupported-version')).toThrow('not supported');
  });
});

describe('manageActorProgression public schema', () => {
  it('accepts get without technical write fields', () => {
    expect(manageActorProgressionSchema.safeParse({ ...scope, operation: 'get' }).success).toBe(true);
    expect(manageActorProgressionSchema.safeParse({
      ...scope, operation: 'get', idempotencyKey: 'forbidden-get',
    }).success).toBe(false);
  });

  it('requires optimistic concurrency and idempotency for every write', () => {
    expect(manageActorProgressionSchema.safeParse({
      ...scope, operation: 'allocate_attributes', attributeDeltas: { intelligence: 5 },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...scope,
      operation: 'allocate_attributes',
      idempotencyKey: 'allocate-attributes-001',
      expectedMechanicsStateVersion: 1,
      attributeDeltas: { intelligence: 5 },
    }).success).toBe(true);
  });

  it('rejects unknown attributes and an all-zero allocation', () => {
    const common = {
      ...scope,
      operation: 'allocate_attributes',
      idempotencyKey: 'allocate-attributes-002',
      expectedMechanicsStateVersion: 1,
    };
    expect(manageActorProgressionSchema.safeParse({
      ...common, attributeDeltas: { courage: 1 },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...common, attributeDeltas: { strength: 0 },
    }).success).toBe(false);
  });

  it('requires a reason and at least one correction field for set_progression_state', () => {
    const common = {
      ...scope,
      operation: 'set_progression_state',
      idempotencyKey: 'correct-progression-001',
      expectedMechanicsStateVersion: 1,
    };
    expect(manageActorProgressionSchema.safeParse({ ...common, level: 5 }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({ ...common, reason: 'Corrigir ficha importada.' }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...common, reason: 'Corrigir ficha importada.', level: 5,
    }).success).toBe(true);
  });

  it('requires all nine fields in a closed progression state', () => {
    expect(progressionPrimaryAttributesSchema.safeParse(progression()).success).toBe(true);
    expect(progressionPrimaryAttributesSchema.safeParse({ strength: 1 }).success).toBe(false);
    expect(progressionPrimaryAttributesSchema.safeParse({ ...progression(), courage: 1 }).success).toBe(false);
  });

  it('requires an auditable reason for XP grants and forbids client-derived fields', () => {
    const grant = {
      ...scope,
      operation: 'grant_xp',
      idempotencyKey: 'grant-xp-schema-001',
      expectedMechanicsStateVersion: 1,
      xpAmount: 100,
      source: { type: 'event', ref: 'objective-one' },
      reason: 'Objetivo concluído.',
    };
    expect(manageActorProgressionSchema.safeParse(grant).success).toBe(true);
    expect(manageActorProgressionSchema.safeParse({ ...grant, reason: undefined }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({ ...grant, source: undefined }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...grant, source: { type: 'loot', ref: 'unsupported-source' },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...grant, source: { type: 'manual', ref: 'manual-one', extra: true },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...grant, source: { type: 'manual', ref: '' },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({
      ...grant, source: { type: 'manual', ref: 'not a code' },
    }).success).toBe(false);
    expect(manageActorProgressionSchema.safeParse({ ...grant, attributePointsAvailable: 10 }).success).toBe(false);
  });

  it('uses the official pure XP policy for level thresholds', () => {
    expect(nextCoreV12LevelXp(1)).toBe(100);
    expect(nextCoreV12LevelXp(2)).toBe(140);
    expect(nextCoreV12LevelXp(20)).toBe(2_570);
    expect(nextCoreV12LevelXp(50)).toBe(13_820);
    expect(nextCoreV12LevelXp(100)).toBe(52_570);
    expect(nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM)).toBeNull();
    expect(() => nextCoreV12LevelXp(CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM + 1)).toThrow();
  });

  it('maps only the semantic XP-source unique index to the stable public error', () => {
    const semantic = new Prisma.PrismaClientKnownRequestError('unique conflict', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'GameEvent',
        target: ['actorId', 'xpSourceType', 'xpSourceRef'],
      },
    });
    expect(mapActorProgressionUniqueConflict(semantic)).toMatchObject({
      statusCode: 409,
      code: 'XP_SOURCE_ALREADY_GRANTED',
      recoveryAction: 'get_actor_progression',
    });
    const unrelated = new Prisma.PrismaClientKnownRequestError('unique conflict', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'GameEvent', target: ['idempotencyKey'] },
    });
    expect(mapActorProgressionUniqueConflict(unrelated)).toBeUndefined();
  });
});
