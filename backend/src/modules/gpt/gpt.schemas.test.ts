import { describe, expect, it } from 'vitest';
import { getContentSchema } from '../content/content.schemas.js';
import {
  createEventSchema, listCampaignActorsSchema, loadGameSchema, manageActorContentSchema, manageActorInventorySchema, patchActorSchema,
  resolveActorEffectSchema, startGameSchema, upsertActorSchema, upsertContentSchema,
} from './gpt.schemas.js';
import { jsonByteSize, jsonDepth, jsonKeyCount } from './gpt.start-game.js';
import { getInitialAttributePreset } from '../rules/core-v1/index.js';
import { skillPublicationInput } from '../../../tests/support/content-fixture.js';

const scope = { playerRef: 'ralph', worldRef: 'mundo-cardinal', campaignRef: 'harem-perfeito' };
const primaryAttributes = getInitialAttributePreset('balanced');

function validStartGame() {
  return {
    idempotencyKey: 'start-game-schema-001', playerMode: 'create' as const, playerRef: 'ralph', playerDisplayName: 'Ralph',
    worldMode: 'create' as const, worldRef: 'mundo-cardinal', worldName: 'Mundo Cardinal', worldDescription: 'Um mundo novo.',
    worldConfiguration: {
      schemaVersion: 1 as const, genres: ['fantasy'], setting: 'Reinos e ruínas.', era: 'medieval',
      technologyLevel: { grade: 'preindustrial' as const }, magicLevel: { grade: 'high' as const }, worldTone: ['adventure'],
    },
    campaignRef: 'harem-perfeito', campaignName: 'Campanha',
    campaignConfiguration: {
      schemaVersion: 1 as const, difficulty: { preset: 'standard' as const, overrides: { opponentCunning: 4 } },
      progressionPace: 'standard' as const, narrativeTone: ['heroic'], focus: ['exploration'], playerFreedom: 'open' as const,
      consequenceLevel: 'serious' as const,
      classModel: { mode: 'identity' as const, startingClass: 'optional' as const, progressionBasis: ['content'], description: 'Classes são identidades.' },
    },
    protagonist: {
      code: 'ralph', name: 'Ralph', actorType: 'character' as const, className: 'Explorador', primaryAttributes,
      appearance: { eyes: 'verdes' }, personality: { traits: ['calmo'] },
      origin: { label: 'Viajante', summary: 'Chegou de terras distantes.' },
    },
    initialContentPackages: [], initialPremise: 'O protagonista chega à fronteira do reino.',
  };
}

function createSkill(code = 'quiet-step') {
  const publication = skillPublicationInput(code);
  return {
    definition: {
      mode: 'create' as const, scope: 'world' as const, ...publication, metadata: {},
    },
    protagonistLink: { state: 'known' as const, rank: 1, progress: 0, mastery: 0, metadata: {} },
  };
}

describe('GPT API schemas', () => {
  it('requires explicit scope and accepts normalized enums', () => {
    const actor = upsertActorSchema.parse({ ...scope, idempotencyKey: 'actor-schema-001', code: 'lyra', name: 'Lyra', actorType: 'spirit', primaryAttributes });
    expect(actor).toMatchObject({ ...scope, actorType: 'spirit', primaryAttributes });
    expect(upsertActorSchema.safeParse({ idempotencyKey: 'actor-schema-002', code: 'lyra', name: 'Lyra', actorType: 'spirit' }).success).toBe(false);
  });

  it('rejects every scoped operation when any scope ref is absent', () => {
    const start = validStartGame();
    const scopedInputs = [
      [loadGameSchema, scope], [listCampaignActorsSchema, scope], [getContentSchema, { ...scope, contentType: 'skill' }],
      [startGameSchema, start],
      [upsertActorSchema, { ...scope, idempotencyKey: 'actor-scope-001', code: 'lyra', name: 'Lyra', actorType: 'spirit', primaryAttributes }],
      [patchActorSchema, { ...scope, idempotencyKey: 'patch-scope-001', name: 'Lyra' }],
      [upsertContentSchema, { ...scope, idempotencyKey: 'content-scope-001', ...skillPublicationInput('step', 'Step') }],
      [manageActorContentSchema, { ...scope, operation: 'list' }],
      [createEventSchema, { ...scope, eventType: 'scene', title: 'Scene', payload: {}, idempotencyKey: 'event-scope-001' }],
    ] as const;
    for (const [schema, input] of scopedInputs) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse({ ...input, playerRef: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...input, worldRef: undefined }).success).toBe(false);
      expect(schema.safeParse({ ...input, campaignRef: undefined }).success).toBe(false);
    }
  });

  it('validates create and reuse requirements without allowing silent expectations', () => {
    const base = validStartGame();
    expect(startGameSchema.safeParse(base).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, playerDisplayName: undefined }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, worldConfiguration: undefined }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, playerMode: 'reuse', playerDisplayName: undefined, worldMode: 'reuse', worldName: undefined, worldDescription: undefined, worldConfiguration: undefined }).success).toBe(true);
  });

  it('rejects protagonist inconsistencies and accepts structured profiles and origin', () => {
    const base = validStartGame();
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, code: 'other' } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, health: 21 } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, maxMana: 11 } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: { origin: {} } } }).success).toBe(false);
    expect(upsertActorSchema.safeParse({ ...scope, idempotencyKey: 'appearance-001', code: 'lyra', name: 'Lyra', actorType: 'npc', primaryAttributes, appearance: { unexpected: true } }).success).toBe(false);
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'personality-001', personality: { traits: Array.from({ length: 9 }, () => 'trait') } }).success).toBe(false);
  });

  it('accepts partial preset overrides and requires every custom dimension', () => {
    const base = validStartGame();
    expect(startGameSchema.safeParse(base).success).toBe(true);
    const custom = { ...base.campaignConfiguration, difficulty: { preset: 'custom', overrides: { errorTolerance: 3 } } };
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: custom }).success).toBe(false);
    const complete = { preset: 'custom', overrides: { errorTolerance: 3, opponentCunning: 3, resourceAvailability: 3, lethality: 3, failureSeverity: 3, narrativeSafetyNet: 3 } };
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: { ...base.campaignConfiguration, difficulty: complete } }).success).toBe(true);
  });

  it('enforces class models and mechanical starting class links', () => {
    const base = validStartGame();
    const none = { ...base.campaignConfiguration, classModel: { mode: 'none', startingClass: 'unassigned', progressionBasis: ['content'], description: 'Sem classes.' } };
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: none, protagonist: { ...base.protagonist, className: null } }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: none }).success).toBe(false);
    const classSkill = createSkill('arcane-archer');
    const classPackage = { ...classSkill, definition: {
      ...classSkill.definition, contentType: 'class' as const, name: 'Arqueiro Arcano',
      profile: {
        schemaVersion: 1 as const, rulesetCode: 'core-v1' as const, profileMode: 'mechanical' as const,
        contentKind: 'class' as const, code: 'arcane-archer', name: 'Arqueiro Arcano', description: 'Movimento discreto.',
        presentation: {}, tags: ['wind'], tier: 1, rarity: 'common' as const,
        activation: { type: 'passive' as const }, cost: { type: 'none' as const },
        grants: [{ contentKind: 'skill' as const, code: 'quiet-step' }],
      },
    } };
    const mechanical = { ...base.campaignConfiguration, classModel: { mode: 'mechanical', startingClass: 'required', progressionBasis: ['class', 'content'], description: 'Classes mecânicas.' } };
    const coherent = { ...base, campaignConfiguration: mechanical, protagonist: { ...base.protagonist, className: 'Arqueiro Arcano' }, initialContentPackages: [classPackage] };
    expect(startGameSchema.safeParse(coherent).success).toBe(true);
    expect(startGameSchema.safeParse({ ...coherent, protagonist: { ...coherent.protagonist, className: 'Mago' } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: mechanical, initialContentPackages: [] }).success).toBe(false);

    const optional = { ...base.campaignConfiguration, classModel: { ...mechanical.classModel, startingClass: 'optional' } };
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: optional, protagonist: { ...base.protagonist, className: null } }).success).toBe(true);
    const optionalKnown = { ...base, campaignConfiguration: optional, protagonist: { ...base.protagonist, className: 'Arqueiro Arcano' }, initialContentPackages: [classPackage] };
    expect(startGameSchema.safeParse(optionalKnown).success).toBe(true);
    expect(startGameSchema.safeParse({ ...optionalKnown, initialContentPackages: [{ ...classPackage, protagonistLink: { ...classPackage.protagonistLink, state: 'mastered' } }] }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...optionalKnown, initialContentPackages: [{ ...classPackage, protagonistLink: { ...classPackage.protagonistLink, state: 'locked' } }] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...optionalKnown, initialContentPackages: [{ ...classPackage, protagonistLink: { ...classPackage.protagonistLink, state: 'learning' } }] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...optionalKnown, initialContentPackages: [{ ...classPackage, protagonistLink: { ...classPackage.protagonistLink, equipped: true } }] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: optional, protagonist: { ...base.protagonist, className: 'Arqueiro Arcano' }, initialContentPackages: [] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: optional, protagonist: { ...base.protagonist, className: null }, initialContentPackages: [classPackage] }).success).toBe(false);
    const secondClass = { ...classPackage, definition: {
      ...classPackage.definition, code: 'arcane-mage', name: 'Mago Arcano',
      profile: { ...classPackage.definition.profile, code: 'arcane-mage', name: 'Mago Arcano' },
    } };
    expect(startGameSchema.safeParse({ ...optionalKnown, initialContentPackages: [classPackage, secondClass] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...optionalKnown, protagonist: { ...optionalKnown.protagonist, className: 'Mago' } }).success).toBe(false);

    const unassigned = { ...base.campaignConfiguration, classModel: { ...mechanical.classModel, startingClass: 'unassigned' } };
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: unassigned, protagonist: { ...base.protagonist, className: null } }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, campaignConfiguration: unassigned, protagonist: { ...base.protagonist, className: null }, initialContentPackages: [classPackage] }).success).toBe(false);
  });

  it('accepts create packages and restricts reuse to a World reference', () => {
    const base = validStartGame();
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [createSkill()] }).success).toBe(true);
    const draft = createSkill();
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [{ ...draft, definition: { ...draft.definition, status: 'draft' as const } }] }).success).toBe(false);
    const reuse = { definition: { mode: 'reuse', scope: 'world', code: 'quiet-step', contentType: 'skill' }, protagonistLink: createSkill().protagonistLink };
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [reuse] }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [{ ...reuse, definition: { ...reuse.definition, name: 'Forbidden' } }] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [{ ...reuse, definition: { ...reuse.definition, scope: 'campaign' } }] }).success).toBe(false);
  });

  it('rejects duplicate packages, obsolete physical link fields and unmet known requirements', () => {
    const base = validStartGame();
    const skill = createSkill();
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [skill, skill] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [{ ...skill, protagonistLink: { ...skill.protagonistLink, quantity: 0 } }] }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [{ ...skill, protagonistLink: { ...skill.protagonistLink, equipped: true } }] }).success).toBe(false);
    const passive = { ...skill, definition: {
      ...skill.definition,
      profile: { ...skill.definition.profile, activation: { type: 'passive' as const }, cost: { type: 'none' as const }, actionProfile: undefined },
    }, protagonistLink: { ...skill.protagonistLink, equipped: true } };
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [passive] }).success).toBe(false);
    const baseDependent = createSkill('dependent');
    const dependent = { ...baseDependent, definition: {
      ...baseDependent.definition,
      profile: { ...baseDependent.definition.profile, requirements: {
        requiredContent: [{ contentKind: 'skill' as const, code: 'missing' }],
        minimumPrimaryAttributes: { intelligence: 6 },
      } },
    } };
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [dependent] }).success).toBe(false);
  });

  it('validates override placement and duplicate narrative arrays', () => {
    const base = validStartGame();
    const skill = createSkill();
    const override = { ...skill, definition: { ...skill.definition, scope: 'campaign' as const, overridesWorldDefinition: true } };
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [override] }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, worldConfiguration: { ...base.worldConfiguration, genres: ['fantasy', 'fantasy'] } }).success).toBe(false);
  });

  it('enforces payload and metadata limits', () => {
    const base = validStartGame();
    const tooManyKeys = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`k${index}`, index]));
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: tooManyKeys } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: { a: { b: { c: { d: { e: { f: 1 } } } } } } } }).success).toBe(false);
    const skill = createSkill();
    const huge = { ...skill, definition: { ...skill.definition, profile: { ...skill.definition.profile, lore: 'x'.repeat(82_000) } } };
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: [huge] }).success).toBe(false);
  });

  it('measures byte limits in UTF-8 for metadata, profiles and the full payload', () => {
    const base = validStartGame();
    expect(jsonByteSize('ação')).toBe(Buffer.byteLength(JSON.stringify('ação'), 'utf8'));
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: { text: 'a'.repeat(3_000) } } }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: { text: 'é'.repeat(2_050) } } }).success).toBe(false);
    const features = Array.from({ length: 8 }, () => '😀'.repeat(120));
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, appearance: { distinctiveFeatures: features } } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, personality: { traits: features } } }).success).toBe(false);
    const skill = createSkill();
    const multibytePayload = Array.from({ length: 24 }, (_, index) => {
      const code = `multibyte-${String(index).padStart(2, '0')}`;
      const name = `Multibyte ${index}`;
      return { ...skill, definition: {
        ...skill.definition, code, name,
        profile: { ...skill.definition.profile, code, name, lore: '😀'.repeat(900) },
      } };
    });
    const result = startGameSchema.safeParse({ ...base, initialContentPackages: multibytePayload });
    expect(result.success).toBe(false);
    if (!result.success) {
      const sizeIssue = result.error.issues.find((issue) => issue.path.length === 0);
      expect(sizeIssue?.message).toContain('81920 bytes');
      expect(JSON.stringify(result.error.issues)).not.toContain('😀');
    }
  });

  it('counts recursive metadata keys, arrays and aggregate bytes without prototype promotion', () => {
    const base = validStartGame();
    const nested = { list: [{ first: 1 }, { second: { third: 3 } }] };
    expect(jsonKeyCount(nested)).toBe(4);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => jsonDepth(cyclic)).not.toThrow();
    expect(() => jsonKeyCount(cyclic)).not.toThrow();
    expect(jsonByteSize(cyclic)).toBe(Number.POSITIVE_INFINITY);

    const dangerous = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, metadata: dangerous } }).success).toBe(false);
    expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();

    const packages = Array.from({ length: 6 }, (_, index) => {
      const item = createSkill(`metadata-${index}`);
      return { ...item, definition: { ...item.definition, metadata: { text: 'é'.repeat(1_750) } } };
    });
    expect(packages.every((item) => jsonByteSize(item.definition.metadata) < 4_096)).toBe(true);
    expect(startGameSchema.safeParse({ ...base, initialContentPackages: packages }).success).toBe(false);
  });

  it('allows only approved actor patch fields and requires complete standalone content definitions', () => {
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'actor-patch-001', name: 'Novo Nome', appearance: { hair: 'black' } }).success).toBe(true);
    for (const field of ['health', 'maxHealth', 'mana', 'maxMana', 'sp', 'primaryAttributes', 'attributes', 'resistances', 'affinities', 'level', 'xp', 'gold']) {
      expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: `reject-${field}-001`, [field]: field === 'primaryAttributes' ? primaryAttributes : 10 }).success).toBe(false);
    }
    expect(patchActorSchema.safeParse({ ...scope, idempotencyKey: 'actor-patch-002', campaignId: 'forbidden' }).success).toBe(false);
    const content = { ...scope, idempotencyKey: 'content-schema-001', ...skillPublicationInput() };
    expect(upsertContentSchema.safeParse(content).success).toBe(true);
    const { profile: _profile, ...incomplete } = content;
    void _profile;
    expect(upsertContentSchema.safeParse(incomplete).success).toBe(false);
  });

  it('reuses core-v1 creation validation for all nine primary attributes', () => {
    const base = validStartGame();
    const total89 = { ...primaryAttributes, luck: 9 };
    const total91 = { ...primaryAttributes, luck: 11 };
    const unknown = { ...primaryAttributes, courage: 10 };
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, primaryAttributes } }).success).toBe(true);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, primaryAttributes: total89 } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, primaryAttributes: total91 } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, primaryAttributes: unknown } }).success).toBe(false);
    expect(startGameSchema.safeParse({ ...base, protagonist: { ...base.protagonist, primaryAttributes, criticalChanceBps: 2500 } }).success).toBe(false);
  });

  it('requires idempotency only for actor-content writes', () => {
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'list' }).success).toBe(true);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill' }).success).toBe(false);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'learn-schema-001' }).success).toBe(true);
  });

  it('validates inventory operations with optimistic concurrency and operation-specific fields', () => {
    expect(manageActorInventorySchema.safeParse({ ...scope, operation: 'get' }).success).toBe(true);
    expect(manageActorInventorySchema.safeParse({ ...scope, operation: 'get', idempotencyKey: 'forbidden-get' }).success).toBe(false);
    const grant = {
      ...scope, operation: 'grant', idempotencyKey: 'inventory-grant-001', expectedInventoryStateVersion: 1,
      contentRef: { scope: 'world', contentType: 'weapon', code: 'dagger', versionNumber: 1 },
      quantity: 1, entryRefs: ['dagger-1'],
    };
    expect(manageActorInventorySchema.safeParse(grant).success).toBe(true);
    expect(manageActorInventorySchema.safeParse({ ...grant, expectedInventoryStateVersion: undefined }).success).toBe(false);
    expect(manageActorInventorySchema.safeParse({ ...grant, entryRefs: ['dagger-1', 'dagger-1'] }).success).toBe(false);
    expect(manageActorInventorySchema.safeParse({ ...scope, operation: 'equip', idempotencyKey: 'inventory-equip-001', expectedInventoryStateVersion: 2, entryRef: 'dagger-1', quantity: 1 }).success).toBe(false);
    expect(manageActorContentSchema.safeParse({ ...scope, operation: 'equip', contentRef: 'dagger', contentType: 'weapon', idempotencyKey: 'old-equip' }).success).toBe(false);
  });

  it('validates closed effect operations and never accepts client rolls', () => {
    expect(resolveActorEffectSchema.safeParse({ ...scope, operation: 'get', sourceActorRef: 'ralph' }).success).toBe(true);
    expect(resolveActorEffectSchema.safeParse({ ...scope, operation: 'get', sourceActorRef: 'ralph', idempotencyKey: 'forbidden-roll-read' }).success).toBe(false);
    const expectedSourceState = {
      mechanicsStateVersion: 1, inventoryStateVersion: 1, effectsStateVersion: 1,
      resourceStateVersions: { hp: 1, mana: 1, sp: 1 },
    };
    const execute = {
      ...scope, operation: 'execute_content', sourceActorRef: 'ralph', targetActorRef: 'lyra',
      contentRef: { contentType: 'spell', code: 'arcane-mark', versionNumber: 1 },
      expectedSourceState, expectedTargetState: expectedSourceState, idempotencyKey: 'effect-execute-001',
    };
    expect(resolveActorEffectSchema.safeParse(execute).success).toBe(true);
    expect(resolveActorEffectSchema.safeParse({ ...execute, rolls: { hitRollBps: 1, criticalRollBps: 1 } }).success).toBe(false);
    expect(resolveActorEffectSchema.safeParse({ ...execute, expectedTargetState: undefined }).success).toBe(false);
    expect(resolveActorEffectSchema.safeParse({
      ...scope, operation: 'use_consumable', sourceActorRef: 'ralph', targetActorRef: 'ralph',
      inventoryEntryRef: 'potion-1', expectedSourceState, idempotencyKey: 'effect-consume-001',
    }).success).toBe(true);
  });
});
