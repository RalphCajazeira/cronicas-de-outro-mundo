import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProvisionMode = 'dry-run' | 'apply';

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`Required setting is missing: ${name}`);
  return value;
}

export function parseProvisionMode(arguments_: readonly string[]): ProvisionMode {
  const modes = arguments_.filter((argument) => argument === '--dry-run' || argument === '--apply');
  if (modes.length !== 1) throw new Error('Choose exactly one of --dry-run or --apply');
  return modes[0] === '--apply' ? 'apply' : 'dry-run';
}

export function validateOAuthClientPolicyInput(clientId: string, audience: string): void {
  const hasControlCharacter = [...clientId].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (clientId.length === 0
    || clientId.length > 512
    || clientId.trim() !== clientId
    || hasControlCharacter) {
    throw new Error('OAuth client ID is invalid');
  }
  let resource: URL;
  try {
    resource = new URL(audience);
  } catch {
    throw new Error('OAuth resource URI is invalid');
  }
  if (audience.length > 2_048
    || resource.protocol !== 'https:'
    || resource.username.length > 0
    || resource.password.length > 0
    || resource.search.length > 0
    || resource.hash.length > 0
    || resource.pathname !== '/mcp-auth') {
    throw new Error('OAuth resource URI is invalid');
  }
}

async function main(): Promise<void> {
  const { prisma } = await import('../src/shared/database/prisma.js');
  const mode = parseProvisionMode(process.argv.slice(2));
  const clientId = requiredEnvironment('STAGING_OAUTH_CLIENT_ID');
  const audience = requiredEnvironment('OAUTH_RESOURCE_URI');
  validateOAuthClientPolicyInput(clientId, audience);

  await prisma.$transaction(async (transaction) => {
    const policies = await transaction.oAuthClientResourcePolicy.findMany({
      select: { clientId: true, audience: true, enabled: true },
      take: 2,
    });
    const matching = policies.find((policy) => policy.clientId === clientId);
    if (policies.some((policy) => policy.clientId !== clientId)) {
      throw new Error('An unexpected OAuth client resource policy already exists');
    }
    const unchanged = matching?.audience === audience && matching.enabled;
    if (mode === 'dry-run') {
      console.info(unchanged ? 'OAuth client policy dry-run: no change required' : 'OAuth client policy dry-run: one upsert required');
      return;
    }
    await transaction.oAuthClientResourcePolicy.upsert({
      where: { clientId },
      create: { clientId, audience, enabled: true },
      update: { audience, enabled: true },
    });
    console.info(unchanged ? 'OAuth client policy apply: no effective change' : 'OAuth client policy apply: one policy active');
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .catch(() => {
      console.error('OAuth client policy provisioning failed safely');
      process.exitCode = 1;
    })
    .finally(async () => {
      const { disconnectPrisma } = await import('../src/shared/database/prisma.js');
      await disconnectPrisma();
    });
}
