import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_FIXTURE,
  AUTHENTICATED_FIXTURE_ISSUER,
  runAuthenticatedFixtureProvisioning,
} from '../../scripts/provision-authenticated-readonly-fixture.js';
import type { AuthenticatedFixtureManifest } from '../../scripts/staging-provisioning-manifest.js';
import { UserStatus } from '../../src/generated/prisma/client.js';
import { prisma } from '../../src/shared/database/prisma.js';

const subject = '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba';
const manifest: AuthenticatedFixtureManifest = {
  operationId: 'authenticated-readonly-fixture-v1',
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
    expect(result.created).toEqual({
      player: 1,
      world: 1,
      campaign: 1,
      actor: 1,
      campaignMembership: 1,
      actorControl: 1,
    });
    expect(await prisma.player.count({
      where: { slug: AUTHENTICATED_FIXTURE.playerSlug },
    })).toBe(0);
    expect(await prisma.campaignMembership.count()).toBe(0);
    expect(await prisma.actorControl.count()).toBe(0);
  });

  it('creates the isolated graph once and reuses it idempotently', async () => {
    await createSyntheticIdentity();
    const applied = await runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'apply',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    });
    expect(applied.created).toEqual({
      player: 1,
      world: 1,
      campaign: 1,
      actor: 1,
      campaignMembership: 1,
      actorControl: 1,
    });

    const repeated = await runAuthenticatedFixtureProvisioning(prisma, {
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
    });
    expect(repeated.reused).toEqual({
      player: 1,
      world: 1,
      campaign: 1,
      actor: 1,
      campaignMembership: 1,
      actorControl: 1,
    });

    const postflight = await runAuthenticatedFixtureProvisioning(prisma, {
      mode: 'postflight',
      manifest,
      issuer: AUTHENTICATED_FIXTURE_ISSUER,
      subject,
    });
    expect(postflight.postflight).toEqual(manifest.expectedRecords);
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
      mode: 'apply',
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
});
