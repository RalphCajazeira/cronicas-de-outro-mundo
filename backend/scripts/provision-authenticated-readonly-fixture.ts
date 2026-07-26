import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActiveEffectDurationType,
  ActiveEffectKind,
  ActorContentState,
  ActorControlPermission,
  ActorEquipmentSlotRef,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  ContentStatus,
  ContentType,
  InventoryEntryKind,
  InventoryInstanceLifecycle,
  Prisma,
  UserStatus,
  type PrismaClient,
} from '../src/generated/prisma/client.js';
import {
  createActorMechanicalState,
  loadActorMechanicalSheet,
  recomputeActorDerivedSnapshot,
} from '../src/modules/actors/actor-mechanics.service.js';
import {
  publishContentVersion,
  resolveContentPublicationRegistryContext,
  type ContentPublicationInput,
  type PublishedContent,
} from '../src/modules/content/content-publication.service.js';
import { materializeStarterContentBlueprint } from '../src/modules/content/starter-content-blueprints.js';
import { CORE_V1_3_VERSION_CODE } from '../src/modules/rules/core-v1/core-v1.progression-v3.js';
import { getInitialAttributePreset } from '../src/modules/rules/core-v1/index.js';
import { ensureCurrentCoreRulesetVersion } from '../src/modules/rules/ruleset.registry.js';
import { validateStagingTarget } from './staging-database.js';
import {
  AUTHENTICATED_FIXTURE_MANIFEST_PATH,
  parseAuthenticatedFixtureManifest,
  type AuthenticatedFixtureManifest,
} from './staging-provisioning-manifest.js';

export const AUTHENTICATED_FIXTURE_PROJECT_REF = 'udqwzvhlwwfnngiipacj';
export const AUTHENTICATED_FIXTURE_ISSUER =
  `https://${AUTHENTICATED_FIXTURE_PROJECT_REF}.supabase.co/auth/v1`;

const expectedDatabase = 'postgres';
const expectedRole = 'cronicas_staging_app';
const expectedSchema = 'public';
const repositoryRoot = resolve(import.meta.dirname, '../..');
const manifestPath = resolve(repositoryRoot, AUTHENTICATED_FIXTURE_MANIFEST_PATH);
const subjectPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const AUTHENTICATED_FIXTURE = {
  playerSlug: 'oauth-staging-tester',
  playerName: 'OAuth Staging Tester',
  worldCode: 'oauth-test-world',
  worldName: 'OAuth Test World',
  campaignCode: 'oauth-readonly-test',
  campaignName: 'OAuth Readonly Test',
  actorCode: 'test-adventurer',
  actorName: 'Test Adventurer',
  actorSpecies: 'Humana',
  actorClassName: 'Explorador',
  actorRole: 'Aventureiro',
  actorDescription: 'Personagem sintético para validar a experiência autenticada somente leitura.',
} as const;

export type FixtureProvisionMode = 'dry-run' | 'apply' | 'postflight';
type FixtureRecordType =
  | 'player'
  | 'world'
  | 'campaign'
  | 'actor'
  | 'campaignMembership'
  | 'actorControl'
  | 'actorAttribute'
  | 'actorResource'
  | 'actorDerivedSnapshot'
  | 'contentDefinition'
  | 'contentVersion'
  | 'inventoryEntry'
  | 'equipmentSlot'
  | 'actorContent'
  | 'activeEffect';
type FixtureRecordCounts = Record<FixtureRecordType, number>;

export interface FixtureProvisioningResult {
  readonly operationId: string;
  readonly environment: 'staging';
  readonly mode: FixtureProvisionMode;
  readonly created: FixtureRecordCounts;
  readonly reused: FixtureRecordCounts;
  readonly conflicts: readonly string[];
  readonly postflight: FixtureRecordCounts;
  readonly isolationVerified: true;
}

interface FixtureProvisioningInput {
  readonly mode: FixtureProvisionMode;
  readonly manifest: AuthenticatedFixtureManifest;
  readonly issuer: string;
  readonly subject: string;
}

export class FixtureProvisioningError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}

class DryRunRollback extends Error {
  constructor(readonly result: FixtureProvisioningResult) {
    super('Dry-run rollback');
  }
}

function emptyRecordCounts(): FixtureRecordCounts {
  return {
    player: 0,
    world: 0,
    campaign: 0,
    actor: 0,
    campaignMembership: 0,
    actorControl: 0,
    actorAttribute: 0,
    actorResource: 0,
    actorDerivedSnapshot: 0,
    contentDefinition: 0,
    contentVersion: 0,
    inventoryEntry: 0,
    equipmentSlot: 0,
    actorContent: 0,
    activeEffect: 0,
  };
}

function expectedRecordCounts(): FixtureRecordCounts {
  return {
    player: 1,
    world: 1,
    campaign: 1,
    actor: 1,
    campaignMembership: 1,
    actorControl: 1,
    actorAttribute: 9,
    actorResource: 3,
    actorDerivedSnapshot: 1,
    contentDefinition: 7,
    contentVersion: 7,
    inventoryEntry: 3,
    equipmentSlot: 1,
    actorContent: 3,
    activeEffect: 1,
  };
}

function increment(counts: FixtureRecordCounts, type: FixtureRecordType): void {
  counts[type] += 1;
}

function incrementBy(counts: FixtureRecordCounts, type: FixtureRecordType, amount: number): void {
  counts[type] += amount;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new FixtureProvisioningError(`missing_${name.toLowerCase()}`);
  }
  return value;
}

function exactRecord(condition: boolean, safeCode: string): asserts condition {
  if (!condition) throw new FixtureProvisioningError(safeCode);
}

const fixtureContentCodes = [
  'oauth-test-travel-coat',
  'oauth-test-healing-tonic',
  'oauth-test-field-note',
  'oauth-test-quick-step',
  'oauth-test-focused',
  'oauth-test-focus-veil',
  'oauth-test-steady-focus',
] as const;

function publicationInput(
  worldId: string,
  campaignId: string,
  code: typeof fixtureContentCodes[number],
): ContentPublicationInput {
  const common = {
    worldId,
    campaignId,
    code,
    presentation: {},
    tags: ['oauth-test'],
    status: ContentStatus.ACTIVE,
    metadata: {},
  } as const;
  if (code === 'oauth-test-travel-coat') {
    const description = 'Proteção sintética de viagem equipada no corpo.';
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint: 'starter_body_armor',
      code,
      name: 'Casaco de Viagem',
    });
    return {
      ...common,
      contentType: ContentType.ARMOR,
      name: 'Casaco de Viagem',
      description,
      profile: { ...blueprint.profile, description, tags: ['oauth-test'] },
      inventorySpec: blueprint.inventorySpec,
    };
  }
  if (code === 'oauth-test-healing-tonic') {
    const description = 'Consumível sintético que restaura HP.';
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint: 'basic_healing_consumable',
      code,
      name: 'Tônico de Treino',
    });
    return {
      ...common,
      contentType: ContentType.CONSUMABLE,
      name: 'Tônico de Treino',
      description,
      profile: { ...blueprint.profile, description, tags: ['oauth-test'] },
      inventorySpec: blueprint.inventorySpec,
    };
  }
  if (code === 'oauth-test-field-note') {
    return {
      ...common,
      contentType: ContentType.ITEM,
      name: 'Anotações de Campo',
      description: 'Registro narrativo sintético sem segredo de mestre.',
      profile: {
        schemaVersion: 1,
        rulesetCode: 'core-v1',
        profileMode: 'narrative',
        contentKind: 'item',
        code,
        name: 'Anotações de Campo',
        description: 'Registro narrativo sintético sem segredo de mestre.',
        tags: ['oauth-test'],
      },
      inventorySpec: {
        schemaVersion: 1,
        rulesetCode: 'core-v1',
        inventoryRulesCode: 'core-v1-inventory-v1',
        unitWeight: 1,
        stacking: { mode: 'unique' },
      },
    };
  }
  if (code === 'oauth-test-quick-step') {
    const description = 'Técnica sintética de mobilidade.';
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint: 'basic_mobility_skill',
      code,
      name: 'Passo Rápido',
    });
    return {
      ...common,
      contentType: ContentType.SKILL,
      name: 'Passo Rápido',
      description,
      profile: { ...blueprint.profile, description, tags: ['oauth-test'] },
    };
  }
  if (code === 'oauth-test-focus-veil') {
    const description = 'Magia sintética de ataque de alvo único.';
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint: 'basic_offensive_spell',
      code,
      name: 'Faísca Arcana',
      damageElement: 'arcane',
    });
    return {
      ...common,
      contentType: ContentType.SPELL,
      name: 'Faísca Arcana',
      description,
      profile: { ...blueprint.profile, description, tags: ['oauth-test'] },
    };
  }
  if (code === 'oauth-test-focused') {
    const description = 'Estado sintético temporário e público.';
    const blueprint = materializeStarterContentBlueprint({
      starterBlueprint: 'shadow_wrapped_status',
      code,
      name: 'Foco de Treino',
    });
    return {
      ...common,
      contentType: ContentType.STATUS_EFFECT,
      name: 'Foco de Treino',
      description,
      profile: { ...blueprint.profile, description, tags: ['oauth-test'] },
    };
  }
  return {
    ...common,
    contentType: ContentType.TALENT,
    name: 'Concentração Estável',
    description: 'Talento passivo sintético de precisão.',
    profile: {
      schemaVersion: 1,
      rulesetCode: 'core-v1',
      profileMode: 'mechanical',
      contentKind: 'talent',
      code,
      name: 'Concentração Estável',
      description: 'Talento passivo sintético de precisão.',
      tags: ['oauth-test'],
      tier: 1,
      rarity: 'common',
      activation: { type: 'passive' },
      cost: { type: 'none' },
      passiveModifiers: [{
        target: 'accuracy',
        amount: 1,
        sourceRule: 'content_intrinsic',
      }],
    },
  };
}

function latestVersion(content: PublishedContent) {
  const version = content.versions[0];
  exactRecord(version !== undefined, 'fixture_content_version_missing');
  return version;
}

function requiredPublished(
  published: ReadonlyMap<string, PublishedContent>,
  code: typeof fixtureContentCodes[number],
): PublishedContent {
  const content = published.get(code);
  exactRecord(content !== undefined, 'fixture_published_content_missing');
  return content;
}

export function parseFixtureProvisionMode(arguments_: readonly string[]): FixtureProvisionMode {
  const requested = arguments_.filter((argument) =>
    argument === '--dry-run' || argument === '--apply' || argument === '--postflight');
  if (requested.length !== 1) throw new FixtureProvisioningError('invalid_mode');
  if (requested[0] === '--apply') return 'apply';
  if (requested[0] === '--postflight') return 'postflight';
  return 'dry-run';
}

export function validateAuthenticatedFixtureProvisioningEnvironment(input: {
  readonly appEnvironment: string;
  readonly projectRef: string;
  readonly connectionString: string;
  readonly issuer: string;
  readonly subject: string;
}): void {
  exactRecord(input.appEnvironment === 'staging', 'environment_not_staging');
  exactRecord(input.projectRef === AUTHENTICATED_FIXTURE_PROJECT_REF, 'project_ref_not_allowlisted');
  exactRecord(input.issuer === AUTHENTICATED_FIXTURE_ISSUER, 'issuer_not_allowlisted');
  exactRecord(subjectPattern.test(input.subject), 'subject_invalid');
  validateStagingTarget(input.connectionString, {
    projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
    database: expectedDatabase,
    role: expectedRole,
    schema: expectedSchema,
  });
}

export async function resolveSyntheticUser(
  transaction: Prisma.TransactionClient,
  issuer: string,
  subject: string,
): Promise<{ id: string }> {
  const [identities, totalUsers, totalIdentities] = await Promise.all([
    transaction.externalIdentity.findMany({
      where: { issuer, subject },
      select: {
        user: {
          select: {
            id: true,
            status: true,
            suspendedAt: true,
            deletedAt: true,
          },
        },
      },
      take: 2,
    }),
    transaction.user.count(),
    transaction.externalIdentity.count(),
  ]);
  exactRecord(totalUsers === 1 && totalIdentities === 1, 'identity_graph_not_isolated');
  exactRecord(identities.length === 1, 'external_identity_not_unique');
  const user = identities[0]?.user;
  exactRecord(user !== undefined, 'synthetic_user_missing');
  exactRecord(
    user.status === UserStatus.ACTIVE
      && user.suspendedAt === null
      && user.deletedAt === null,
    'synthetic_user_inactive',
  );
  return { id: user.id };
}

async function inspectFixtureGraph(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<FixtureRecordCounts> {
  const player = await transaction.player.findUnique({
    where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
  });
  exactRecord(
    player !== null
      && player.userId === userId
      && player.displayName === AUTHENTICATED_FIXTURE.playerName,
    'fixture_player_postflight_failed',
  );
  const world = await transaction.world.findUnique({
    where: {
      playerId_code: {
        playerId: player.id,
        code: AUTHENTICATED_FIXTURE.worldCode,
      },
    },
  });
  exactRecord(
    world !== null
      && world.name === AUTHENTICATED_FIXTURE.worldName
      && world.description === null
      && JSON.stringify(world.metadata) === '{}',
    'fixture_world_postflight_failed',
  );
  const campaign = await transaction.campaign.findUnique({
    where: {
      worldId_code: {
        worldId: world.id,
        code: AUTHENTICATED_FIXTURE.campaignCode,
      },
    },
  });
  exactRecord(
    campaign !== null
      && campaign.name === AUTHENTICATED_FIXTURE.campaignName
      && campaign.status === CampaignStatus.ACTIVE
      && campaign.currentTime === null
      && JSON.stringify(campaign.metadata) === '{}',
    'fixture_campaign_postflight_failed',
  );
  const actor = await transaction.actor.findUnique({
    where: {
      campaignId_code: {
        campaignId: campaign.id,
        code: AUTHENTICATED_FIXTURE.actorCode,
      },
    },
  });
  exactRecord(
    actor !== null
      && actor.name === AUTHENTICATED_FIXTURE.actorName
      && actor.actorType === ActorType.CHARACTER
      && actor.status === ActorStatus.ACTIVE
      && actor.level === 3
      && actor.xp === 75
      && actor.gold === 42
      && actor.species === AUTHENTICATED_FIXTURE.actorSpecies
      && actor.className === AUTHENTICATED_FIXTURE.actorClassName
      && actor.role === AUTHENTICATED_FIXTURE.actorRole
      && actor.description === AUTHENTICATED_FIXTURE.actorDescription
      && JSON.stringify(actor.metadata) === '{}',
    'fixture_actor_postflight_failed',
  );
  const [membership, control] = await Promise.all([
    transaction.campaignMembership.findUnique({
      where: { campaignId_userId: { campaignId: campaign.id, userId } },
    }),
    transaction.actorControl.findUnique({
      where: { actorId_userId: { actorId: actor.id, userId } },
    }),
  ]);
  exactRecord(
    membership !== null
      && membership.role === CampaignMembershipRole.PLAYER
      && membership.status === CampaignMembershipStatus.ACTIVE
      && membership.revokedAt === null
      && membership.grantedByUserId === null,
    'fixture_membership_postflight_failed',
  );
  exactRecord(
    control !== null
      && control.permission === ActorControlPermission.CONTROL
      && control.revokedAt === null,
    'fixture_control_postflight_failed',
  );

  const [
    linkedPlayers,
    playerWorlds,
    worldsWithCode,
    worldCampaigns,
    campaignsWithCode,
    campaignActors,
    actorsWithCode,
    campaignMemberships,
    actorControls,
    encounters,
    inventoryEntries,
    actorContent,
    gameEvents,
    nonPlayerActors,
    worldContent,
    actorAttributes,
    actorResources,
    actorDerivedSnapshots,
    contentVersions,
    equipmentSlots,
    activeEffects,
  ] = await Promise.all([
    transaction.player.count({ where: { userId } }),
    transaction.world.count({ where: { playerId: player.id } }),
    transaction.world.count({ where: { code: AUTHENTICATED_FIXTURE.worldCode } }),
    transaction.campaign.count({ where: { worldId: world.id } }),
    transaction.campaign.count({ where: { code: AUTHENTICATED_FIXTURE.campaignCode } }),
    transaction.actor.count({ where: { campaignId: campaign.id } }),
    transaction.actor.count({ where: { code: AUTHENTICATED_FIXTURE.actorCode } }),
    transaction.campaignMembership.count({ where: { campaignId: campaign.id } }),
    transaction.actorControl.count({ where: { actorId: actor.id } }),
    transaction.encounter.count({ where: { campaignId: campaign.id } }),
    transaction.inventoryEntry.count({ where: { actorId: actor.id } }),
    transaction.actorContent.count({ where: { actorId: actor.id } }),
    transaction.gameEvent.count({ where: { campaignId: campaign.id } }),
    transaction.actor.count({
      where: { campaignId: campaign.id, actorType: { not: ActorType.CHARACTER } },
    }),
    transaction.contentDefinition.count({
      where: {
        worldId: world.id,
        campaignId: campaign.id,
        code: { in: [...fixtureContentCodes] },
      },
    }),
    transaction.actorAttribute.count({ where: { actorId: actor.id } }),
    transaction.actorResource.count({ where: { actorId: actor.id } }),
    transaction.actorDerivedSnapshot.count({ where: { actorId: actor.id } }),
    transaction.contentVersion.count({
      where: {
        contentDefinition: {
          worldId: world.id,
          campaignId: campaign.id,
          code: { in: [...fixtureContentCodes] },
        },
      },
    }),
    transaction.actorEquipmentSlot.count({ where: { actorId: actor.id } }),
    transaction.activeEffect.count({ where: { targetActorId: actor.id } }),
  ]);
  exactRecord(
    linkedPlayers === 1
      && playerWorlds === 1
      && worldsWithCode === 1
      && worldCampaigns === 1
      && campaignsWithCode === 1
      && campaignActors === 1
      && actorsWithCode === 1
      && campaignMemberships === 1
      && actorControls === 1
      && encounters === 0
      && inventoryEntries === 3
      && actorContent === 3
      && gameEvents === 0
      && nonPlayerActors === 0
      && worldContent === 7
      && actorAttributes === 9
      && actorResources === 3
      && actorDerivedSnapshots === 1
      && contentVersions === 7
      && equipmentSlots === 1
      && activeEffects === 1,
    'fixture_isolation_postflight_failed',
  );
  const contentCodes = await transaction.contentDefinition.findMany({
    where: { worldId: world.id },
    select: { code: true, campaignId: true },
    orderBy: { code: 'asc' },
  });
  exactRecord(
    contentCodes.length === fixtureContentCodes.length
      && contentCodes.every((content) =>
        content.campaignId === campaign.id
        && fixtureContentCodes.includes(content.code as typeof fixtureContentCodes[number])),
    'fixture_content_allowlist_postflight_failed',
  );
  await loadActorMechanicalSheet(transaction, actor.id);
  return expectedRecordCounts();
}

async function provisionFixture(
  transaction: Prisma.TransactionClient,
  input: FixtureProvisioningInput,
): Promise<FixtureProvisioningResult> {
  const created = emptyRecordCounts();
  const reused = emptyRecordCounts();
  const user = await resolveSyntheticUser(transaction, input.issuer, input.subject);
  const rulesetVersion = await ensureCurrentCoreRulesetVersion(transaction);

  const [linkedPlayer, fixturePlayerBySlug, worldsWithCode, campaignsWithCode, actorsWithCode] =
    await Promise.all([
      transaction.player.findUnique({ where: { userId: user.id } }),
      transaction.player.findUnique({ where: { slug: AUTHENTICATED_FIXTURE.playerSlug } }),
      transaction.world.findMany({
        where: { code: AUTHENTICATED_FIXTURE.worldCode },
        select: { player: { select: { userId: true, slug: true } } },
        take: 2,
      }),
      transaction.campaign.findMany({
        where: { code: AUTHENTICATED_FIXTURE.campaignCode },
        select: {
          world: { select: { player: { select: { userId: true, slug: true } } } },
        },
        take: 2,
      }),
      transaction.actor.findMany({
        where: { code: AUTHENTICATED_FIXTURE.actorCode },
        select: {
          campaign: {
            select: {
              world: { select: { player: { select: { userId: true, slug: true } } } },
            },
          },
        },
        take: 2,
      }),
    ]);
  exactRecord(
    linkedPlayer === null
      || (linkedPlayer.slug === AUTHENTICATED_FIXTURE.playerSlug
        && linkedPlayer.displayName === AUTHENTICATED_FIXTURE.playerName),
    'user_linked_to_unexpected_player',
  );
  exactRecord(
    fixturePlayerBySlug === null
      || (fixturePlayerBySlug.userId === user.id
        && fixturePlayerBySlug.displayName === AUTHENTICATED_FIXTURE.playerName),
    'fixture_player_conflict',
  );
  exactRecord(
    linkedPlayer === null
      || fixturePlayerBySlug === null
      || linkedPlayer.id === fixturePlayerBySlug.id,
    'fixture_player_ambiguous',
  );
  exactRecord(
    worldsWithCode.length <= 1
      && worldsWithCode.every(({ player }) =>
        player.userId === user.id && player.slug === AUTHENTICATED_FIXTURE.playerSlug),
    'fixture_world_code_conflict',
  );
  exactRecord(
    campaignsWithCode.length <= 1
      && campaignsWithCode.every(({ world }) =>
        world.player.userId === user.id && world.player.slug === AUTHENTICATED_FIXTURE.playerSlug),
    'fixture_campaign_code_conflict',
  );
  exactRecord(
    actorsWithCode.length <= 1
      && actorsWithCode.every(({ campaign }) =>
        campaign.world.player.userId === user.id
        && campaign.world.player.slug === AUTHENTICATED_FIXTURE.playerSlug),
    'fixture_actor_code_conflict',
  );

  let player = linkedPlayer ?? fixturePlayerBySlug;
  if (player === null) {
    player = await transaction.player.create({
      data: {
        userId: user.id,
        slug: AUTHENTICATED_FIXTURE.playerSlug,
        displayName: AUTHENTICATED_FIXTURE.playerName,
      },
    });
    increment(created, 'player');
  } else {
    increment(reused, 'player');
  }

  let world = await transaction.world.findUnique({
    where: {
      playerId_code: {
        playerId: player.id,
        code: AUTHENTICATED_FIXTURE.worldCode,
      },
    },
  });
  if (world === null) {
    world = await transaction.world.create({
      data: {
        playerId: player.id,
        defaultRulesetVersionId: rulesetVersion.id,
        code: AUTHENTICATED_FIXTURE.worldCode,
        name: AUTHENTICATED_FIXTURE.worldName,
      },
    });
    increment(created, 'world');
  } else {
    exactRecord(
      world.name === AUTHENTICATED_FIXTURE.worldName
        && world.defaultRulesetVersionId === rulesetVersion.id
        && world.description === null
        && JSON.stringify(world.metadata) === '{}',
      'fixture_world_conflict',
    );
    increment(reused, 'world');
  }

  let campaign = await transaction.campaign.findUnique({
    where: {
      worldId_code: {
        worldId: world.id,
        code: AUTHENTICATED_FIXTURE.campaignCode,
      },
    },
  });
  if (campaign === null) {
    campaign = await transaction.campaign.create({
      data: {
        worldId: world.id,
        rulesetVersionId: rulesetVersion.id,
        code: AUTHENTICATED_FIXTURE.campaignCode,
        name: AUTHENTICATED_FIXTURE.campaignName,
        status: CampaignStatus.ACTIVE,
      },
    });
    increment(created, 'campaign');
  } else {
    exactRecord(
      campaign.name === AUTHENTICATED_FIXTURE.campaignName
        && campaign.rulesetVersionId === rulesetVersion.id
        && campaign.status === CampaignStatus.ACTIVE
        && campaign.currentTime === null
        && JSON.stringify(campaign.metadata) === '{}',
      'fixture_campaign_conflict',
    );
    increment(reused, 'campaign');
  }

  let actor = await transaction.actor.findUnique({
    where: {
      campaignId_code: {
        campaignId: campaign.id,
        code: AUTHENTICATED_FIXTURE.actorCode,
      },
    },
  });
  if (actor === null) {
    actor = await transaction.actor.create({
      data: {
        campaignId: campaign.id,
        code: AUTHENTICATED_FIXTURE.actorCode,
        name: AUTHENTICATED_FIXTURE.actorName,
        actorType: ActorType.CHARACTER,
        species: AUTHENTICATED_FIXTURE.actorSpecies,
        className: AUTHENTICATED_FIXTURE.actorClassName,
        role: AUTHENTICATED_FIXTURE.actorRole,
        description: AUTHENTICATED_FIXTURE.actorDescription,
        level: 3,
        xp: 75,
        gold: 42,
      },
    });
    increment(created, 'actor');
  } else {
    const legacyActor = actor.name === AUTHENTICATED_FIXTURE.actorName
      && actor.actorType === ActorType.CHARACTER
      && actor.status === ActorStatus.ACTIVE
      && actor.level === 1
      && actor.xp === 0
      && actor.gold === 0
      && actor.species === null
      && actor.className === null
      && actor.role === null
      && actor.description === null
      && JSON.stringify(actor.metadata) === '{}';
    const currentActor = actor.name === AUTHENTICATED_FIXTURE.actorName
      && actor.actorType === ActorType.CHARACTER
      && actor.status === ActorStatus.ACTIVE
      && actor.level === 3
      && actor.xp === 75
      && actor.gold === 42
      && actor.species === AUTHENTICATED_FIXTURE.actorSpecies
      && actor.className === AUTHENTICATED_FIXTURE.actorClassName
      && actor.role === AUTHENTICATED_FIXTURE.actorRole
      && actor.description === AUTHENTICATED_FIXTURE.actorDescription
      && JSON.stringify(actor.metadata) === '{}';
    exactRecord(
      legacyActor || currentActor,
      'fixture_actor_conflict',
    );
    if (legacyActor) {
      actor = await transaction.actor.update({
        where: { id: actor.id },
        data: {
          species: AUTHENTICATED_FIXTURE.actorSpecies,
          className: AUTHENTICATED_FIXTURE.actorClassName,
          role: AUTHENTICATED_FIXTURE.actorRole,
          description: AUTHENTICATED_FIXTURE.actorDescription,
          level: 3,
          xp: 75,
          gold: 42,
        },
      });
    }
    increment(reused, 'actor');
  }

  const membership = await transaction.campaignMembership.findUnique({
    where: { campaignId_userId: { campaignId: campaign.id, userId: user.id } },
  });
  if (membership === null) {
    await transaction.campaignMembership.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        role: CampaignMembershipRole.PLAYER,
      },
    });
    increment(created, 'campaignMembership');
  } else {
    exactRecord(
      membership.role === CampaignMembershipRole.PLAYER
        && membership.status === CampaignMembershipStatus.ACTIVE
        && membership.revokedAt === null
        && membership.grantedByUserId === null,
      'fixture_membership_conflict',
    );
    increment(reused, 'campaignMembership');
  }

  const control = await transaction.actorControl.findUnique({
    where: { actorId_userId: { actorId: actor.id, userId: user.id } },
  });
  if (control === null) {
    await transaction.actorControl.create({
      data: {
        actorId: actor.id,
        userId: user.id,
        permission: ActorControlPermission.CONTROL,
      },
    });
    increment(created, 'actorControl');
  } else {
    exactRecord(
      control.permission === ActorControlPermission.CONTROL && control.revokedAt === null,
      'fixture_control_conflict',
    );
    increment(reused, 'actorControl');
  }

  const [attributeCount, resourceCount, snapshotCount] = await Promise.all([
    transaction.actorAttribute.count({ where: { actorId: actor.id } }),
    transaction.actorResource.count({ where: { actorId: actor.id } }),
    transaction.actorDerivedSnapshot.count({ where: { actorId: actor.id } }),
  ]);
  const mechanicsEmpty = attributeCount === 0 && resourceCount === 0 && snapshotCount === 0;
  const mechanicsComplete = attributeCount === 9 && resourceCount === 3 && snapshotCount === 1;
  exactRecord(mechanicsEmpty || mechanicsComplete, 'fixture_mechanics_partial');
  if (mechanicsEmpty) {
    await createActorMechanicalState(transaction, {
      actorId: actor.id,
      level: actor.level,
      primaryAttributes: getInitialAttributePreset('balanced'),
    });
    incrementBy(created, 'actorAttribute', 9);
    incrementBy(created, 'actorResource', 3);
    increment(created, 'actorDerivedSnapshot');
  } else {
    incrementBy(reused, 'actorAttribute', 9);
    incrementBy(reused, 'actorResource', 3);
    increment(reused, 'actorDerivedSnapshot');
  }

  const existingDefinitions = await transaction.contentDefinition.findMany({
    where: {
      worldId: world.id,
      campaignId: campaign.id,
      code: { in: [...fixtureContentCodes] },
    },
    select: {
      id: true,
      code: true,
      _count: { select: { versions: true } },
    },
  });
  exactRecord(
    existingDefinitions.length === 0
      || (existingDefinitions.length === fixtureContentCodes.length
        && existingDefinitions.every((definition) =>
          fixtureContentCodes.includes(definition.code as typeof fixtureContentCodes[number])
          && definition._count.versions === 1)),
    'fixture_content_partial',
  );
  const registry = await resolveContentPublicationRegistryContext(
    transaction,
    CORE_V1_3_VERSION_CODE,
  );
  const published = new Map<string, PublishedContent>();
  for (const code of fixtureContentCodes) {
    published.set(code, await publishContentVersion(
      transaction,
      publicationInput(world.id, campaign.id, code),
      registry,
    ));
  }
  if (existingDefinitions.length === 0) {
    incrementBy(created, 'contentDefinition', fixtureContentCodes.length);
    incrementBy(created, 'contentVersion', fixtureContentCodes.length);
  } else {
    incrementBy(reused, 'contentDefinition', fixtureContentCodes.length);
    incrementBy(reused, 'contentVersion', fixtureContentCodes.length);
  }

  const [inventoryCount, equipmentSlotCount, actorContentCount, activeEffectCount] =
    await Promise.all([
      transaction.inventoryEntry.count({ where: { actorId: actor.id } }),
      transaction.actorEquipmentSlot.count({ where: { actorId: actor.id } }),
      transaction.actorContent.count({ where: { actorId: actor.id } }),
      transaction.activeEffect.count({ where: { targetActorId: actor.id } }),
    ]);
  const gameplayEmpty = inventoryCount === 0
    && equipmentSlotCount === 0
    && actorContentCount === 0
    && activeEffectCount === 0;
  const gameplayComplete = inventoryCount === 3
    && equipmentSlotCount === 1
    && actorContentCount === 3
    && activeEffectCount === 1;
  exactRecord(gameplayEmpty || gameplayComplete, 'fixture_gameplay_partial');

  if (gameplayEmpty) {
    const armor = latestVersion(requiredPublished(published, 'oauth-test-travel-coat'));
    const tonic = latestVersion(requiredPublished(published, 'oauth-test-healing-tonic'));
    const note = latestVersion(requiredPublished(published, 'oauth-test-field-note'));
    exactRecord(
      armor.inventoryRulesVersionId !== null
        && tonic.inventoryRulesVersionId !== null
        && note.inventoryRulesVersionId !== null,
      'fixture_inventory_rules_missing',
    );
    const armorEntry = await transaction.inventoryEntry.create({
      data: {
        actorId: actor.id,
        entryRef: 'oauth-test-entry-travel-coat',
        contentVersionId: armor.id,
        inventoryRulesVersionId: armor.inventoryRulesVersionId,
        entryKind: InventoryEntryKind.INSTANCE,
        quantity: 1,
        instanceLifecycle: InventoryInstanceLifecycle.AVAILABLE,
      },
    });
    await transaction.inventoryEntry.createMany({
      data: [{
        actorId: actor.id,
        entryRef: 'oauth-test-entry-healing-tonic',
        contentVersionId: tonic.id,
        inventoryRulesVersionId: tonic.inventoryRulesVersionId,
        entryKind: InventoryEntryKind.STACK,
        quantity: 2,
        instanceLifecycle: null,
      }, {
        actorId: actor.id,
        entryRef: 'oauth-test-entry-field-note',
        contentVersionId: note.id,
        inventoryRulesVersionId: note.inventoryRulesVersionId,
        entryKind: InventoryEntryKind.INSTANCE,
        quantity: 1,
        instanceLifecycle: InventoryInstanceLifecycle.AVAILABLE,
      }],
    });
    await transaction.actorEquipmentSlot.create({
      data: {
        actorId: actor.id,
        slotRef: ActorEquipmentSlotRef.BODY,
        inventoryEntryId: armorEntry.id,
      },
    });

    for (const [code, state] of [
      ['oauth-test-quick-step', ActorContentState.KNOWN],
      ['oauth-test-focus-veil', ActorContentState.LEARNING],
      ['oauth-test-steady-focus', ActorContentState.MASTERED],
    ] as const) {
      const content = published.get(code);
      exactRecord(content !== undefined, 'fixture_actor_content_missing');
      const version = latestVersion(content);
      await transaction.actorContent.create({
        data: {
          actorId: actor.id,
          contentDefinitionId: content.id,
          contentVersionId: version.id,
          state,
          rank: state === ActorContentState.MASTERED ? 2 : 1,
          progress: state === ActorContentState.LEARNING ? 35 : 100,
          mastery: state === ActorContentState.MASTERED ? 100 : 0,
        },
      });
    }

    const sourceTalent = requiredPublished(published, 'oauth-test-steady-focus');
    const sourceTalentVersion = latestVersion(sourceTalent);
    await transaction.activeEffect.create({
      data: {
        targetActorId: actor.id,
        sourceActorId: actor.id,
        sourceContentVersionId: sourceTalentVersion.id,
        effectContentVersionId: null,
        effectRulesVersionId: registry.effectRules.id,
        originEncounterId: null,
        effectRef: 'fx_oauthtestfocused',
        effectIndex: 0,
        kind: ActiveEffectKind.SECONDARY_MODIFIER,
        stacks: 1,
        appliedAtTick: campaign.engineTick,
        durationType: ActiveEffectDurationType.SCENE,
        expiresAtTick: null,
        remainingActions: null,
        payload: {
          type: 'secondary_modifier',
          secondaryCode: 'accuracy',
          amount: 1,
        },
      },
    });
    await transaction.actor.update({
      where: { id: actor.id },
      data: {
        inventoryStateVersion: { increment: 1 },
        effectsStateVersion: { increment: 1 },
        mechanicsStateVersion: { increment: 2 },
      },
    });
    await recomputeActorDerivedSnapshot(transaction, actor.id);
    incrementBy(created, 'inventoryEntry', 3);
    increment(created, 'equipmentSlot');
    incrementBy(created, 'actorContent', 3);
    increment(created, 'activeEffect');
  } else {
    incrementBy(reused, 'inventoryEntry', 3);
    increment(reused, 'equipmentSlot');
    incrementBy(reused, 'actorContent', 3);
    increment(reused, 'activeEffect');
  }

  const postflight = await inspectFixtureGraph(transaction, user.id);
  return {
    operationId: input.manifest.operationId,
    environment: input.manifest.environment,
    mode: input.mode,
    created,
    reused,
    conflicts: [],
    postflight,
    isolationVerified: true,
  };
}

export async function runAuthenticatedFixtureProvisioning(
  client: PrismaClient,
  input: FixtureProvisioningInput,
): Promise<FixtureProvisioningResult> {
  if (input.mode === 'postflight') {
    return client.$transaction(async (transaction) => {
      const user = await resolveSyntheticUser(transaction, input.issuer, input.subject);
      const postflight = await inspectFixtureGraph(transaction, user.id);
      return {
        operationId: input.manifest.operationId,
        environment: input.manifest.environment,
        mode: input.mode,
        created: emptyRecordCounts(),
        reused: expectedRecordCounts(),
        conflicts: [],
        postflight,
        isolationVerified: true,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  try {
    return await client.$transaction(async (transaction) => {
      const result = await provisionFixture(transaction, input);
      if (input.mode === 'dry-run') throw new DryRunRollback(result);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
}

function appendSummary(result: FixtureProvisioningResult, durationMs: number): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary === undefined) return;
  const recordTypes: readonly FixtureRecordType[] = [
    'player',
    'world',
    'campaign',
    'actor',
    'campaignMembership',
    'actorControl',
    'actorAttribute',
    'actorResource',
    'actorDerivedSnapshot',
    'contentDefinition',
    'contentVersion',
    'inventoryEntry',
    'equipmentSlot',
    'actorContent',
    'activeEffect',
  ];
  const expected = expectedRecordCounts();
  appendFileSync(summary, [
    `## Protected fixture ${result.mode}`,
    '',
    `- Operation: \`${result.operationId}\``,
    `- Environment: \`${result.environment}\``,
    `- Commit: \`${process.env.GITHUB_SHA ?? 'local'}\``,
    `- Conflicts: ${result.conflicts.length}`,
    `- Isolation postflight: **${String(result.isolationVerified)}**`,
    `- Duration: ${durationMs}ms`,
    '',
    '| Record | Created | Reused | Postflight | Expected |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...recordTypes.map((type) =>
      `| ${type} | ${result.created[type]} | ${result.reused[type]} | ${result.postflight[type]} | ${expected[type]} |`),
    '',
  ].join('\n'));
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mode = parseFixtureProvisionMode(process.argv.slice(2));
  const manifestArgumentIndex = process.argv.indexOf('--manifest');
  exactRecord(
    manifestArgumentIndex >= 0 && manifestArgumentIndex + 1 < process.argv.length,
    'manifest_path_missing',
  );
  const requestedManifestPath = process.argv[manifestArgumentIndex + 1];
  exactRecord(requestedManifestPath !== undefined, 'manifest_path_missing');
  exactRecord(resolve(repositoryRoot, requestedManifestPath) === manifestPath, 'manifest_path_not_allowlisted');
  const manifest = parseAuthenticatedFixtureManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
  );
  const appEnvironment = requiredEnvironment('APP_ENV');
  const projectRef = requiredEnvironment('STAGING_SUPABASE_PROJECT_REF');
  const connectionString = requiredEnvironment('DATABASE_URL');
  const issuer = requiredEnvironment('OAUTH_ISSUER');
  const subject = requiredEnvironment('STAGING_OAUTH_SYNTHETIC_SUBJECT').toLowerCase();
  validateAuthenticatedFixtureProvisioningEnvironment({
    appEnvironment,
    projectRef,
    connectionString,
    issuer,
    subject,
  });

  const { prisma } = await import('../src/shared/database/prisma.js');
  const result = await runAuthenticatedFixtureProvisioning(prisma, {
    mode,
    manifest,
    issuer,
    subject,
  });
  appendSummary(result, Date.now() - startedAt);
  console.info(
    `Authenticated read-only fixture ${mode}: sanitized result recorded; isolated synthetic graph verified`,
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof FixtureProvisioningError
        ? `Authenticated read-only fixture failed safely: ${error.safeCode}`
        : 'Authenticated read-only fixture provisioning failed safely');
      process.exitCode = 1;
    })
    .finally(async () => {
      const { disconnectPrisma } = await import('../src/shared/database/prisma.js');
      await disconnectPrisma();
    });
}
