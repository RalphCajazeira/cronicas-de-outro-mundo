import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, PrismaClient } from '../src/generated/prisma/client.js';
import { createActorMechanicalState, loadActorMechanicalSheet } from '../src/modules/actors/actor-mechanics.service.js';
import { getInitialAttributePreset } from '../src/modules/rules/core-v1/index.js';
import { ensureCoreV1RulesetVersion } from '../src/modules/rules/ruleset.registry.js';
import { publishContentVersion } from '../src/modules/content/content-publication.service.js';
import { ensureCoreV1InventoryRulesVersion } from '../src/modules/rules/inventory-rules.registry.js';
import { manageActorInventory } from '../src/modules/inventory/inventory.service.js';
import { ensureCoreV1EffectRulesVersion } from '../src/modules/rules/effect-rules.registry.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) throw new Error('Invalid application configuration');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  await prisma.$transaction(async (transaction) => {
    const rulesetVersion = await ensureCoreV1RulesetVersion(transaction);
    await ensureCoreV1InventoryRulesVersion(transaction);
    await ensureCoreV1EffectRulesVersion(transaction);
    const player = await transaction.player.upsert({ where: { slug: 'ralph' }, update: { displayName: 'Ralph' }, create: { slug: 'ralph', displayName: 'Ralph' } });
    const world = await transaction.world.upsert({
      where: { playerId_code: { playerId: player.id, code: 'elarion' } },
      update: { name: 'Elarion' },
      create: { playerId: player.id, defaultRulesetVersionId: rulesetVersion.id, code: 'elarion', name: 'Elarion' },
    });
    const campaign = await transaction.campaign.upsert({
      where: { worldId_code: { worldId: world.id, code: 'main-campaign' } },
      update: { name: 'Campanha Principal', status: CampaignStatus.ACTIVE },
      create: {
        worldId: world.id, rulesetVersionId: world.defaultRulesetVersionId,
        code: 'main-campaign', name: 'Campanha Principal', status: CampaignStatus.ACTIVE,
      },
    });
    const ralph = await transaction.actor.upsert({
      where: { campaignId_code: { campaignId: campaign.id, code: 'ralph' } },
      update: {},
      create: { campaignId: campaign.id, code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, className: 'Aventureiro', level: 1, status: ActorStatus.ACTIVE },
    });
    if (await transaction.actorAttribute.count({ where: { actorId: ralph.id } }) === 0) {
      await createActorMechanicalState(transaction, { actorId: ralph.id, primaryAttributes: getInitialAttributePreset('physical') });
    } else {
      await loadActorMechanicalSheet(transaction, ralph.id);
    }
    const lyra = await transaction.actor.upsert({
      where: { campaignId_code: { campaignId: campaign.id, code: 'lyra' } }, update: {},
      create: { campaignId: campaign.id, code: 'lyra', name: 'Lyra', actorType: ActorType.SPIRIT, species: 'Raposa espiritual', role: 'Guia', level: 1, status: ActorStatus.ACTIVE },
    });
    if (await transaction.actorAttribute.count({ where: { actorId: lyra.id } }) === 0) {
      await createActorMechanicalState(transaction, { actorId: lyra.id, primaryAttributes: getInitialAttributePreset('magical') });
    } else {
      await loadActorMechanicalSheet(transaction, lyra.id);
    }
    const markedDescription = 'Uma marca arcana de curta duração.';
    await publishContentVersion(transaction, {
      worldId: world.id, campaignId: campaign.id, code: 'seed-arcane-mark', contentType: ContentType.STATUS_EFFECT,
      name: 'Marca Arcana', description: markedDescription,
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'status_effect',
        code: 'seed-arcane-mark', name: 'Marca Arcana', description: markedDescription,
        tier: 1, rarity: 'common', activation: { type: 'passive' }, cost: { type: 'none' },
        duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' },
        passiveModifiers: [{ target: 'magicalDefense', amount: -1, sourceRule: 'status_effect' }],
      },
      presentation: {}, tags: ['seed', 'status'], status: ContentStatus.ACTIVE, metadata: {},
    });
    const markSpell = await publishContentVersion(transaction, {
      worldId: world.id, campaignId: campaign.id, code: 'seed-mark-spell', contentType: ContentType.SPELL,
      name: 'Selo Arcano', description: 'Aplica uma marca arcana ao alvo.',
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'spell',
        code: 'seed-mark-spell', name: 'Selo Arcano', description: 'Aplica uma marca arcana ao alvo.',
        tier: 1, rarity: 'common', activation: { type: 'active' }, cost: { type: 'mana', amount: 3 },
        actionProfile: 'normal', targeting: { type: 'single_target', rangeBand: 'near', maxTargets: 1 },
        effects: [{ type: 'apply_status', statusRef: 'seed-arcane-mark', duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' } }],
      },
      presentation: {}, tags: ['seed', 'spell'], status: ContentStatus.ACTIVE, metadata: {},
    });
    const markSpellVersion = markSpell.versions[0];
    if (markSpellVersion === undefined) throw new Error('Seed status binding publication is incomplete');
    await transaction.actorContent.upsert({
      where: { actorId_contentDefinitionId: { actorId: ralph.id, contentDefinitionId: markSpell.id } },
      update: { contentVersionId: markSpellVersion.id, state: ActorContentState.KNOWN, rank: 1 },
      create: {
        actorId: ralph.id, contentDefinitionId: markSpell.id, contentVersionId: markSpellVersion.id,
        state: ActorContentState.KNOWN, rank: 1,
      },
    });
    const breezeDescription = 'Um deslocamento leve guiado pela afinidade com o vento.';
    const breezePresentation = { summary: 'Movimento leve guiado pelo vento.' };
    const breezeTags = ['wind', 'movement'];
    const breezeStep = await publishContentVersion(transaction, {
      worldId: world.id,
      campaignId: campaign.id,
      code: 'wind_breeze_step',
      contentType: ContentType.SKILL,
      name: 'Passo da Brisa',
      description: breezeDescription,
      profile: {
        schemaVersion: 1,
        rulesetCode: 'core-v1',
        profileMode: 'mechanical',
        contentKind: 'skill',
        code: 'wind_breeze_step',
        name: 'Passo da Brisa',
        description: breezeDescription,
        presentation: breezePresentation,
        tags: breezeTags,
        tier: 1,
        rarity: 'common',
        activation: { type: 'active' },
        cost: { type: 'sp', amount: 3 },
        actionProfile: 'normal',
        effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
      },
      presentation: breezePresentation,
      tags: breezeTags,
      status: ContentStatus.ACTIVE,
      metadata: {},
    });
    const breezeVersion = breezeStep.versions[0];
    if (breezeVersion === undefined) throw new Error('Seed content publication is incomplete');
    await transaction.actorContent.upsert({
      where: { actorId_contentDefinitionId: { actorId: ralph.id, contentDefinitionId: breezeStep.id } },
      update: { state: ActorContentState.LEARNING, rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' },
      create: { actorId: ralph.id, contentDefinitionId: breezeStep.id, contentVersionId: breezeVersion.id, state: ActorContentState.LEARNING, rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' },
    });

    const daggerDescription = 'Uma adaga simples, leve e confiável.';
    const dagger = await publishContentVersion(transaction, {
      worldId: world.id,
      campaignId: campaign.id,
      code: 'starter-dagger',
      contentType: ContentType.WEAPON,
      name: 'Adaga Inicial',
      description: daggerDescription,
      profile: {
        schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical', contentKind: 'weapon',
        code: 'starter-dagger', name: 'Adaga Inicial', description: daggerDescription,
        presentation: {}, tags: ['weapon', 'dagger'], tier: 1, rarity: 'common',
        activation: { type: 'active' }, cost: { type: 'none' }, actionProfile: 'dagger',
        targeting: { type: 'single_target', rangeBand: 'engaged', maxTargets: 1 },
        damageComponents: [{ id: 'blade', channel: 'physical', element: null, baseDamage: 3, scaling: 'full', canCrit: true }],
        handedness: 'one_handed', weaponTags: ['dagger'],
      },
      inventorySpec: {
        schemaVersion: 1, rulesetCode: 'core-v1', inventoryRulesCode: 'core-v1-inventory-v1',
        unitWeight: 10, stacking: { mode: 'unique' }, equipmentSlots: ['main_hand'], handedness: 'one_handed',
      },
      presentation: {}, tags: ['weapon', 'dagger'], status: ContentStatus.ACTIVE, metadata: {},
    });
    if (await transaction.inventoryEntry.count({ where: { actorId: ralph.id, entryRef: 'starter-dagger-1' } }) === 0) {
      const daggerVersion = dagger.versions[0];
      if (daggerVersion === undefined) throw new Error('Seed inventory publication is incomplete');
      const currentActor = await transaction.actor.findUniqueOrThrow({ where: { id: ralph.id }, select: { inventoryStateVersion: true } });
      await manageActorInventory(transaction, ralph.code, {
        playerRef: player.slug, worldRef: world.code, campaignRef: campaign.code,
        operation: 'grant', idempotencyKey: 'seed-starter-dagger',
        expectedInventoryStateVersion: currentActor.inventoryStateVersion,
        contentRef: { scope: 'campaign', contentType: 'weapon', code: dagger.code, versionNumber: daggerVersion.versionNumber },
        quantity: 1, entryRefs: ['starter-dagger-1'],
      });
    }
  });
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
