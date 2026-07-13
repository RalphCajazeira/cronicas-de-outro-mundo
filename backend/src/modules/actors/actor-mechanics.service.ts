import { createHash } from 'node:crypto';
import {
  ActorAttributeCode, ActorResourceType, Prisma,
} from '../../generated/prisma/client.js';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import {
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_PRIMARY_ATTRIBUTES,
  calculateEffectiveAttributes,
  calculateInventoryEncumbrance,
  calculateResourceMaximums,
  calculateSecondaryAttributes,
  validateInitialPrimaryAttributes,
  type PrimaryAttributeCode,
  type PrimaryAttributes,
  type ResourceMaximums,
  type AuthorizedNumericModifier,
  type ResourceModifierSet,
  type SecondaryAttributeModifiers,
  type SecondaryAttributes,
} from '../rules/core-v1/index.js';
import {
  loadActorInventoryMechanicalInputs,
  type ActorInventoryMechanicalInputs,
  type InventoryMechanicalInputsClient,
} from '../inventory/inventory-mechanical-inputs.js';
import { validateCoreV1RulesetVersion } from '../rules/ruleset.registry.js';

const attributeCodeToDatabase = {
  strength: ActorAttributeCode.STRENGTH,
  vitality: ActorAttributeCode.VITALITY,
  agility: ActorAttributeCode.AGILITY,
  dexterity: ActorAttributeCode.DEXTERITY,
  intelligence: ActorAttributeCode.INTELLIGENCE,
  wisdom: ActorAttributeCode.WISDOM,
  perception: ActorAttributeCode.PERCEPTION,
  willpower: ActorAttributeCode.WILLPOWER,
  luck: ActorAttributeCode.LUCK,
} as const satisfies Record<PrimaryAttributeCode, ActorAttributeCode>;

const databaseToAttributeCode = Object.fromEntries(
  Object.entries(attributeCodeToDatabase).map(([code, databaseCode]) => [databaseCode, code]),
) as Record<ActorAttributeCode, PrimaryAttributeCode>;

const resourceTypes = [ActorResourceType.HP, ActorResourceType.MANA, ActorResourceType.SP] as const;

interface MechanicalStateRecord {
  id: string;
  level: number;
  mechanicsStateVersion: number;
  inventoryStateVersion: number;
  campaign: {
    rulesetVersionId: string;
    rulesetVersion: {
      id: string;
      rulesetId: string;
      code: string;
      revision: string;
      schemaVersion: number;
      configHash: string;
      configSnapshot: Prisma.JsonValue;
      ruleset: { code: string };
    };
  };
  attributes: Array<{ code: ActorAttributeCode; baseValue: number; earnedValue: number; xp: number }>;
  resources: Array<{ id: string; type: ActorResourceType; current: number; stateVersion: number }>;
  derivedSnapshot: Prisma.ActorDerivedSnapshotGetPayload<Record<string, never>> | null;
  inventoryInputs: ActorInventoryMechanicalInputs;
}

export type ActorMechanicsClient = Pick<
  Prisma.TransactionClient,
  'actor' | 'actorAttribute' | 'actorResource' | 'actorDerivedSnapshot' | 'campaign' | 'rulesetVersion' | 'ruleset'
> & InventoryMechanicalInputsClient;

export interface ActorMechanicalSheet {
  primaryAttributes: PrimaryAttributes;
  resources: {
    hp: { current: number; max: number };
    mana: { current: number; max: number };
    sp: { current: number; max: number };
  };
  secondaryAttributes: Omit<SecondaryAttributes, 'elementalResistanceBps'> & {
    elementalResistanceBps: Readonly<Record<string, number>>;
  };
  mechanicsStateVersion: number;
  inventoryStateVersion: number;
  ruleset: { code: string; revision: string };
}

interface MechanicalCalculation {
  effectiveAttributes: PrimaryAttributes;
  maximums: ResourceMaximums;
  secondary: SecondaryAttributes;
  elementalResistanceSnapshot: Readonly<Record<string, number>>;
  inputHash: string;
}

export interface ActorMechanicsHashInput {
  ruleset: { code: string; revision: string; configHash: string };
  level: number;
  primaryAttributes: PrimaryAttributes;
  calculationInputs: {
    weaponFamilyRank: 0;
    magicSchoolRank: 0;
    accuracyRank: 0;
    evasionRank: 0;
    encumbrancePenaltyBps: number;
    totalCarriedWeight: number;
    equipment: ActorInventoryMechanicalInputs['equipmentHashInput'];
  };
}

function integrityError(): Error {
  return new Error('Actor mechanical state failed integrity validation');
}

export function createActorMechanicsInputHash(input: ActorMechanicsHashInput): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function mapEffectiveAttributes(
  record: MechanicalStateRecord,
  modifiers: Partial<Record<PrimaryAttributeCode, readonly AuthorizedNumericModifier[]>>,
): PrimaryAttributes {
  if (record.attributes.length !== CORE_V1_PRIMARY_ATTRIBUTES.length) throw integrityError();
  const mapped = new Map<PrimaryAttributeCode, number>();
  for (const attribute of record.attributes) {
    const code = databaseToAttributeCode[attribute.code];
    if (code === undefined || mapped.has(code)) throw integrityError();
    if (!Number.isSafeInteger(attribute.baseValue) || !Number.isSafeInteger(attribute.earnedValue)
      || !Number.isSafeInteger(attribute.xp) || attribute.baseValue < 0 || attribute.earnedValue < 0
      || attribute.xp < 0 || attribute.baseValue + attribute.earnedValue > CORE_V1_ATTRIBUTE_HARD_CAP) {
      throw integrityError();
    }
    mapped.set(code, attribute.baseValue + attribute.earnedValue);
  }
  if (CORE_V1_PRIMARY_ATTRIBUTES.some((code) => !mapped.has(code))) throw integrityError();
  return calculateEffectiveAttributes(Object.fromEntries(mapped) as PrimaryAttributes, modifiers);
}

function groupEquipmentModifiers(modifiers: ActorInventoryMechanicalInputs['modifiers']) {
  const primary: Partial<Record<PrimaryAttributeCode, AuthorizedNumericModifier[]>> = {};
  const resources: Partial<Record<'maxHp' | 'maxMana' | 'maxSp', AuthorizedNumericModifier[]>> = {};
  const secondary: Partial<Record<keyof SecondaryAttributeModifiers, AuthorizedNumericModifier[]>> = {};
  const primaryTargets = new Set<string>(CORE_V1_PRIMARY_ATTRIBUTES);
  const secondaryTargets: Record<string, keyof SecondaryAttributeModifiers> = {
    actorPhysicalPower: 'physicalPower', actorMagicalPower: 'magicalPower',
    physicalDefense: 'physicalFlatDefense', magicalDefense: 'magicalFlatDefense',
    accuracy: 'accuracy', evasion: 'evasion', attackSpeedBps: 'attackSpeedBps', castingSpeedBps: 'castingSpeedBps',
    criticalChanceBps: 'criticalChanceBps', criticalDamageBps: 'criticalDamageBps', movementSpeed: 'movementSpeed',
    carryingCapacity: 'carryingCapacity', physicalResistanceBps: 'physicalResistanceBps',
    magicalResistanceBps: 'magicalResistanceBps', elementalResistanceBps: 'elementalResistanceBps',
    hpRegen: 'hpRegen', manaRegen: 'manaRegen', spRegen: 'spRegen',
  };
  for (const modifier of modifiers) {
    const numericModifier = { source: modifier.source, value: modifier.value };
    if (primaryTargets.has(modifier.target)) {
      const target = modifier.target as PrimaryAttributeCode;
      (primary[target] ??= []).push(numericModifier);
      continue;
    }
    if (modifier.target === 'maxHp' || modifier.target === 'maxMana' || modifier.target === 'maxSp') {
      const target = modifier.target;
      (resources[target] ??= []).push(numericModifier);
      continue;
    }
    const target = secondaryTargets[modifier.target];
    if (target !== undefined) (secondary[target] ??= []).push(numericModifier);
  }
  return { primary, resources: resources as ResourceModifierSet, secondary: secondary as SecondaryAttributeModifiers };
}

function calculateMechanicalState(record: MechanicalStateRecord): MechanicalCalculation {
  const ruleset = validateCoreV1RulesetVersion(record.campaign.rulesetVersion);
  const equipmentModifiers = groupEquipmentModifiers(record.inventoryInputs.modifiers);
  const effectiveAttributes = mapEffectiveAttributes(record, equipmentModifiers.primary);
  const calculationInputs = {
    weaponFamilyRank: 0,
    magicSchoolRank: 0,
    accuracyRank: 0,
    evasionRank: 0,
  } as const;
  const maximums = calculateResourceMaximums(effectiveAttributes, record.level, equipmentModifiers.resources);
  const unencumbered = calculateSecondaryAttributes({
    attributes: effectiveAttributes, ...calculationInputs, encumbrancePenalty: 0, modifiers: equipmentModifiers.secondary,
  });
  const encumbrance = calculateInventoryEncumbrance(record.inventoryInputs.totalCarriedWeight, unencumbered.carryingCapacity);
  if (!encumbrance.ok || encumbrance.value.penaltyBps % 100 !== 0) throw integrityError();
  const secondary = calculateSecondaryAttributes({
    attributes: effectiveAttributes,
    ...calculationInputs,
    encumbrancePenalty: encumbrance.value.penaltyBps / 100,
    modifiers: equipmentModifiers.secondary,
  });
  const elementalResistanceSnapshot = Object.freeze({ default: secondary.elementalResistanceBps });
  const inputHash = createActorMechanicsInputHash({
    ruleset: { code: ruleset.code, revision: ruleset.revision, configHash: ruleset.configHash },
    level: record.level,
    primaryAttributes: effectiveAttributes,
    calculationInputs: {
      ...calculationInputs,
      encumbrancePenaltyBps: encumbrance.value.penaltyBps,
      totalCarriedWeight: record.inventoryInputs.totalCarriedWeight,
      equipment: record.inventoryInputs.equipmentHashInput,
    },
  });
  return { effectiveAttributes, maximums, secondary, elementalResistanceSnapshot, inputHash };
}

function validateResources(record: MechanicalStateRecord, maximums: ResourceMaximums, allowAboveMaximum = false) {
  if (record.resources.length !== resourceTypes.length) throw integrityError();
  const resources = new Map(record.resources.map((resource) => [resource.type, resource]));
  if (resources.size !== resourceTypes.length || resourceTypes.some((type) => !resources.has(type))) throw integrityError();
  const hp = resources.get(ActorResourceType.HP);
  const mana = resources.get(ActorResourceType.MANA);
  const sp = resources.get(ActorResourceType.SP);
  if (hp === undefined || mana === undefined || sp === undefined) throw integrityError();
  for (const resource of [hp, mana, sp]) {
    if (!Number.isSafeInteger(resource.current) || resource.current < 0
      || !Number.isSafeInteger(resource.stateVersion) || resource.stateVersion < 0) throw integrityError();
  }
  if (!allowAboveMaximum
    && (hp.current > maximums.maxHp || mana.current > maximums.maxMana || sp.current > maximums.maxSp)) throw integrityError();
  return { hp, mana, sp };
}

function snapshotMatches(
  record: MechanicalStateRecord,
  calculation: MechanicalCalculation,
): boolean {
  const snapshot = record.derivedSnapshot;
  if (snapshot === null) return false;
  const secondary = calculation.secondary;
  const scalarMatches = snapshot.rulesetVersionId === record.campaign.rulesetVersionId
    && snapshot.mechanicsStateVersion === record.mechanicsStateVersion
    && snapshot.inventoryStateVersion === record.inventoryStateVersion
    && snapshot.inputHash === calculation.inputHash
    && snapshot.maxHp === calculation.maximums.maxHp
    && snapshot.maxMana === calculation.maximums.maxMana
    && snapshot.maxSp === calculation.maximums.maxSp
    && snapshot.actorPhysicalPower === secondary.actorPhysicalPower
    && snapshot.actorMagicalPower === secondary.actorMagicalPower
    && snapshot.physicalDefense === secondary.physicalDefense
    && snapshot.magicalDefense === secondary.magicalDefense
    && snapshot.accuracy === secondary.accuracy
    && snapshot.evasion === secondary.evasion
    && snapshot.baseAttackSpeedBps === secondary.baseAttackSpeedBps
    && snapshot.baseCastingSpeedBps === secondary.baseCastingSpeedBps
    && snapshot.criticalChanceBps === secondary.criticalChanceBps
    && snapshot.criticalDamageBps === secondary.criticalDamageBps
    && snapshot.movementSpeed === secondary.movementSpeed
    && snapshot.carryingCapacity === secondary.carryingCapacity
    && snapshot.physicalResistanceBps === secondary.physicalResistanceBps
    && snapshot.magicalResistanceBps === secondary.magicalResistanceBps
    && snapshot.hpRegen === secondary.hpRegen
    && snapshot.manaRegen === secondary.manaRegen
    && snapshot.spRegen === secondary.spRegen;
  if (!scalarMatches) return false;
  try {
    return canonicalJson(snapshot.elementalResistanceSnapshot) === canonicalJson(calculation.elementalResistanceSnapshot);
  } catch {
    return false;
  }
}

async function readMechanicalState(client: ActorMechanicsClient, actorId: string): Promise<MechanicalStateRecord> {
  const actor = await client.actor.findUnique({
    where: { id: actorId },
    select: { id: true, campaignId: true, level: true, mechanicsStateVersion: true, inventoryStateVersion: true },
  });
  if (actor === null) throw new NotFoundError('Actor');
  const campaign = await client.campaign.findUnique({
    where: { id: actor.campaignId },
    select: { rulesetVersionId: true },
  });
  if (campaign === null) throw integrityError();
  const rulesetVersion = await client.rulesetVersion.findUnique({
    where: { id: campaign.rulesetVersionId },
    select: {
      id: true, rulesetId: true, code: true, revision: true, schemaVersion: true,
      configHash: true, configSnapshot: true,
    },
  });
  if (rulesetVersion === null) throw integrityError();
  const ruleset = await client.ruleset.findUnique({ where: { id: rulesetVersion.rulesetId }, select: { code: true } });
  if (ruleset === null) throw integrityError();
  const attributes = await client.actorAttribute.findMany({
    where: { actorId }, select: { code: true, baseValue: true, earnedValue: true, xp: true }, orderBy: { code: 'asc' },
  });
  const resources = await client.actorResource.findMany({
    where: { actorId }, select: { id: true, type: true, current: true, stateVersion: true }, orderBy: { type: 'asc' },
  });
  const derivedSnapshot = await client.actorDerivedSnapshot.findUnique({ where: { actorId } });
  const inventoryInputs = await loadActorInventoryMechanicalInputs(client, actorId);
  return {
    id: actor.id,
    level: actor.level,
    mechanicsStateVersion: actor.mechanicsStateVersion,
    inventoryStateVersion: actor.inventoryStateVersion,
    campaign: { rulesetVersionId: campaign.rulesetVersionId, rulesetVersion: { ...rulesetVersion, ruleset } },
    attributes,
    resources,
    derivedSnapshot,
    inventoryInputs,
  };
}

export async function loadActorMechanicalSheet(
  client: ActorMechanicsClient,
  actorId: string,
): Promise<ActorMechanicalSheet> {
  const record = await readMechanicalState(client, actorId);
  return projectActorMechanicalSheet(record);
}

export function projectActorMechanicalSheet(record: MechanicalStateRecord): ActorMechanicalSheet {
  const calculation = calculateMechanicalState(record);
  if (!snapshotMatches(record, calculation)) throw integrityError();
  const resources = validateResources(record, calculation.maximums);
  const snapshot = record.derivedSnapshot;
  if (snapshot === null) throw integrityError();
  return {
    primaryAttributes: { ...calculation.effectiveAttributes },
    resources: {
      hp: { current: resources.hp.current, max: snapshot.maxHp },
      mana: { current: resources.mana.current, max: snapshot.maxMana },
      sp: { current: resources.sp.current, max: snapshot.maxSp },
    },
    secondaryAttributes: {
      actorPhysicalPower: snapshot.actorPhysicalPower,
      actorMagicalPower: snapshot.actorMagicalPower,
      physicalDefense: snapshot.physicalDefense,
      magicalDefense: snapshot.magicalDefense,
      accuracy: snapshot.accuracy,
      evasion: snapshot.evasion,
      baseAttackSpeedBps: snapshot.baseAttackSpeedBps,
      baseCastingSpeedBps: snapshot.baseCastingSpeedBps,
      criticalChanceBps: snapshot.criticalChanceBps,
      criticalDamageBps: snapshot.criticalDamageBps,
      movementSpeed: snapshot.movementSpeed,
      carryingCapacity: snapshot.carryingCapacity,
      physicalResistanceBps: snapshot.physicalResistanceBps,
      magicalResistanceBps: snapshot.magicalResistanceBps,
      elementalResistanceBps: { ...calculation.elementalResistanceSnapshot },
      hpRegen: snapshot.hpRegen,
      manaRegen: snapshot.manaRegen,
      spRegen: snapshot.spRegen,
    },
    mechanicsStateVersion: record.mechanicsStateVersion,
    inventoryStateVersion: record.inventoryStateVersion,
    ruleset: { code: record.campaign.rulesetVersion.code, revision: record.campaign.rulesetVersion.revision },
  };
}

export async function recomputeActorDerivedSnapshot(
  client: ActorMechanicsClient,
  actorId: string,
): Promise<MechanicalCalculation> {
  const record = await readMechanicalState(client, actorId);
  const calculation = calculateMechanicalState(record);
  const initializesResources = record.resources.length === 0 && record.derivedSnapshot === null;
  if (record.resources.length === 0 && !initializesResources) throw integrityError();
  if (record.resources.length !== 0) validateResources(record, calculation.maximums, true);
  const secondary = calculation.secondary;
  const snapshotData = {
    rulesetVersionId: record.campaign.rulesetVersionId,
    mechanicsStateVersion: record.mechanicsStateVersion,
    inventoryStateVersion: record.inventoryStateVersion,
    ...calculation.maximums,
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
    elementalResistanceSnapshot: calculation.elementalResistanceSnapshot as Prisma.InputJsonValue,
    hpRegen: secondary.hpRegen,
    manaRegen: secondary.manaRegen,
    spRegen: secondary.spRegen,
    inputHash: calculation.inputHash,
  };
  await client.actorDerivedSnapshot.upsert({
    where: { actorId },
    create: { actorId, ...snapshotData },
    update: snapshotData,
  });

  if (initializesResources) {
    await client.actorResource.createMany({
      data: [
        { actorId, type: ActorResourceType.HP, current: calculation.maximums.maxHp, stateVersion: 1 },
        { actorId, type: ActorResourceType.MANA, current: calculation.maximums.maxMana, stateVersion: 1 },
        { actorId, type: ActorResourceType.SP, current: calculation.maximums.maxSp, stateVersion: 1 },
      ],
    });
  } else {
    const resources = validateResources(record, calculation.maximums, true);
    const maximumByType = {
      [ActorResourceType.HP]: calculation.maximums.maxHp,
      [ActorResourceType.MANA]: calculation.maximums.maxMana,
      [ActorResourceType.SP]: calculation.maximums.maxSp,
    } as const;
    for (const resource of Object.values(resources)) {
      const current = Math.min(resource.current, maximumByType[resource.type]);
      if (current !== resource.current) {
        await client.actorResource.update({
          where: { id: resource.id },
          data: { current, stateVersion: { increment: 1 } },
        });
      }
    }
  }
  return calculation;
}

export async function createActorMechanicalState(
  client: ActorMechanicsClient,
  input: { actorId: string; primaryAttributes: unknown },
): Promise<ActorMechanicalSheet> {
  const validation = validateInitialPrimaryAttributes(input.primaryAttributes);
  if (!validation.ok) throw new ConflictError('Primary attributes are invalid for core-v1');
  await client.actorAttribute.createMany({
    data: CORE_V1_PRIMARY_ATTRIBUTES.map((code) => ({
      actorId: input.actorId,
      code: attributeCodeToDatabase[code],
      baseValue: validation.value[code],
      earnedValue: 0,
      xp: 0,
    })),
  });
  await recomputeActorDerivedSnapshot(client, input.actorId);
  return loadActorMechanicalSheet(client, input.actorId);
}
