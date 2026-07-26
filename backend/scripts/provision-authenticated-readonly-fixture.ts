import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  Prisma,
  UserStatus,
  type PrismaClient,
} from '../src/generated/prisma/client.js';
import { CORE_V1_3_VERSION_CODE } from '../src/modules/rules/core-v1/core-v1.progression-v3.js';
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
} as const;

export type FixtureProvisionMode = 'dry-run' | 'apply' | 'postflight';
type FixtureRecordType =
  | 'player'
  | 'world'
  | 'campaign'
  | 'actor'
  | 'campaignMembership'
  | 'actorControl';
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
  };
}

function increment(counts: FixtureRecordCounts, type: FixtureRecordType): void {
  counts[type] += 1;
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
      && actor.level === 1
      && actor.species === null
      && actor.className === null
      && actor.role === null
      && actor.description === null
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
    transaction.contentDefinition.count({ where: { worldId: world.id } }),
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
      && inventoryEntries === 0
      && actorContent === 0
      && gameEvents === 0
      && nonPlayerActors === 0
      && worldContent === 0,
    'fixture_isolation_postflight_failed',
  );
  return expectedRecordCounts();
}

async function provisionFixture(
  transaction: Prisma.TransactionClient,
  input: FixtureProvisioningInput,
): Promise<FixtureProvisioningResult> {
  const created = emptyRecordCounts();
  const reused = emptyRecordCounts();
  const user = await resolveSyntheticUser(transaction, input.issuer, input.subject);
  const rulesetVersion = await transaction.rulesetVersion.findUnique({
    where: { code: CORE_V1_3_VERSION_CODE },
    select: { id: true },
  });
  exactRecord(rulesetVersion !== null, 'reviewed_ruleset_missing');

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
        level: 1,
      },
    });
    increment(created, 'actor');
  } else {
    exactRecord(
      actor.name === AUTHENTICATED_FIXTURE.actorName
        && actor.actorType === ActorType.CHARACTER
        && actor.status === ActorStatus.ACTIVE
        && actor.level === 1
        && actor.species === null
        && actor.className === null
        && actor.role === null
        && actor.description === null
        && JSON.stringify(actor.metadata) === '{}',
      'fixture_actor_conflict',
    );
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
  ];
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
      `| ${type} | ${result.created[type]} | ${result.reused[type]} | ${result.postflight[type]} | 1 |`),
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
