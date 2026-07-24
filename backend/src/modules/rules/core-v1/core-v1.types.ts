export type PrimaryAttributeCode =
  | 'strength'
  | 'vitality'
  | 'agility'
  | 'dexterity'
  | 'intelligence'
  | 'wisdom'
  | 'perception'
  | 'willpower'
  | 'luck';

export type PrimaryAttributes = Record<PrimaryAttributeCode, number>;
export type PrimaryAttributePreset = 'balanced' | 'physical' | 'magical';

export type ModifierSourceType =
  | 'species'
  | 'class'
  | 'condition'
  | 'equipment'
  | 'status'
  | 'ruleset'
  | 'administrative';

export interface ModifierSource {
  type: ModifierSourceType;
  ref: string;
}

export interface AuthorizedNumericModifier {
  source: ModifierSource;
  value: number;
}

export interface ValidationIssue {
  path: string;
  rule: string;
  message: string;
  expected?: unknown;
  received?: unknown;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export interface ResourceMaximums {
  maxHp: number;
  maxMana: number;
  maxSp: number;
}

export interface ResourceModifierSet {
  maxHp?: readonly AuthorizedNumericModifier[];
  maxMana?: readonly AuthorizedNumericModifier[];
  maxSp?: readonly AuthorizedNumericModifier[];
}

export interface SecondaryAttributeModifiers {
  physicalPower?: readonly AuthorizedNumericModifier[];
  magicalPower?: readonly AuthorizedNumericModifier[];
  physicalFlatDefense?: readonly AuthorizedNumericModifier[];
  magicalFlatDefense?: readonly AuthorizedNumericModifier[];
  accuracy?: readonly AuthorizedNumericModifier[];
  evasion?: readonly AuthorizedNumericModifier[];
  attackSpeedBps?: readonly AuthorizedNumericModifier[];
  castingSpeedBps?: readonly AuthorizedNumericModifier[];
  criticalChanceBps?: readonly AuthorizedNumericModifier[];
  criticalDamageBps?: readonly AuthorizedNumericModifier[];
  movementSpeed?: readonly AuthorizedNumericModifier[];
  carryingCapacity?: readonly AuthorizedNumericModifier[];
  physicalResistanceBps?: readonly AuthorizedNumericModifier[];
  magicalResistanceBps?: readonly AuthorizedNumericModifier[];
  elementalResistanceBps?: readonly AuthorizedNumericModifier[];
  hpRegen?: readonly AuthorizedNumericModifier[];
  manaRegen?: readonly AuthorizedNumericModifier[];
  spRegen?: readonly AuthorizedNumericModifier[];
}

export interface SecondaryAttributeInput {
  attributes: PrimaryAttributes;
  maximumPrimaryAttribute?: number;
  weaponFamilyRank: number;
  magicSchoolRank: number;
  accuracyRank: number;
  evasionRank: number;
  encumbrancePenalty: number;
  modifiers?: SecondaryAttributeModifiers;
}

export interface SecondaryAttributes {
  actorPhysicalPower: number;
  actorMagicalPower: number;
  physicalDefense: number;
  magicalDefense: number;
  accuracy: number;
  evasion: number;
  baseAttackSpeedBps: number;
  baseCastingSpeedBps: number;
  criticalChanceBps: number;
  criticalDamageBps: number;
  movementSpeed: number;
  carryingCapacity: number;
  physicalResistanceBps: number;
  magicalResistanceBps: number;
  elementalResistanceBps: number;
  hpRegen: number;
  manaRegen: number;
  spRegen: number;
}

export type DamageChannel = 'physical' | 'magical';
export type DamageScaling = 'none' | 'half' | 'full';

export interface DamageComponentDefinition {
  id: string;
  channel: DamageChannel;
  element: string | null;
  baseDamage: number;
  scaling: DamageScaling;
  canCrit: boolean;
}

export interface RawDamageComponent {
  id: string;
  channel: DamageChannel;
  element: string | null;
  amount: number;
  canCrit: boolean;
}

export interface DamageImmunities {
  physical?: boolean;
  magical?: boolean;
  elements?: readonly string[];
  componentIds?: readonly string[];
}

export interface DamageResistanceProfile {
  physicalResistanceBps: number;
  magicalResistanceBps: number;
  elementalResistanceBps?: Readonly<Record<string, number>>;
}

export interface DamageMitigationInput {
  actionHit: boolean;
  components: readonly RawDamageComponent[];
  critical: boolean;
  criticalDamageBps: number;
  physicalFlatDefense: number;
  magicalFlatDefense: number;
  blockValue: number;
  completeBlock: boolean;
  resistances: DamageResistanceProfile;
  immunities?: DamageImmunities;
}

export interface MitigatedDamageComponent {
  id: string;
  channel: DamageChannel;
  element: string | null;
  afterCritical: number;
  afterFlatDefense: number;
  afterBlock: number;
  finalDamage: number;
}

export interface DamageMitigationResult {
  totalDamage: number;
  components: MitigatedDamageComponent[];
  appliedMinimumDamage: boolean;
  completeBlock: boolean;
}

export type NpcRole = 'minion' | 'standard' | 'elite' | 'boss';

export interface NpcResourceMultipliers {
  hpBps: number;
  manaBps: number;
  spBps: number;
}

export type CoreV1Cost =
  | { type: 'mana'; amount: number }
  | { type: 'sp'; amount: number }
  | { type: 'hybrid'; mana: number; sp: number }
  | { type: 'active_defense'; sp: number }
  | { type: 'special_dodge'; sp: number }
  | { type: 'maintenance'; resource: 'mana' | 'sp'; amount: number; activationCost: number }
  | { type: 'hp'; percentBps: number }
  | { type: 'none' }
  | { type: 'custom'; resourceRef: string; amount: number };

export interface CostBand {
  minimum: number;
  standard: number;
  maximum: number;
}

export interface TierDamageEnvelope {
  minimum: number;
  maximum: number;
}

export interface AreaDamageProposal {
  singleTargetEquivalentDamage: number;
  perTargetExpectedDamage: number;
  expectedTargetCount: number;
}
