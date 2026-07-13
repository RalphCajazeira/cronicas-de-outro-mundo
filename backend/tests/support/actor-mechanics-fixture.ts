import type { ActorMechanicalSheet } from '../../src/modules/actors/actor-mechanics.service.js';
import {
  calculateResourceMaximums,
  calculateSecondaryAttributes,
  getInitialAttributePreset,
  type PrimaryAttributes,
} from '../../src/modules/rules/core-v1/index.js';

export function actorMechanicalSheetFixture(
  primaryAttributes: PrimaryAttributes = getInitialAttributePreset('balanced'),
  level = 1,
): ActorMechanicalSheet {
  const maximums = calculateResourceMaximums(primaryAttributes, level);
  const secondary = calculateSecondaryAttributes({
    attributes: primaryAttributes,
    weaponFamilyRank: 0,
    magicSchoolRank: 0,
    accuracyRank: 0,
    evasionRank: 0,
    encumbrancePenalty: 0,
  });
  const { elementalResistanceBps, ...scalarSecondary } = secondary;
  return {
    primaryAttributes: { ...primaryAttributes },
    resources: {
      hp: { current: maximums.maxHp, max: maximums.maxHp },
      mana: { current: maximums.maxMana, max: maximums.maxMana },
      sp: { current: maximums.maxSp, max: maximums.maxSp },
    },
    secondaryAttributes: { ...scalarSecondary, elementalResistanceBps: { default: elementalResistanceBps } },
    mechanicsStateVersion: 1,
    inventoryStateVersion: 1,
    ruleset: { code: 'core-v1', revision: 'RC1.1' },
  };
}
