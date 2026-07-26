import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_FIXTURE,
  AUTHENTICATED_FIXTURE_ISSUER,
  runAuthenticatedFixtureProvisioning,
} from '../../scripts/provision-authenticated-readonly-fixture.js';
import type { AuthenticatedFixtureManifest } from '../../scripts/staging-provisioning-manifest.js';
import {
  ActorControlPermission,
  ActorType,
  CampaignMembershipRole,
  CampaignStatus,
  UserStatus,
  type Prisma,
  type PrismaClient,
} from '../../src/generated/prisma/client.js';
import { prisma } from '../../src/shared/database/prisma.js';
import { createPrismaAuthenticatedGameContextRepository } from '../../src/modules/authenticated-game-context/authenticated-game-context.repository.js';
import { createPrismaAuthenticatedCharacterViewRepository } from '../../src/modules/authenticated-character-view/authenticated-character-view.repository.js';
import { createAuthenticatedCharacterViewService } from '../../src/modules/authenticated-character-view/authenticated-character-view.service.js';
import { ensureCurrentCoreRulesetVersion } from '../../src/modules/rules/ruleset.registry.js';

const subject = '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba';
const manifest: AuthenticatedFixtureManifest = {
  operationId: 'authenticated-readonly-fixture-v1',
  executionRevision: 2,
  environment: 'staging',
  type: 'AUTHENTICATED_READONLY_FIXTURE',
  enabled: true,
  expectedRecords: {
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
  },
};

async function cleanFixtureTestData(): Promise<void> {
  await prisma.player.deleteMany({
    where: {
      slug: {
        in: [
          AUTHENTICATED_FIXTURE.playerSlug,
          'fixture-unexpected-linked-player',
          'fixture-real-protection-player',
        ],
      },
    },
  });
  await prisma.user.deleteMany({
    where: {
      externalIdentities: {
        some: { issuer: AUTHENTICATED_FIXTURE_ISSUER, subject },
      },
    },
  });
}

async function createSyntheticIdentity(
  status: UserStatus = UserStatus.ACTIVE,
): Promise<{ id: string }> {
  return prisma.user.create({
    data: {
      status,
      ...(status === UserStatus.SUSPENDED ? { suspendedAt: new Date() } : {}),
      ...(status === UserStatus.DELETED ? { deletedAt: new Date() } : {}),
      externalIdentities: {
        create: {
          issuer: AUTHENTICATED_FIXTURE_ISSUER,
          subject,
          email: 'fixture-provisioning@cronicas.example.test',
          emailVerified: true,
        },
      },
    },
    select: { id: true },
  });
}

async function createLegacyFixtureGraph(
  transaction: Prisma.TransactionClient,
): Promise<{ actorId: string }> {
  const user = await transaction.user.create({
    data: {
      status: UserStatus.ACTIVE,
      externalIdentities: {
        create: {
          issuer: AUTHENTICATED_FIXTURE_ISSUER,
          subject,
          email: 'fixture-provisioning@cronicas.example.test',
          emailVerified: true,
        },
      },
    },
  });
  const rulesetVersion = await ensureCurrentCoreRulesetVersion(transaction);
  const player = await transaction.player.create({
    data: {
      userId: user.id,
      slug: AUTHENTICATED_FIXTURE.playerSlug,
      displayName: AUTHENTICATED_FIXTURE.playerName,
    },
  });
  const world = await transaction.world.create({
    data: {
      playerId: player.id,
      defaultRulesetVersionId: rulesetVersion.id,
      code: AUTHENTICATED_FIXTURE.worldCode,
      name: AUTHENTICATED_FIXTURE.worldName,
    },
  });
  const campaign = await transaction.campaign.create({
    data: {
      worldId: world.id,
      rulesetVersionId: rulesetVersion.id,
      code: AUTHENTICATED_FIXTURE.campaignCode,
      name: AUTHENTICATED_FIXTURE.campaignName,
      status: CampaignStatus.ACTIVE,
    },
  });
  const actor = await transaction.actor.create({
    data: {
      campaignId: campaign.id,
      code: AUTHENTICATED_FIXTURE.actorCode,
      name: AUTHENTICATED_FIXTURE.actorName,
      actorType: ActorType.CHARACTER,
    },
  });
  await transaction.campaignMembership.create({
    data: {
      campaignId: campaign.id,
      userId: user.id,
      role: CampaignMembershipRole.PLAYER,
    },
  });
  await transaction.actorControl.create({
    data: {
      actorId: actor.id,
      userId: user.id,
      permission: ActorControlPermission.CONTROL,
    },
  });
  return { actorId: actor.id };
}

describe('authenticated staging fixture provisioning', () => {
  beforeEach(cleanFixtureTestData);
  afterEach(cleanFixtureTestData);

  it('rolls a complete dry-run back without leaving fixture records', async () => {
    await createSyntheticIdentity();
    const result = await runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'dry-run',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    });
    expect(result.created).toEqual(manifest.expectedRecords);
    expect(await prisma.player.count({
      where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
    })).toBe(0);
    expect(await prisma.campaignMembership.count()).toBe(0);
    expect(await prisma.actorControl.count()).toBe(0);
  });

  it('completes only the missing records in a valid partial fixture', async () => {
    const user = await createSyntheticIdentity();
    await prisma.player.create({
      data: {
        userId: user.id,
        slug: AUTHENTICATED_FIXTURE.playerSlug,
        displayName: AUTHENTICATED_FIXTURE.playerName,
      },
    });
    const result = await runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'dry-run',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    });
    expect(result.created.player).toBe(0);
    expect(result.reused.player).toBe(1);
    expect(result.created.world).toBe(1);
    expect(result.created.campaign).toBe(1);
    expect(result.created.actor).toBe(1);
  });

  it('upgrades the complete legacy six-record graph atomically without leaving test data', async () => {
    await expect(prisma.$transaction(async (transaction) => {
      const { actorId } = await createLegacyFixtureGraph(transaction);
      const transactionalClient = {
        $transaction: async <T>(
          operation: (client: Prisma.TransactionClient) => Promise<T>,
        ): Promise<T> => operation(transaction),
      } as unknown as PrismaClient;
      const result = await runAuthenticatedFixtureProvisioning(transactionalClient, {
        mode: 'apply',
        manifest,
        issuer: AUTHENTICATED_FIXTURE_ISSUER,
        subject,
      });

      expect(result.reused).toMatchObject({
        player: 1,
        world: 1,
        campaign: 1,
        actor: 1,
        campaignMembership: 1,
        actorControl: 1,
      });
      expect(result.created).toMatchObject({
        actorAttribute: 9,
        actorResource: 3,
        actorDerivedSnapshot: 1,
        contentDefinition: 7,
        contentVersion: 7,
        inventoryEntry: 3,
        equipmentSlot: 1,
        actorContent: 3,
        activeEffect: 1,
      });
      expect(await transaction.actor.findUnique({
        where: { id: actorId },
        select: { level: true, xp: true, gold: true },
      })).toEqual({ level: 3, xp: 75, gold: 42 });
      throw new Error('intentional legacy fixture upgrade rollback');
    })).rejects.toThrow('intentional legacy fixture upgrade rollback');
    expect(await prisma.player.count({
      where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
    })).toBe(0);
  });

  it('rejects an existing Player linked to the synthetic User', async () => {
    const user = await createSyntheticIdentity();
    await prisma.player.create({
      data: {
        userId: user.id,
        slug: 'fixture-unexpected-linked-player',
        displayName: 'Unrelated Test Player',
      },
    });
    await expect(runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'apply',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    })).rejects.toThrow('user_linked_to_unexpected_player');
    expect(await prisma.player.count({
      where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
    })).toBe(0);
  });

  it('rejects a fixture code conflict and preserves unrelated Player data', async () => {
    await createSyntheticIdentity();
    const realPlayer = await prisma.player.create({
      data: {
        slug: AUTHENTICATED_FIXTURE.playerSlug,
        displayName: 'Existing Unrelated Test Player',
      },
    });
    const protectedPlayer = await prisma.player.create({
      data: {
        slug: 'fixture-real-protection-player',
        displayName: 'Protected Local Test Player',
      },
    });
    await expect(runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'apply',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    })).rejects.toThrow('fixture_player_conflict');
    expect(await prisma.player.findUnique({ where: { id: realPlayer.id } })).toMatchObject({
      userId: null,
      displayName: 'Existing Unrelated Test Player',
    });
    expect(await prisma.player.findUnique({ where: { id: protectedPlayer.id } })).toMatchObject({
      userId: null,
      displayName: 'Protected Local Test Player',
    });
    expect(await prisma.world.count({ where: { playerId: realPlayer.id } })).toBe(0);
  });

  it.each([UserStatus.SUSPENDED, UserStatus.DELETED])(
    'rejects an inactive synthetic User with status %s',
    async (status) => {
      await createSyntheticIdentity(status);
      await expect(runAuthenticatedFixtureProvisioning(prisma, {
        mode: 'apply',
        manifest,
        issuer: AUTHENTICATED_FIXTURE_ISSUER,
        subject,
      })).rejects.toThrow('synthetic_user_inactive');
      expect(await prisma.player.count({
        where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
      })).toBe(0);
    },
  );

  it('creates the isolated graph once and reuses it idempotently', async () => {
    const syntheticUser = await createSyntheticIdentity();
    await expect(prisma.$transaction(async (transaction) => {
      const transactionalClient = {
        $transaction: async <T>(
          operation: (client: Prisma.TransactionClient) => Promise<T>,
        ): Promise<T> => operation(transaction),
      } as unknown as PrismaClient;
      const applied = await runAuthenticatedFixtureProvisioning(transactionalClient, {
        mode: 'apply',
        manifest,
        issuer: AUTHENTICATED_FIXTURE_ISSUER,
        subject,
      });
      expect(applied.created).toEqual(manifest.expectedRecords);

      const projectionService = createAuthenticatedCharacterViewService(
        createPrismaAuthenticatedGameContextRepository(transaction),
        createPrismaAuthenticatedCharacterViewRepository(transactionalClient as typeof prisma),
      );
      const projections = [
        await projectionService.load(syntheticUser.id, { view: 'SUMMARY' }),
        await projectionService.load(syntheticUser.id, { view: 'SHEET' }),
        await projectionService.load(syntheticUser.id, { view: 'INVENTORY' }),
        await projectionService.load(syntheticUser.id, { view: 'EQUIPMENT' }),
        await projectionService.load(syntheticUser.id, { view: 'ABILITIES' }),
      ];
      expect(projections.map((projection) => projection.view)).toEqual([
        'SUMMARY',
        'SHEET',
        'INVENTORY',
        'EQUIPMENT',
        'ABILITIES',
      ]);
      expect(JSON.stringify(projections)).not.toMatch(
        /userId|actorId|campaignId|contentVersionId|metadata|MASTER_ONLY/i,
      );
      const inventoryProjection = projections[2];
      if (inventoryProjection?.view !== 'INVENTORY') throw new Error('Inventory projection missing');
      expect(inventoryProjection.data.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        equipped: item.equipped,
      }))).toContainEqual({ name: 'Casaco de Viagem', quantity: 1, equipped: true });
      expect(inventoryProjection.data.items.map((item) => item.name)).toContain('Tônico de Treino');
      expect(inventoryProjection.data.items.map((item) => item.name)).toContain('Anotações de Campo');

      const abilitiesProjection = projections[4];
      if (abilitiesProjection?.view !== 'ABILITIES') throw new Error('Abilities projection missing');
      expect(abilitiesProjection.data.abilities.map((ability) => ({
        name: ability.name,
        category: ability.category,
      }))).toContainEqual({ name: 'Concentração Estável', category: 'PASSIVE' });
      expect(abilitiesProjection.data.abilities.map((ability) => ability.name)).toContain('Passo Rápido');
      expect(abilitiesProjection.data.abilities.map((ability) => ability.name)).toContain('Faísca Arcana');

      const repeated = await runAuthenticatedFixtureProvisioning(transactionalClient, {
        mode: 'apply',
        manifest,
        issuer: AUTHENTICATED_FIXTURE_ISSUER,
        subject,
      });
      expect(repeated.created).toEqual({
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
      });
      expect(repeated.reused).toEqual(manifest.expectedRecords);

      const postflight = await runAuthenticatedFixtureProvisioning(transactionalClient, {
        mode: 'postflight',
        manifest,
        issuer: AUTHENTICATED_FIXTURE_ISSUER,
        subject,
      });
      expect(postflight.postflight).toEqual(manifest.expectedRecords);
      throw new Error('intentional fixture apply rollback');
    })).rejects.toThrow('intentional fixture apply rollback');
    expect(await prisma.player.count({
      where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
    })).toBe(0);
    expect(await prisma.contentDefinition.count({
      where: { code: { startsWith: 'oauth-test-' } },
    })).toBe(0);
  });
});
