import { describe, expect, it, vi } from 'vitest';
import { ActorAttributeCode, ActorResourceType, ActorStatus } from '../../generated/prisma/client.js';
import {
  CORE_V1_CONFIG_HASH,
  CORE_V1_CONFIG_SNAPSHOT,
  CORE_V1_REVISION,
  CORE_V1_SCHEMA_VERSION,
  CORE_V1_VERSION_CODE,
} from '../rules/core-v1/core-v1.manifest.js';
import {
  calculateEffectiveAttributes,
  calculateResourceMaximums,
  calculateSecondaryAttributes,
  getInitialAttributePreset,
  getCoreV1ContentElements,
} from '../rules/core-v1/index.js';
import {
  createActorMechanicsInputHash,
  projectActorMechanicalSheet,
  reactivateDefeatedActorAfterHpRestoration,
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
      encumbrancePenaltyBps: 0, totalCarriedWeight: 0, equipment: [], effectsStateVersion: 1, activeEffects: [],
    },
  });
  return {
    id: actorId,
    level: 1,
    mechanicsStateVersion: 1,
    inventoryStateVersion: 1,
    effectsStateVersion: 1,
    campaign: {
      rulesetVersionId,
      engineTick: 0n,
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
      mechanicsStateVersion: 1, effectsStateVersion: 1, ...maximums,
      inventoryStateVersion: 1,
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
      elementalResistanceSnapshot: Object.fromEntries(getCoreV1ContentElements().map((element) => [element, secondary.elementalResistanceBps])),
      hpRegen: secondary.hpRegen,
      manaRegen: secondary.manaRegen,
      spRegen: secondary.spRegen,
      inputHash,
      createdAt: now,
      updatedAt: now,
    },
    inventoryInputs: {
      inventory: { entries: [] },
      loadout: {
        slots: [
          ['main_hand', 'main_hand'], ['off_hand', 'off_hand'], ['head', 'head'], ['chest', 'chest'],
          ['hands', 'hands'], ['legs', 'legs'], ['feet', 'feet'], ['body', 'body'],
          ['accessory_1', 'accessory'], ['accessory_2', 'accessory'],
        ].map(([slotRef, slotType]) => ({ slotRef, slotType, entryRef: null })),
      },
      totalCarriedWeight: 0,
      modifiers: [],
      defense: { physicalImmune: false, magicalImmune: false, immuneElements: [], elementalResistanceBps: {} },
      equipmentHashInput: [],
    },
    activeEffectInputs: { activeEffects: [], modifiers: [], hashInput: [] },
  };
}

describe('authoritative defeated Actor recovery', () => {
  it('reactivates only a DEFEATED Actor after HP crosses from zero to positive', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await expect(reactivateDefeatedActorAfterHpRestoration(
      { actor: { updateMany } } as never, actorId, 0, 3,
    )).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: actorId, status: ActorStatus.DEFEATED },
      data: { status: ActorStatus.ACTIVE },
    });
  });

  it.each([[1, 2], [0, 0], [5, 0]])('does not query status for HP transition %i -> %i', async (before, after) => {
    const updateMany = vi.fn();
    await expect(reactivateDefeatedActorAfterHpRestoration(
      { actor: { updateMany } } as never, actorId, before, after,
    )).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('preserves ACTIVE, DEAD, INACTIVE and ARCHIVED when the conditional update matches no DEFEATED row', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(reactivateDefeatedActorAfterHpRestoration(
      { actor: { updateMany } } as never, actorId, 0, 1,
    )).resolves.toBe(false);
  });
});

type MechanicalRecord = Parameters<typeof projectActorMechanicalSheet>[0];

function project(record = mechanicalRecord()) {
  return projectActorMechanicalSheet(record as unknown as MechanicalRecord);
}

function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key: string, item: unknown): unknown => typeof item === 'bigint' ? item.toString(10) : item);
}

describe('actor mechanical state', () => {
  it('maps all nine attributes and returns the official public projection without mutating persistence', () => {
    const record = mechanicalRecord();
    const before = stringifyWithBigInts(record);
    const sheet = project(record);
    expect(Object.keys(sheet.primaryAttributes)).toEqual([
      'strength', 'vitality', 'agility', 'dexterity', 'intelligence', 'wisdom', 'perception', 'willpower', 'luck',
    ]);
    expect(sheet.resources.hp.current).toBe(sheet.resources.hp.max);
    expect(sheet.resources.mana.current).toBe(sheet.resources.mana.max);
    expect(sheet.resources.sp.current).toBe(sheet.resources.sp.max);
    expect(sheet).not.toHaveProperty('inputHash');
    expect(sheet).not.toHaveProperty('rulesetVersionId');
    expect(stringifyWithBigInts(record)).toBe(before);
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
        evasionRank: 0 as const, encumbrancePenaltyBps: 0, totalCarriedWeight: 0, equipment: [],
        effectsStateVersion: 1, activeEffects: [],
      },
    };
    const hash = createActorMechanicsInputHash(input);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(createActorMechanicsInputHash({ ...input, primaryAttributes: { ...input.primaryAttributes } })).toBe(hash);
    expect(createActorMechanicsInputHash({ ...input, level: 2 })).not.toBe(hash);
  });

  it('applies equipped primary modifiers without leaking target metadata into numeric helpers', () => {
    const record = mechanicalRecord();
    const source = { type: 'equipment' as const, ref: 'strength-harness' };
    record.inventoryInputs.modifiers = [{ target: 'strength', source, value: 1 }] as never;
    record.inventoryInputs.equipmentHashInput = [{
      entryRef: 'strength-harness', contentType: 'item', code: 'strength-harness', versionNumber: 1,
      inventorySpecHash: 'a'.repeat(64), passiveModifiers: [{ target: 'strength', amount: 1, sourceRule: 'equipped_content' }],
      defense: null,
    }] as never;
    const base = getInitialAttributePreset('balanced');
    const effective = calculateEffectiveAttributes(base, { strength: [{ source, value: 1 }] });
    const maximums = calculateResourceMaximums(effective, 1);
    const secondary = calculateSecondaryAttributes({
      attributes: effective, weaponFamilyRank: 0, magicSchoolRank: 0, accuracyRank: 0, evasionRank: 0,
      encumbrancePenalty: 0,
    });
    Object.assign(record.derivedSnapshot, maximums, {
      actorPhysicalPower: secondary.actorPhysicalPower, actorMagicalPower: secondary.actorMagicalPower,
      physicalDefense: secondary.physicalDefense, magicalDefense: secondary.magicalDefense,
      accuracy: secondary.accuracy, evasion: secondary.evasion,
      baseAttackSpeedBps: secondary.baseAttackSpeedBps, baseCastingSpeedBps: secondary.baseCastingSpeedBps,
      criticalChanceBps: secondary.criticalChanceBps, criticalDamageBps: secondary.criticalDamageBps,
      movementSpeed: secondary.movementSpeed, carryingCapacity: secondary.carryingCapacity,
      physicalResistanceBps: secondary.physicalResistanceBps, magicalResistanceBps: secondary.magicalResistanceBps,
      elementalResistanceSnapshot: Object.fromEntries(getCoreV1ContentElements().map((element) => [element, secondary.elementalResistanceBps])),
      hpRegen: secondary.hpRegen, manaRegen: secondary.manaRegen, spRegen: secondary.spRegen,
      inputHash: createActorMechanicsInputHash({
        ruleset: { code: CORE_V1_VERSION_CODE, revision: CORE_V1_REVISION, configHash: CORE_V1_CONFIG_HASH },
        level: 1, primaryAttributes: effective,
        calculationInputs: {
          weaponFamilyRank: 0, magicSchoolRank: 0, accuracyRank: 0, evasionRank: 0,
          encumbrancePenaltyBps: 0, totalCarriedWeight: 0, equipment: record.inventoryInputs.equipmentHashInput,
          effectsStateVersion: 1, activeEffects: [],
        },
      }),
    });
    expect(project(record).primaryAttributes.strength).toBe(base.strength + 1);
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
