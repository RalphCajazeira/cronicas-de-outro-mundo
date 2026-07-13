import { describe, expect, it } from 'vitest';
import { ActorAttributeCode, ActorResourceType } from '../../generated/prisma/client.js';
import {
  CORE_V1_CONFIG_HASH,
  CORE_V1_CONFIG_SNAPSHOT,
  CORE_V1_REVISION,
  CORE_V1_SCHEMA_VERSION,
  CORE_V1_VERSION_CODE,
} from '../rules/core-v1/core-v1.manifest.js';
import {
  calculateResourceMaximums,
  calculateSecondaryAttributes,
  getInitialAttributePreset,
} from '../rules/core-v1/index.js';
import {
  createActorMechanicsInputHash,
  projectActorMechanicalSheet,
} from './actor-mechanics.service.js';

const actorId = '10000000-0000-0000-0000-000000000001';
const rulesetVersionId = '10000000-0000-0000-0000-000000000002';
const now = new Date('2026-07-13T00:00:00.000Z');
const codeMap = {
  strength: ActorAttributeCode.STRENGTH,
  vitality: ActorAttributeCode.VITALITY,
  agility: ActorAttributeCode.AGILITY,
  dexterity: ActorAttributeCode.DEXTERITY,
  intelligence: ActorAttributeCode.INTELLIGENCE,
  wisdom: ActorAttributeCode.WISDOM,
  perception: ActorAttributeCode.PERCEPTION,
  willpower: ActorAttributeCode.WILLPOWER,
  luck: ActorAttributeCode.LUCK,
} as const;

function mechanicalRecord() {
  const primaryAttributes = getInitialAttributePreset('balanced');
  const maximums = calculateResourceMaximums(primaryAttributes, 1);
  const secondary = calculateSecondaryAttributes({
    attributes: primaryAttributes,
    weaponFamilyRank: 0,
    magicSchoolRank: 0,
    accuracyRank: 0,
    evasionRank: 0,
    encumbrancePenalty: 0,
  });
  const inputHash = createActorMechanicsInputHash({
    ruleset: { code: CORE_V1_VERSION_CODE, revision: CORE_V1_REVISION, configHash: CORE_V1_CONFIG_HASH },
    level: 1,
    primaryAttributes,
    calculationInputs: {
      weaponFamilyRank: 0, magicSchoolRank: 0, accuracyRank: 0, evasionRank: 0,
      encumbrancePenalty: 0, modifiers: {},
    },
  });
  return {
    id: actorId,
    level: 1,
    mechanicsStateVersion: 1,
    campaign: {
      rulesetVersionId,
      rulesetVersion: {
        id: rulesetVersionId,
        rulesetId: '10000000-0000-0000-0000-000000000003',
        code: CORE_V1_VERSION_CODE,
        revision: CORE_V1_REVISION,
        schemaVersion: CORE_V1_SCHEMA_VERSION,
        configHash: CORE_V1_CONFIG_HASH,
        configSnapshot: structuredClone(CORE_V1_CONFIG_SNAPSHOT),
        ruleset: { code: 'core' },
      },
    },
    attributes: Object.entries(primaryAttributes).map(([code, baseValue]) => ({
      code: codeMap[code as keyof typeof codeMap], baseValue, earnedValue: 0, xp: 0,
    })),
    resources: [
      { id: '20000000-0000-0000-0000-000000000001', type: ActorResourceType.HP, current: maximums.maxHp, stateVersion: 1 },
      { id: '20000000-0000-0000-0000-000000000002', type: ActorResourceType.MANA, current: maximums.maxMana, stateVersion: 1 },
      { id: '20000000-0000-0000-0000-000000000003', type: ActorResourceType.SP, current: maximums.maxSp, stateVersion: 1 },
    ],
    derivedSnapshot: {
      id: '30000000-0000-0000-0000-000000000001', actorId, rulesetVersionId,
      mechanicsStateVersion: 1, ...maximums,
      actorPhysicalPower: secondary.actorPhysicalPower,
      actorMagicalPower: secondary.actorMagicalPower,
      physicalDefense: secondary.physicalDefense,
      magicalDefense: secondary.magicalDefense,
      accuracy: secondary.accuracy,
      evasion: secondary.evasion,
      baseAttackSpeedBps: secondary.baseAttackSpeedBps,
      baseCastingSpeedBps: secondary.baseCastingSpeedBps,
      criticalChanceBps: secondary.criticalChanceBps,
      criticalDamageBps: secondary.criticalDamageBps,
      movementSpeed: secondary.movementSpeed,
      carryingCapacity: secondary.carryingCapacity,
      physicalResistanceBps: secondary.physicalResistanceBps,
      magicalResistanceBps: secondary.magicalResistanceBps,
      elementalResistanceSnapshot: { default: secondary.elementalResistanceBps },
      hpRegen: secondary.hpRegen,
      manaRegen: secondary.manaRegen,
      spRegen: secondary.spRegen,
      inputHash,
      createdAt: now,
      updatedAt: now,
    },
  };
}

type MechanicalRecord = Parameters<typeof projectActorMechanicalSheet>[0];

function project(record = mechanicalRecord()) {
  return projectActorMechanicalSheet(record as unknown as MechanicalRecord);
}

describe('actor mechanical state', () => {
  it('maps all nine attributes and returns the official public projection without mutating persistence', () => {
    const record = mechanicalRecord();
    const before = JSON.stringify(record);
    const sheet = project(record);
    expect(Object.keys(sheet.primaryAttributes)).toEqual([
      'strength', 'vitality', 'agility', 'dexterity', 'intelligence', 'wisdom', 'perception', 'willpower', 'luck',
    ]);
    expect(sheet.resources.hp.current).toBe(sheet.resources.hp.max);
    expect(sheet.resources.mana.current).toBe(sheet.resources.mana.max);
    expect(sheet.resources.sp.current).toBe(sheet.resources.sp.max);
    expect(sheet).not.toHaveProperty('inputHash');
    expect(sheet).not.toHaveProperty('rulesetVersionId');
    expect(JSON.stringify(record)).toBe(before);
  });

  it('creates a deterministic SHA-256 hash from canonical mechanical inputs', () => {
    const record = mechanicalRecord();
    const sheet = project(record);
    const input = {
      ruleset: { code: CORE_V1_VERSION_CODE, revision: CORE_V1_REVISION, configHash: CORE_V1_CONFIG_HASH },
      level: 1,
      primaryAttributes: sheet.primaryAttributes,
      calculationInputs: {
        weaponFamilyRank: 0 as const, magicSchoolRank: 0 as const, accuracyRank: 0 as const,
        evasionRank: 0 as const, encumbrancePenalty: 0 as const, modifiers: {},
      },
    };
    const hash = createActorMechanicsInputHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(createActorMechanicsInputHash({ ...input, primaryAttributes: { ...input.primaryAttributes } })).toBe(hash);
    expect(createActorMechanicsInputHash({ ...input, level: 2 })).not.toBe(hash);
  });

  it('rejects missing and duplicate attributes or resources', () => {
    const missingAttribute = mechanicalRecord();
    missingAttribute.attributes.pop();
    expect(() => project(missingAttribute)).toThrow('integrity validation');

    const duplicateAttribute = mechanicalRecord();
    duplicateAttribute.attributes[8] = { ...duplicateAttribute.attributes[8]!, code: ActorAttributeCode.STRENGTH };
    expect(() => project(duplicateAttribute)).toThrow('integrity validation');

    const missingResource = mechanicalRecord();
    missingResource.resources.pop();
    expect(() => project(missingResource)).toThrow('integrity validation');

    const duplicateResource = mechanicalRecord();
    duplicateResource.resources[2] = { ...duplicateResource.resources[2]!, type: ActorResourceType.HP };
    expect(() => project(duplicateResource)).toThrow('integrity validation');
  });

  it('rejects stale snapshots and snapshots from a different campaign ruleset', () => {
    const stale = mechanicalRecord();
    stale.mechanicsStateVersion = 2;
    expect(() => project(stale)).toThrow('integrity validation');

    const wrongRuleset = mechanicalRecord();
    wrongRuleset.derivedSnapshot.rulesetVersionId = '40000000-0000-0000-0000-000000000001';
    expect(() => project(wrongRuleset)).toThrow('integrity validation');
  });

  it('sanitizes integrity errors and rejects published ruleset drift', () => {
    const record = mechanicalRecord();
    record.derivedSnapshot.inputHash = 'not-a-hash';
    let message = '';
    try {
      project(record);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Actor mechanical state failed integrity validation');
    expect(message).not.toContain(actorId);
    expect(message).not.toContain('strength');

    const drift = mechanicalRecord();
    (drift.campaign.rulesetVersion as { revision: string }).revision = 'tampered';
    expect(() => project(drift)).toThrow('does not match the official configuration');
  });
});
