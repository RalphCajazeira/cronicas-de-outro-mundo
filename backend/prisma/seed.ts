import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, PrismaClient } from '../src/generated/prisma/client.js';
import { createActorMechanicalState, loadActorMechanicalSheet } from '../src/modules/actors/actor-mechanics.service.js';
import { getInitialAttributePreset } from '../src/modules/rules/core-v1/index.js';
import { ensureCoreV1RulesetVersion } from '../src/modules/rules/ruleset.registry.js';
import { publishContentVersion } from '../src/modules/content/content-publication.service.js';

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.length === 0) throw new Error('Invalid application configuration');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function main() {
  await prisma.$transaction(async (transaction) => {
    const rulesetVersion = await ensureCoreV1RulesetVersion(transaction);
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
  });
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
