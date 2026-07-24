import {
  validateCoreV1ContentProfile,
  validateCoreV1InventorySpec,
  type CoreV1ContentProfile,
  type CoreV1Element,
  type CoreV1InventorySpec,
  type CoreV1PassiveModifierTarget,
  type CoreV1Rarity,
} from '../rules/core-v1/index.js';

export const STARTER_CONTENT_BLUEPRINT_CODES = [
  'simple_melee_weapon',
  'simple_ranged_weapon',
  'simple_magic_focus',
  'basic_offensive_spell',
  'basic_mobility_skill',
  'basic_healing_spell',
  'basic_healing_consumable',
  'starter_body_armor',
  'secondary_modifier_equipment',
  'shadow_wrapped_status',
  'veil_of_darkness_spell',
  'detect_hidden_skill',
] as const;

export type StarterContentBlueprintCode = typeof STARTER_CONTENT_BLUEPRINT_CODES[number];

export interface StarterContentBlueprintIdentity {
  readonly starterBlueprint: StarterContentBlueprintCode;
  readonly code: string;
  readonly name: string;
  readonly damageElement?: CoreV1Element | undefined;
  readonly equipmentSlot?: 'head' | 'chest' | 'hands' | 'legs' | 'feet' | 'body' | 'accessory';
  readonly unitWeight?: number;
  readonly secondaryModifiers?: Readonly<Partial<Record<
    Extract<CoreV1PassiveModifierTarget,
    | 'physicalDefense' | 'magicalDefense' | 'accuracy' | 'evasion' | 'stealth'
    | 'detection' | 'movementSpeed' | 'carryingCapacity' | 'physicalResistanceBps'
    | 'magicalResistanceBps' | 'criticalChanceBps'>,
    number | undefined
  >>>;
  readonly linkedStatusCode?: string;
}

export interface MaterializedStarterContentBlueprint {
  readonly contentType: 'weapon' | 'spell' | 'skill' | 'consumable' | 'armor' | 'clothing' | 'status_effect';
  readonly profile: CoreV1ContentProfile;
  readonly inventorySpec: CoreV1InventorySpec | null;
}

const uniqueSpec = (
  unitWeight: number,
  equipmentSlots: CoreV1InventorySpec['equipmentSlots'],
  handedness?: CoreV1InventorySpec['handedness'],
): CoreV1InventorySpec => ({
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight,
  stacking: { mode: 'unique' },
  ...(equipmentSlots === undefined ? {} : { equipmentSlots }),
  ...(handedness === undefined ? {} : { handedness }),
});

function mechanicalIdentity(
  contentKind: MaterializedStarterContentBlueprint['contentType'],
  code: string,
  name: string,
  rarity: CoreV1Rarity = 'common',
) {
  return {
    schemaVersion: 1 as const,
    rulesetCode: 'core-v1' as const,
    profileMode: 'mechanical' as const,
    contentKind,
    code,
    name,
    tier: 1,
    rarity,
  };
}

function materializeUnchecked(input: StarterContentBlueprintIdentity): MaterializedStarterContentBlueprint {
  const identity = (
    contentKind: MaterializedStarterContentBlueprint['contentType'],
    rarity?: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic',
  ) => (
    mechanicalIdentity(contentKind, input.code, input.name, rarity ?? 'common')
  );
  switch (input.starterBlueprint) {
    case 'simple_melee_weapon':
      return {
        contentType: 'weapon',
        profile: {
          ...identity('weapon'),
          activation: { type: 'active' },
          cost: { type: 'none' },
          actionProfile: 'quick',
          targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
          damageComponents: [{
            id: `${input.code}-hit`, channel: 'physical', element: null,
            baseDamage: 4, scaling: 'full', canCrit: true,
          }],
          handedness: 'one_handed',
          weaponTags: ['light_blade'],
        },
        inventorySpec: uniqueSpec(1, ['main_hand', 'off_hand'], 'one_handed'),
      };
    case 'simple_ranged_weapon':
      return {
        contentType: 'weapon',
        profile: {
          ...identity('weapon'),
          activation: { type: 'active' },
          cost: { type: 'none' },
          actionProfile: 'normal',
          targeting: { type: 'single_target', rangeBand: 'far', maxTargets: 1 },
          damageComponents: [{
            id: `${input.code}-shot`, channel: 'physical', element: null,
            baseDamage: 6, scaling: 'full', canCrit: true,
          }],
          handedness: 'two_handed',
          weaponTags: ['bow'],
        },
        inventorySpec: uniqueSpec(2, ['main_hand', 'off_hand'], 'two_handed'),
      };
    case 'simple_magic_focus':
      return {
        contentType: 'weapon',
        profile: {
          ...identity('weapon'),
          activation: { type: 'active' },
          cost: { type: 'none' },
          actionProfile: 'normal',
          targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
          damageComponents: [{
            id: `${input.code}-pulse`, channel: 'magical', element: input.damageElement ?? 'arcane',
            baseDamage: 4, scaling: 'full', canCrit: true,
          }],
          handedness: 'one_handed',
          weaponTags: ['focus'],
        },
        inventorySpec: uniqueSpec(1, ['main_hand', 'off_hand'], 'one_handed'),
      };
    case 'basic_offensive_spell':
      return {
        contentType: 'spell',
        profile: {
          ...identity('spell'),
          activation: { type: 'active' },
          cost: { type: 'mana', amount: 4 },
          actionProfile: 'normal',
          effects: [{
            type: 'damage',
            targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
            damageComponents: [{
              id: `${input.code}-damage`, channel: 'magical', element: input.damageElement ?? 'arcane',
              baseDamage: 6, scaling: 'full', canCrit: true,
            }],
          }],
        },
        inventorySpec: null,
      };
    case 'basic_mobility_skill':
      return {
        contentType: 'skill',
        profile: {
          ...identity('skill'),
          activation: { type: 'active' },
          cost: { type: 'sp', amount: 3 },
          actionProfile: 'quick',
          effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
        },
        inventorySpec: null,
      };
    case 'basic_healing_spell':
      return {
        contentType: 'spell',
        profile: {
          ...identity('spell'),
          activation: { type: 'active' },
          cost: { type: 'mana', amount: 4 },
          actionProfile: 'normal',
          effects: [{
            type: 'restore_resource',
            resource: 'hp',
            amount: 12,
            targeting: { type: 'self', rangeBand: 'self' },
          }],
        },
        inventorySpec: null,
      };
    case 'basic_healing_consumable':
      return {
        contentType: 'consumable',
        profile: {
          ...identity('consumable'),
          activation: { type: 'active' },
          cost: { type: 'none' },
          actionProfile: 'potion',
          consumable: true,
          effects: [{
            type: 'restore_resource',
            resource: 'hp',
            amount: 30,
            targeting: { type: 'self', rangeBand: 'self' },
          }],
        },
        inventorySpec: {
          schemaVersion: 1,
          rulesetCode: 'core-v1',
          inventoryRulesCode: 'core-v1-inventory-v1',
          unitWeight: 1,
          stacking: { mode: 'stackable', maxStack: 20 },
        },
      };
    case 'starter_body_armor':
      return {
        contentType: 'armor',
        profile: {
          ...identity('armor'),
          activation: { type: 'passive' },
          cost: { type: 'none' },
          defense: { physicalFlatDefense: 5 },
          equipmentSlots: ['body'],
        },
        inventorySpec: uniqueSpec(3, ['body']),
      };
    case 'secondary_modifier_equipment': {
      const slot = input.equipmentSlot ?? 'feet';
      const passiveModifiers = Object.entries(input.secondaryModifiers ?? { physicalDefense: 1 }).flatMap(([target, amount]) => (
        amount === undefined ? [] : [{
          target: target as CoreV1PassiveModifierTarget,
          amount,
          sourceRule: 'equipped_content' as const,
        }]
      ));
      return {
        contentType: 'armor',
        profile: {
          ...identity('armor', 'epic'),
          activation: { type: 'passive' },
          cost: { type: 'none' },
          equipmentSlots: [slot],
          passiveModifiers,
        },
        inventorySpec: uniqueSpec(input.unitWeight ?? 1, [slot]),
      };
    }
    case 'shadow_wrapped_status':
      return {
        contentType: 'status_effect',
        profile: {
          ...identity('status_effect', 'rare'),
          activation: { type: 'passive' },
          cost: { type: 'none' },
          duration: { type: 'scene' },
          stacking: { type: 'refresh' },
          passiveModifiers: [
            { target: 'stealth', amount: 4, sourceRule: 'status_effect' },
            { target: 'evasion', amount: 2, sourceRule: 'status_effect' },
            { target: 'movementSpeed', amount: 1, sourceRule: 'status_effect' },
          ],
          tags: ['shadow_wrapped', 'stealth'],
        },
        inventorySpec: null,
      };
    case 'veil_of_darkness_spell':
      return {
        contentType: 'spell',
        profile: {
          ...identity('spell'),
          activation: { type: 'active' },
          cost: { type: 'mana', amount: 4 },
          actionProfile: 'normal',
          targeting: { type: 'self', rangeBand: 'self' },
          effects: [{
            type: 'apply_status',
            statusRef: input.linkedStatusCode ?? 'envolto-em-sombras',
            duration: { type: 'scene' },
            stacking: { type: 'refresh' },
          }],
          tags: ['shadow', 'stealth'],
        },
        inventorySpec: null,
      };
    case 'detect_hidden_skill':
      return {
        contentType: 'skill',
        profile: {
          ...identity('skill'),
          activation: { type: 'active' },
          cost: { type: 'sp', amount: 3 },
          actionProfile: 'quick',
          targeting: { type: 'self', rangeBand: 'self' },
          effects: [{
            type: 'modify_secondary_attribute',
            secondaryCode: 'detection',
            amount: 3,
            duration: { type: 'actions', value: 1 },
          }],
          tags: ['detect_hidden', 'informational'],
        },
        inventorySpec: null,
      };
  }
}

export function materializeStarterContentBlueprint(
  input: StarterContentBlueprintIdentity,
): MaterializedStarterContentBlueprint {
  const blueprint = materializeUnchecked(input);
  const profile = validateCoreV1ContentProfile(blueprint.profile);
  if (!profile.ok) {
    throw new Error(`Invalid built-in starter content profile: ${input.starterBlueprint}: ${JSON.stringify(profile.issues)}`);
  }
  if (blueprint.inventorySpec === null) return { ...blueprint, profile: profile.value };
  const inventorySpec = validateCoreV1InventorySpec(blueprint.inventorySpec);
  if (!inventorySpec.ok) throw new Error(`Invalid built-in starter inventory spec: ${input.starterBlueprint}`);
  return { ...blueprint, profile: profile.value, inventorySpec: inventorySpec.value };
}
