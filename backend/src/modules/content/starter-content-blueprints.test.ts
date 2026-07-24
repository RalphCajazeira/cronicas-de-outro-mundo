import { describe, expect, it } from 'vitest';
import {
  collectEquippedModifiers,
  createCoreV1EmptyEquipmentLoadout,
  equipItem,
  getInitialAttributePreset,
  unequipItem,
  validateCoreV1ContentProfile,
  validateCoreV1InventorySpec,
  type CoreV1InventoryEntry,
} from '../rules/core-v1/index.js';
import {
  materializeStarterContentBlueprint,
  STARTER_CONTENT_BLUEPRINT_CODES,
} from './starter-content-blueprints.js';

describe('starter content blueprints', () => {
  it.each(STARTER_CONTENT_BLUEPRINT_CODES)('materializes a canonical %s profile', (starterBlueprint) => {
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint,
      code: `test-${starterBlueprint.replaceAll('_', '-')}`,
      name: `Test ${starterBlueprint}`,
    });
    const profile = validateCoreV1ContentProfile(blueprint.profile);
    expect(profile.ok, profile.ok ? '' : JSON.stringify(profile.issues)).toBe(true);
    expect(blueprint.profile).toMatchObject({
      code: `test-${starterBlueprint.replaceAll('_', '-')}`,
      name: `Test ${starterBlueprint}`,
      contentKind: blueprint.contentType,
    });
    if (blueprint.inventorySpec !== null) {
      const inventorySpec = validateCoreV1InventorySpec(blueprint.inventorySpec);
      expect(inventorySpec.ok, inventorySpec.ok ? '' : JSON.stringify(inventorySpec.issues)).toBe(true);
    }
  });

  it('customizes only the allowlisted magical element without exposing structural mechanics', () => {
    const spell = materializeStarterContentBlueprint({
      starterBlueprint: 'basic_offensive_spell',
      code: 'frost-shard',
      name: 'Estilhaço Gélido',
      damageElement: 'ice',
    });
    expect(spell.profile).toMatchObject({
      contentKind: 'spell',
      effects: [{
        type: 'damage',
        damageComponents: [{ element: 'ice', baseDamage: 6, channel: 'magical' }],
      }],
    });
  });

  it('materializes Elven Boots with only the four supplied equipped modifiers', () => {
    const boots = materializeStarterContentBlueprint({
      starterBlueprint: 'secondary_modifier_equipment',
      code: 'elven-boots',
      name: 'Bota Élfica',
      equipmentSlot: 'feet',
      unitWeight: 1,
      secondaryModifiers: {
        evasion: 2,
        movementSpeed: 1,
        physicalDefense: 2,
        magicalDefense: 5,
      },
    });
    expect(boots.inventorySpec).toMatchObject({ unitWeight: 1, equipmentSlots: ['feet'] });
    expect(boots.profile).toMatchObject({
      contentKind: 'armor',
      equipmentSlots: ['feet'],
      passiveModifiers: [
        { target: 'evasion', amount: 2, sourceRule: 'equipped_content' },
        { target: 'movementSpeed', amount: 1, sourceRule: 'equipped_content' },
        { target: 'physicalDefense', amount: 2, sourceRule: 'equipped_content' },
        { target: 'magicalDefense', amount: 5, sourceRule: 'equipped_content' },
      ],
    });
  });

  it('applies Elven Boots only while physically equipped and removes all four modifiers on unequip', () => {
    const boots = materializeStarterContentBlueprint({
      starterBlueprint: 'secondary_modifier_equipment',
      code: 'elven-boots',
      name: 'Bota Élfica',
      equipmentSlot: 'feet',
      unitWeight: 1,
      secondaryModifiers: {
        evasion: 2, movementSpeed: 1, physicalDefense: 2, magicalDefense: 5,
      },
    });
    if (boots.inventorySpec === null) throw new Error('Elven Boots inventory spec is required');
    const entry: CoreV1InventoryEntry = {
      entryKind: 'instance',
      entryRef: 'elven-boots-1',
      contentVersion: {
        scope: 'world', contentType: 'armor', code: 'elven-boots', versionNumber: 1,
      },
      inventorySpec: boots.inventorySpec,
      profile: boots.profile,
      state: 'available',
    };
    const requirements = {
      level: 1,
      primaryAttributes: getInitialAttributePreset('balanced'),
      knownContentRefs: [],
      equippedWeaponTags: [],
      equippedEquipmentTags: [],
      rulesetCode: 'core-v1' as const,
    };
    const equipped = equipItem(
      { entries: [entry] },
      createCoreV1EmptyEquipmentLoadout(),
      { entryRef: entry.entryRef, targetSlotRef: 'feet' },
      requirements,
    );
    if (!equipped.ok) throw new Error(JSON.stringify(equipped.issues));
    const modifiers = collectEquippedModifiers(equipped.value.inventory, equipped.value.loadout);
    if (!modifiers.ok) throw new Error(JSON.stringify(modifiers.issues));
    expect(modifiers.value.map(({ target, value }) => ({ target, value }))).toEqual([
      { target: 'evasion', value: 2 },
      { target: 'movementSpeed', value: 1 },
      { target: 'physicalDefense', value: 2 },
      { target: 'magicalDefense', value: 5 },
    ]);

    const removed = unequipItem(equipped.value.inventory, equipped.value.loadout, entry.entryRef);
    if (!removed.ok) throw new Error(JSON.stringify(removed.issues));
    const after = collectEquippedModifiers(removed.value.inventory, removed.value.loadout);
    if (!after.ok) throw new Error(JSON.stringify(after.issues));
    expect(after.value).toEqual([]);
    expect(collectEquippedModifiers(
      { entries: [] },
      createCoreV1EmptyEquipmentLoadout(),
    )).toMatchObject({ ok: true, value: [] });
  });

  it('keeps Veil of Darkness and detection semantically distinct from movement', () => {
    const veil = materializeStarterContentBlueprint({
      starterBlueprint: 'veil_of_darkness_spell',
      code: 'veil-of-darkness',
      name: 'Véu das Trevas',
      linkedStatusCode: 'shadow-wrapped',
    });
    const detection = materializeStarterContentBlueprint({
      starterBlueprint: 'detect_hidden_skill',
      code: 'detect-hidden',
      name: 'Detectar Ocultos',
    });
    expect(veil.profile).toMatchObject({
      cost: { type: 'mana', amount: 4 },
      targeting: { type: 'self' },
      effects: [{ type: 'apply_status', statusRef: 'shadow-wrapped' }],
    });
    expect(detection.profile).toMatchObject({
      cost: { type: 'sp', amount: 3 },
      effects: [{ type: 'modify_secondary_attribute', secondaryCode: 'detection' }],
      tags: ['detect_hidden', 'informational'],
    });
    expect(JSON.stringify([veil.profile, detection.profile])).not.toContain('"type":"movement"');
  });
});
