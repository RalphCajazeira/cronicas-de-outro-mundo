import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserStatus } from '../src/generated/prisma/client.js';
import { parseProvisionMode } from './upsert-oauth-client-policy.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Required setting is missing: ${name}`);
  return value;
}

export function validateSyntheticIdentityInput(issuer: string, subject: string, email: string): void {
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error('Synthetic identity issuer is invalid');
  }
  if (issuer.length > 512
    || issuerUrl.protocol !== 'https:'
    || issuerUrl.username.length > 0
    || issuerUrl.password.length > 0
    || issuerUrl.search.length > 0
    || issuerUrl.hash.length > 0
    || issuerUrl.pathname !== '/auth/v1'
    || !issuerUrl.hostname.endsWith('.supabase.co')) {
    throw new Error('Synthetic identity issuer is invalid');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(subject)) {
    throw new Error('Synthetic identity subject is invalid');
  }
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.example\.test$/iu.test(email)) {
    throw new Error('Synthetic identity email must use the reserved example.test domain');
  }
}

async function main(): Promise<void> {
  const { prisma } = await import('../src/shared/database/prisma.js');
  const mode = parseProvisionMode(process.argv.slice(2));
  const issuer = requiredEnvironment('OAUTH_ISSUER');
  const subject = requiredEnvironment('STAGING_SYNTHETIC_AUTH_SUBJECT').toLowerCase();
  const email = requiredEnvironment('STAGING_SYNTHETIC_EMAIL').toLowerCase();
  validateSyntheticIdentityInput(issuer, subject, email);

  await prisma.$transaction(async (transaction) => {
    const identities = await transaction.externalIdentity.findMany({
      select: {
        issuer: true,
        subject: true,
        email: true,
        user: { select: { id: true, status: true, suspendedAt: true, deletedAt: true } },
      },
      take: 2,
    });
    const matching = identities.find((identity) => identity.issuer === issuer && identity.subject === subject);
    if (identities.some((identity) => identity.issuer !== issuer || identity.subject !== subject)) {
      throw new Error('An unexpected external identity already exists');
    }
    if (matching !== undefined) {
      if (matching.email !== email
        || matching.user.status !== UserStatus.ACTIVE
        || matching.user.suspendedAt !== null
        || matching.user.deletedAt !== null) {
        throw new Error('Existing synthetic identity is inconsistent');
      }
      console.info(`Synthetic identity ${mode}: no change required`);
      return;
    }
    if (await transaction.user.count() !== 0) {
      throw new Error('An unbound internal user already exists');
    }
    if (mode === 'dry-run') {
      console.info('Synthetic identity dry-run: one User and one ExternalIdentity required');
      return;
    }
    await transaction.user.create({
      data: {
        externalIdentities: {
          create: { issuer, subject, email, emailVerified: true },
        },
      },
    });
    const [users, externalIdentities, players, memberships, controls] = await Promise.all([
      transaction.user.count(),
      transaction.externalIdentity.count(),
      transaction.player.count({ where: { userId: { not: null } } }),
      transaction.campaignMembership.count(),
      transaction.actorControl.count(),
    ]);
    if (users !== 1 || externalIdentities !== 1 || players !== 0 || memberships !== 0 || controls !== 0) {
      throw new Error('Synthetic identity postcondition failed');
    }
    console.info('Synthetic identity apply: one isolated identity active');
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .catch(() => {
      console.error('Synthetic identity provisioning failed safely');
      process.exitCode = 1;
    })
    .finally(async () => {
      const { disconnectPrisma } = await import('../src/shared/database/prisma.js');
      await disconnectPrisma();
    });
}
