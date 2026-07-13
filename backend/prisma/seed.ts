import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { ActorContentState, ActorStatus, ActorType, CampaignStatus, ContentStatus, ContentType, PrismaClient } from '../src/generated/prisma/client.js';
import { ensureCoreV1RulesetVersion } from '../src/modules/rules/ruleset.registry.js';

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
      create: { campaignId: campaign.id, code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, className: 'Aventureiro', level: 1, health: 20, maxHealth: 20, mana: 10, maxMana: 10, attributes: { strength: 5, agility: 6, intelligence: 5, vitality: 5 }, status: ActorStatus.ACTIVE },
    });
    await transaction.actor.upsert({
      where: { campaignId_code: { campaignId: campaign.id, code: 'lyra' } }, update: {},
      create: { campaignId: campaign.id, code: 'lyra', name: 'Lyra', actorType: ActorType.SPIRIT, species: 'Raposa espiritual', role: 'Guia', level: 1, health: 14, maxHealth: 14, mana: 18, maxMana: 18, attributes: { strength: 2, agility: 8, intelligence: 7, vitality: 4 }, affinities: { wind: 1 }, status: ActorStatus.ACTIVE },
    });
    const breezeStep = await transaction.contentDefinition.upsert({
      where: { worldId_campaignId_contentType_code: { worldId: world.id, campaignId: campaign.id, contentType: ContentType.SKILL, code: 'wind_breeze_step' } },
      update: {},
      create: { worldId: world.id, campaignId: campaign.id, code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: ContentType.SKILL, description: 'Um deslocamento leve guiado pela afinidade com o vento.', mechanics: { effect: 'mobility', movementBonus: 2 }, requirements: { level: 1 }, presentation: { element: 'wind' }, tags: ['wind', 'movement'], schemaVersion: 1, status: ContentStatus.ACTIVE },
    });
    await transaction.actorContent.upsert({
      where: { actorId_contentDefinitionId: { actorId: ralph.id, contentDefinitionId: breezeStep.id } },
      update: { state: ActorContentState.LEARNING, rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' },
      create: { actorId: ralph.id, contentDefinitionId: breezeStep.id, state: ActorContentState.LEARNING, rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' },
    });
  });
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
