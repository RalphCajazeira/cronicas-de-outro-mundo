import { describe, expect, it } from 'vitest';
import {
  ActorContentState,
  ActorStatus,
} from '../../generated/prisma/client.js';
import { getInitialAttributePreset } from '../rules/core-v1/index.js';
import { classifyActorReadiness } from './actor-readiness.service.js';

const attributes = getInitialAttributePreset('balanced');
const uniqueSpec = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight: 1,
  stacking: { mode: 'unique' },
  equipmentSlots: ['main_hand', 'off_hand'],
  handedness: 'one_handed',
};
const stackSpec = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight: 1,
  stacking: { mode: 'stackable', maxStack: 20 },
};

const dagger = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'weapon',
  code: 'starter-dagger',
  name: 'Adaga inicial',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'none' },
  actionProfile: 'quick',
  targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
  damageComponents: [{ id: 'dagger-hit', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true }],
  handedness: 'one_handed',
  weaponTags: ['dagger'],
};

const narrativeClothing = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'narrative',
  contentKind: 'clothing',
  code: 'traveler-outfit',
  name: 'Traje de viagem',
  description: 'Roupa sem efeito mecânico.',
};

const fireball = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'spell',
  code: 'fireball',
  name: 'Bola de Fogo',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'mana', amount: 8 },
  actionProfile: 'normal',
  effects: [{
    type: 'damage',
    targeting: { type: 'single_target', rangeBand: 'medium', maxTargets: 1 },
    damageComponents: [{ id: 'fireball-fire', channel: 'magical', element: 'fire', baseDamage: 8, scaling: 'full', canCrit: true }],
  }],
};

const vigorStrike = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'skill',
  code: 'vigor-strike',
  name: 'Golpe de Vigor',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'sp', amount: 3 },
  actionProfile: 'quick',
  effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
};

const bloodStep = {
  ...vigorStrike,
  code: 'blood-step',
  name: 'Passo de Sangue',
  cost: { type: 'hp', percentBps: 300 },
};

const customResourceSkill = {
  ...vigorStrike,
  code: 'rage-strike',
  name: 'Golpe de Fúria',
  cost: { type: 'custom', resourceRef: 'rage', amount: 1 },
};

const healingPotion = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'consumable',
  code: 'healing-potion',
  name: 'Poção de Cura',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'none' },
  actionProfile: 'potion',
  consumable: true,
  effects: [{ type: 'restore_resource', resource: 'hp', amount: 30, targeting: { type: 'self', rangeBand: 'self' } }],
};

const bodyArmor = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'armor',
  code: 'starter-body-armor',
  name: 'Armadura de corpo inteiro',
  tier: 1,
  rarity: 'common',
  activation: { type: 'passive' },
  cost: { type: 'none' },
  defense: { physicalFlatDefense: 5 },
  equipmentSlots: ['body'],
};
const bodySpec = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight: 3,
  stacking: { mode: 'unique' },
  equipmentSlots: ['body'],
};

function base() {
  return {
    actor: { status: ActorStatus.ACTIVE },
    resources: {
      hp: { current: 20, maximum: 20 },
      mana: { current: 10, maximum: 10 },
      sp: { current: 10, maximum: 10 },
    },
    requirementContext: {
      level: 1,
      primaryAttributes: attributes,
      knownContentRefs: [],
      equippedWeaponTags: ['dagger'],
      equippedEquipmentTags: [],
      rulesetCode: 'core-v1',
    },
    linked: [],
    inventory: [],
  };
}

function link(profile: unknown, state: ActorContentState = ActorContentState.KNOWN, contentType?: string) {
  const identity = profile as { code?: string; contentKind?: string } | null;
  const resolvedContentType = contentType ?? identity?.contentKind;
  return {
    state,
    definition: {
      code: identity?.code ?? 'legacy-broken-content',
      ...(resolvedContentType === undefined ? {} : { contentType: resolvedContentType }),
    },
    version: { profile },
  };
}

function inventoryEntry(overrides: Record<string, unknown> = {}) {
  return {
    entryRef: 'starter-dagger-1',
    entryKind: 'instance' as const,
    quantity: 1,
    state: 'equipped' as const,
    definition: { code: 'starter-dagger', contentType: 'weapon' },
    version: { profile: dagger, inventorySpec: uniqueSpec },
    ...overrides,
  };
}

describe('actor encounter readiness', () => {
  it('classifies narrative-only cosmetics without treating them as an action or malformed mechanics', () => {
    const result = classifyActorReadiness({ ...base(), linked: [link(narrativeClothing)] });
    expect(result).toMatchObject({
      status: 'narrative_only', canStartEncounter: false, narrativeContentCount: 1,
      blockingReasons: ['no_usable_starter_action'], incompleteContentRefs: [], usableActions: [],
    });
  });

  it('accepts a complete equipped weapon with cost none', () => {
    const result = classifyActorReadiness({ ...base(), inventory: [inventoryEntry()] });
    expect(result).toMatchObject({ status: 'ready', canStartEncounter: true, blockingReasons: [] });
    expect(result.usableActions).toEqual([{ source: 'equipped_weapon', ref: 'starter-dagger-1', action: 'attack' }]);
  });

  it('does not duplicate a physical weapon action merely because its content link is KNOWN', () => {
    const result = classifyActorReadiness({
      ...base(), linked: [link(dagger)], inventory: [inventoryEntry()],
    });
    expect(result.usableActions).toEqual([{ source: 'equipped_weapon', ref: 'starter-dagger-1', action: 'attack' }]);
  });

  it('does not let a valid weapon hide malformed KNOWN mechanics from a legacy row', () => {
    const result = classifyActorReadiness({
      ...base(),
      // A null profile cannot be created by current schemas; it represents controlled legacy drift.
      linked: [link(null, ActorContentState.KNOWN, 'spell')],
      inventory: [inventoryEntry()],
    });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: ['mechanical_content_incomplete'], incompleteContentRefs: ['legacy-broken-content'],
    });
  });

  it('does not let a valid spell hide an incomplete equipped weapon from a legacy row', () => {
    const result = classifyActorReadiness({
      ...base(),
      linked: [link(fireball)],
      inventory: [inventoryEntry({
        definition: { code: 'broken-sword', contentType: 'weapon' },
        version: { profile: null, inventorySpec: uniqueSpec },
      })],
    });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: ['mechanical_content_incomplete'], incompleteContentRefs: ['broken-sword'],
    });
    expect(result.usableActions).toEqual([{ source: 'known_content', ref: 'fireball', action: 'cast' }]);
  });

  it.each([ActorContentState.LEARNING, ActorContentState.LOCKED])('ignores malformed %s content that is not presented as ready', (state) => {
    const result = classifyActorReadiness({
      ...base(),
      linked: [link(null, state, 'spell')],
      inventory: [inventoryEntry()],
    });
    expect(result).toMatchObject({ status: 'ready', canStartEncounter: true, incompleteContentRefs: [] });
  });

  it('accepts a valid spell when current Mana pays its cost', () => {
    const result = classifyActorReadiness({ ...base(), linked: [link(fireball)] });
    expect(result).toMatchObject({ status: 'ready', canStartEncounter: true, blockingReasons: [] });
    expect(result.usableActions).toEqual([{ source: 'known_content', ref: 'fireball', action: 'cast' }]);
  });

  it('blocks a valid spell when current Mana cannot pay its cost', () => {
    const result = classifyActorReadiness({
      ...base(),
      resources: { ...base().resources, mana: { current: 7, maximum: 10 } },
      linked: [link(fireball)],
    });
    expect(result).toMatchObject({
      status: 'blocked', canStartEncounter: false, usableActions: [], incompleteContentRefs: [],
      blockingReasons: ['no_usable_starter_action', 'starter_action_resource_insufficient'],
    });
  });

  it('accepts a valid skill when current SP pays its cost', () => {
    const result = classifyActorReadiness({ ...base(), linked: [link(vigorStrike)] });
    expect(result).toMatchObject({ status: 'ready', canStartEncounter: true, blockingReasons: [] });
  });

  it('blocks a valid skill when current SP cannot pay its cost', () => {
    const result = classifyActorReadiness({
      ...base(),
      resources: { ...base().resources, sp: { current: 2, maximum: 10 } },
      linked: [link(vigorStrike)],
    });
    expect(result).toMatchObject({
      status: 'blocked', canStartEncounter: false,
      blockingReasons: ['no_usable_starter_action', 'starter_action_resource_insufficient'],
    });
  });

  it('supports HP costs only when the actor can retain at least one HP', () => {
    const affordable = classifyActorReadiness({
      ...base(), resources: { ...base().resources, hp: { current: 2, maximum: 20 } }, linked: [link(bloodStep)],
    });
    expect(affordable).toMatchObject({ status: 'ready', canStartEncounter: true });

    const unsafe = classifyActorReadiness({
      ...base(), resources: { ...base().resources, hp: { current: 1, maximum: 20 } }, linked: [link(bloodStep)],
    });
    expect(unsafe).toMatchObject({
      status: 'blocked', canStartEncounter: false,
      blockingReasons: ['no_usable_starter_action', 'starter_action_resource_insufficient'],
    });
  });

  it('fails closed for a custom-resource action because persisted custom pools are not supported', () => {
    const result = classifyActorReadiness({ ...base(), linked: [link(customResourceSkill)] });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: [
        'no_usable_starter_action', 'starter_action_cost_unsupported', 'mechanical_content_incomplete',
      ],
      incompleteContentRefs: ['rage-strike'],
    });
  });

  it('requires current actor requirements for content presented as usable', () => {
    const demanding = { ...vigorStrike, code: 'veteran-strike', name: 'Golpe Veterano', requirements: { minimumLevel: 2 } };
    const result = classifyActorReadiness({ ...base(), linked: [link(demanding)] });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: [
        'no_usable_starter_action', 'starter_action_requirements_unmet', 'mechanical_content_incomplete',
      ],
      incompleteContentRefs: ['veteran-strike'],
    });
  });

  it('accepts a possessed consumable only with a complete mechanical profile, effect, and inventory spec', () => {
    const result = classifyActorReadiness({
      ...base(),
      inventory: [inventoryEntry({
        entryRef: 'healing-potions', entryKind: 'stack', quantity: 2, state: null,
        definition: { code: 'healing-potion', contentType: 'consumable' },
        version: { profile: healingPotion, inventorySpec: stackSpec },
      })],
    });
    expect(result).toMatchObject({ status: 'ready', canStartEncounter: true, blockingReasons: [] });
    expect(result.usableActions).toEqual([{ source: 'consumable', ref: 'healing-potions', action: 'use_item' }]);
  });

  it('reports a usable legacy consumable with an incomplete profile without weakening current schemas', () => {
    const result = classifyActorReadiness({
      ...base(),
      inventory: [inventoryEntry({
        entryRef: 'broken-potion-stack', entryKind: 'stack', quantity: 2, state: null,
        definition: { code: 'broken-potion', contentType: 'consumable' },
        version: { profile: null, inventorySpec: stackSpec },
      })],
    });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: ['no_usable_starter_action', 'mechanical_content_incomplete'],
      incompleteContentRefs: ['broken-potion'],
    });
  });

  it('blocks incoherent equipped defensive equipment even when an action is otherwise valid', () => {
    const demandingArmor = { ...bodyArmor, requirements: { minimumLevel: 2 } };
    const result = classifyActorReadiness({
      ...base(),
      inventory: [
        inventoryEntry(),
        inventoryEntry({
          entryRef: 'starter-body-armor-1', state: 'equipped',
          definition: { code: 'starter-body-armor', contentType: 'armor' },
          version: { profile: demandingArmor, inventorySpec: bodySpec },
        }),
      ],
    });
    expect(result).toMatchObject({
      status: 'incomplete', canStartEncounter: false,
      blockingReasons: ['starter_action_requirements_unmet', 'mechanical_content_incomplete'],
      incompleteContentRefs: ['starter-body-armor'],
    });
  });

  it('accepts a fully valid initial package and lets cosmetics coexist without becoming actions', () => {
    const result = classifyActorReadiness({
      ...base(),
      linked: [link(fireball, ActorContentState.MASTERED), link(narrativeClothing)],
      inventory: [
        inventoryEntry(),
        inventoryEntry({
          entryRef: 'healing-potions', entryKind: 'stack', quantity: 2, state: null,
          definition: { code: 'healing-potion', contentType: 'consumable' },
          version: { profile: healingPotion, inventorySpec: stackSpec },
        }),
        inventoryEntry({
          entryRef: 'starter-body-armor-1', state: 'equipped',
          definition: { code: 'starter-body-armor', contentType: 'armor' },
          version: { profile: bodyArmor, inventorySpec: bodySpec },
        }),
      ],
    });
    expect(result).toMatchObject({
      status: 'ready', canStartEncounter: true, blockingReasons: [], narrativeContentCount: 1,
    });
    expect(result.usableActions).toEqual([
      { source: 'consumable', ref: 'healing-potions', action: 'use_item' },
      { source: 'equipped_weapon', ref: 'starter-dagger-1', action: 'attack' },
      { source: 'known_content', ref: 'fireball', action: 'cast' },
    ]);
  });

  it('blocks inactive or defeated actors even when a complete action exists', () => {
    const result = classifyActorReadiness({
      ...base(),
      actor: { status: ActorStatus.DEFEATED },
      resources: { ...base().resources, hp: { current: 0, maximum: 20 } },
      inventory: [inventoryEntry()],
    });
    expect(result.canStartEncounter).toBe(false);
    expect(result.blockingReasons).toEqual(['actor_not_active', 'hp_depleted']);
  });
});
