import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  UserStatus,
} from '../src/generated/prisma/client.js';
import { CORE_V1_3_VERSION_CODE } from '../src/modules/rules/core-v1/core-v1.progression-v3.js';
import { validateStagingTarget } from './staging-database.js';
import { parseProvisionMode } from './upsert-oauth-client-policy.js';

export const AUTHENTICATED_FIXTURE_PROJECT_REF = 'udqwzvhlwwfnngiipacj';
const expectedDatabase = 'postgres';
const expectedRole = 'cronicas_staging_app';
const expectedSchema = 'public';

const fixture = {
  playerSlug: 'oauth-staging-tester',
  playerName: 'OAuth Staging Tester',
  worldCode: 'oauth-test-world',
  worldName: 'OAuth Test World',
  campaignCode: 'oauth-readonly-test',
  campaignName: 'OAuth Readonly Test',
  actorCode: 'test-adventurer',
  actorName: 'Test Adventurer',
} as const;

class FixtureProvisioningError extends Error {}

class DryRunRollback extends Error {
  constructor(readonly result: ProvisioningResult) {
    super('Dry-run rollback');
  }
}

interface ProvisioningResult {
  readonly created: number;
  readonly reused: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new FixtureProvisioningError(`Required staging setting is missing: ${name}`);
  }
  return value;
}

export function validateAuthenticatedFixtureProvisioningEnvironment(input: {
  readonly appEnvironment: string;
  readonly projectRef: string;
  readonly connectionString: string;
}): void {
  if (input.appEnvironment !== 'staging') {
    throw new FixtureProvisioningError('Authenticated fixture provisioning is restricted to APP_ENV=staging');
  }
  if (input.projectRef !== AUTHENTICATED_FIXTURE_PROJECT_REF) {
    throw new FixtureProvisioningError('Authenticated fixture project ref does not match the allowlist');
  }
  validateStagingTarget(input.connectionString, {
    projectRef: AUTHENTICATED_FIXTURE_PROJECT_REF,
    database: expectedDatabase,
    role: expectedRole,
    schema: expectedSchema,
  });
}

function exactRecord(condition: boolean, message: string): void {
  if (!condition) throw new FixtureProvisioningError(message);
}

async function provisionFixture(
  transaction: import('../src/generated/prisma/client.js').Prisma.TransactionClient,
  issuer: string,
  subject: string,
): Promise<ProvisioningResult> {
  let created = 0;
  let reused = 0;
  const identities = await transaction.externalIdentity.findMany({
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
  });
  exactRecord(identities.length === 1, 'Synthetic ExternalIdentity was not resolved exactly once');
  const user = identities[0]?.user;
  exactRecord(user !== undefined
    && user.status === UserStatus.ACTIVE
    && user.suspendedAt === null
    && user.deletedAt === null, 'Synthetic User is unavailable');
  if (user === undefined) throw new FixtureProvisioningError('Synthetic User is unavailable');

  const [linkedPlayer, fixturePlayerBySlug] = await Promise.all([
    transaction.player.findUnique({ where: { userId: user.id } }),
    transaction.player.findUnique({ where: { slug: fixture.playerSlug } }),
  ]);
  exactRecord(
    linkedPlayer === null
      || (linkedPlayer.slug === fixture.playerSlug && linkedPlayer.displayName === fixture.playerName),
    'Synthetic User is linked to an unexpected Player',
  );
  exactRecord(
    fixturePlayerBySlug === null
      || (fixturePlayerBySlug.userId === user.id && fixturePlayerBySlug.displayName === fixture.playerName),
    'Synthetic fixture Player identity is inconsistent',
  );
  let player = linkedPlayer ?? fixturePlayerBySlug;
  if (player === null) {
    player = await transaction.player.create({
      data: {
        userId: user.id,
        slug: fixture.playerSlug,
        displayName: fixture.playerName,
      },
    });
    created += 1;
  } else {
    reused += 1;
  }

  const rulesetVersion = await transaction.rulesetVersion.findUnique({
    where: { code: CORE_V1_3_VERSION_CODE },
    select: { id: true },
  });
  exactRecord(rulesetVersion !== null, 'The reviewed core ruleset version is unavailable');
  if (rulesetVersion === null) throw new FixtureProvisioningError('The reviewed core ruleset version is unavailable');

  let world = await transaction.world.findUnique({
    where: {
      playerId_code: {
        playerId: player.id,
        code: fixture.worldCode,
      },
    },
  });
  if (world === null) {
    world = await transaction.world.create({
      data: {
        playerId: player.id,
        defaultRulesetVersionId: rulesetVersion.id,
        code: fixture.worldCode,
        name: fixture.worldName,
      },
    });
    created += 1;
  } else {
    exactRecord(
      world.name === fixture.worldName
        && world.defaultRulesetVersionId === rulesetVersion.id
        && world.description === null
        && JSON.stringify(world.metadata) === '{}',
      'Synthetic fixture World is inconsistent',
    );
    reused += 1;
  }

  let campaign = await transaction.campaign.findUnique({
    where: {
      worldId_code: {
        worldId: world.id,
        code: fixture.campaignCode,
      },
    },
  });
  if (campaign === null) {
    campaign = await transaction.campaign.create({
      data: {
        worldId: world.id,
        rulesetVersionId: rulesetVersion.id,
        code: fixture.campaignCode,
        name: fixture.campaignName,
        status: CampaignStatus.ACTIVE,
      },
    });
    created += 1;
  } else {
    exactRecord(
      campaign.name === fixture.campaignName
        && campaign.rulesetVersionId === rulesetVersion.id
        && campaign.status === CampaignStatus.ACTIVE
        && campaign.currentTime === null
        && JSON.stringify(campaign.metadata) === '{}',
      'Synthetic fixture Campaign is inconsistent',
    );
    reused += 1;
  }

  let actor = await transaction.actor.findUnique({
    where: {
      campaignId_code: {
        campaignId: campaign.id,
        code: fixture.actorCode,
      },
    },
  });
  if (actor === null) {
    actor = await transaction.actor.create({
      data: {
        campaignId: campaign.id,
        code: fixture.actorCode,
        name: fixture.actorName,
        actorType: ActorType.CHARACTER,
        level: 1,
      },
    });
    created += 1;
  } else {
    exactRecord(
      actor.name === fixture.actorName
        && actor.actorType === ActorType.CHARACTER
        && actor.status === ActorStatus.ACTIVE
        && actor.level === 1
        && actor.species === null
        && actor.className === null
        && actor.role === null
        && actor.description === null
        && JSON.stringify(actor.metadata) === '{}',
      'Synthetic fixture Actor is inconsistent',
    );
    reused += 1;
  }

  const membership = await transaction.campaignMembership.findUnique({
    where: {
      campaignId_userId: {
        campaignId: campaign.id,
        userId: user.id,
      },
    },
  });
  if (membership === null) {
    await transaction.campaignMembership.create({
      data: {
        campaignId: campaign.id,
        userId: user.id,
        role: CampaignMembershipRole.PLAYER,
      },
    });
    created += 1;
  } else {
    exactRecord(
      membership.role === CampaignMembershipRole.PLAYER
        && membership.status === CampaignMembershipStatus.ACTIVE
        && membership.revokedAt === null
        && membership.grantedByUserId === null,
      'Synthetic fixture CampaignMembership is inconsistent',
    );
    reused += 1;
  }

  const control = await transaction.actorControl.findUnique({
    where: {
      actorId_userId: {
        actorId: actor.id,
        userId: user.id,
      },
    },
  });
  if (control === null) {
    await transaction.actorControl.create({
      data: {
        actorId: actor.id,
        userId: user.id,
        permission: ActorControlPermission.CONTROL,
      },
    });
    created += 1;
  } else {
    exactRecord(
      control.permission === ActorControlPermission.CONTROL
        && control.revokedAt === null,
      'Synthetic fixture ActorControl is inconsistent',
    );
    reused += 1;
  }

  const [
    linkedPlayers,
    playerWorlds,
    worldCampaigns,
    campaignActors,
    campaignMemberships,
    actorControls,
    encounters,
    inventoryEntries,
    actorContent,
    gameEvents,
  ] = await Promise.all([
    transaction.player.count({ where: { userId: user.id } }),
    transaction.world.count({ where: { playerId: player.id } }),
    transaction.campaign.count({ where: { worldId: world.id } }),
    transaction.actor.count({ where: { campaignId: campaign.id } }),
    transaction.campaignMembership.count({ where: { campaignId: campaign.id } }),
    transaction.actorControl.count({ where: { actorId: actor.id } }),
    transaction.encounter.count({ where: { campaignId: campaign.id } }),
    transaction.inventoryEntry.count({ where: { actorId: actor.id } }),
    transaction.actorContent.count({ where: { actorId: actor.id } }),
    transaction.gameEvent.count({ where: { campaignId: campaign.id } }),
  ]);
  exactRecord(
    linkedPlayers === 1
      && playerWorlds === 1
      && worldCampaigns === 1
      && campaignActors === 1
      && campaignMemberships === 1
      && actorControls === 1
      && encounters === 0
      && inventoryEntries === 0
      && actorContent === 0
      && gameEvents === 0,
    'Synthetic fixture isolation postcondition failed',
  );

  return { created, reused };
}

async function main(): Promise<void> {
  const mode = parseProvisionMode(process.argv.slice(2));
  const appEnvironment = requiredEnvironment('APP_ENV');
  const projectRef = requiredEnvironment('STAGING_SUPABASE_PROJECT_REF');
  const connectionString = requiredEnvironment('DATABASE_URL');
  const issuer = requiredEnvironment('OAUTH_ISSUER');
  const subject = requiredEnvironment('STAGING_SYNTHETIC_AUTH_SUBJECT').toLowerCase();
  validateAuthenticatedFixtureProvisioningEnvironment({
    appEnvironment,
    projectRef,
    connectionString,
  });

  const { prisma } = await import('../src/shared/database/prisma.js');
  let result: ProvisioningResult;
  try {
    result = await prisma.$transaction(async (transaction) => {
      const provisioned = await provisionFixture(transaction, issuer, subject);
      if (mode === 'dry-run') throw new DryRunRollback(provisioned);
      return provisioned;
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    result = error.result;
  }
  console.info(
    `Authenticated read-only fixture ${mode}: ${result.created} create, ${result.reused} reuse; isolated synthetic graph verified`,
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof FixtureProvisioningError
        ? error.message
        : 'Authenticated read-only fixture provisioning failed safely');
      process.exitCode = 1;
    })
    .finally(async () => {
      const { disconnectPrisma } = await import('../src/shared/database/prisma.js');
      await disconnectPrisma();
    });
}
