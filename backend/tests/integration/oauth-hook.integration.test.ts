import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';

const prefix = 'integration-oauth-client-';
const exactAudience = 'https://cronicas-de-outro-mundo-staging-api.onrender.com/mcp-auth';
const requiredClaims = {
  iss: 'https://project-ref.supabase.co/auth/v1',
  aud: 'authenticated',
  exp: 1_900_000_000,
  iat: 1_899_996_400,
  sub: '7f43ce60-3dca-4ab0-8fe1-33a2ca9e43ba',
  role: 'authenticated',
  aal: 'aal1',
  session_id: '70b24547-27f0-4e94-a540-32d2d735bc7f',
  email: 'oauth-staging@cronicas.example.test',
  phone: '',
  is_anonymous: false,
};

async function runHook(
  clientId?: string,
  authenticationMethod = 'oauth',
): Promise<Record<string, unknown>> {
  const claims = clientId === undefined ? requiredClaims : { ...requiredClaims, client_id: clientId };
  const event = JSON.stringify({
    user_id: requiredClaims.sub,
    claims,
    authentication_method: authenticationMethod,
  });
  const rows = await prisma.$queryRaw<Array<{ result: Record<string, unknown> }>>`
    SELECT public.custom_access_token_hook(${event}::jsonb) AS result
  `;
  const result = rows[0]?.result;
  if (result === undefined) throw new Error('Custom access token hook returned no result');
  return result;
}

afterAll(async () => {
  await prisma.oAuthClientResourcePolicy.deleteMany({ where: { clientId: { startsWith: prefix } } });
  await disconnectPrisma();
});

describe('Supabase Custom Access Token Hook', () => {
  it('preserves every common token claim and its normal audience when client_id is absent', async () => {
    await expect(runHook()).resolves.toEqual({ claims: requiredClaims });
  });

  it('sets the exact configured audience for a known client and refresh', async () => {
    const clientId = `${prefix}${randomUUID()}`;
    await prisma.oAuthClientResourcePolicy.create({
      data: { clientId, audience: exactAudience, enabled: true },
    });
    const initial = await runHook(clientId);
    const refresh = await runHook(clientId, 'token_refresh');
    for (const result of [initial, refresh]) {
      expect(result).toEqual({
        claims: { ...requiredClaims, client_id: clientId, aud: exactAudience },
      });
    }
  });

  it.each([
    `${prefix}unknown`,
    `${prefix}${'x'.repeat(493)}`,
    `${prefix}UNKNOWN`,
  ])('fails closed for an unknown, differently cased, or excessive client: %s', async (clientId) => {
    const result = await runHook(clientId);
    expect(result).toMatchObject({ error: { http_code: 403 } });
    expect(result).not.toHaveProperty('claims');
  });

  it('fails closed for disabled, similar, and whitespace-variant clients', async () => {
    const clientId = `${prefix}${randomUUID()}`;
    await prisma.oAuthClientResourcePolicy.createMany({
      data: [
        { clientId, audience: exactAudience, enabled: false },
        { clientId: `${clientId}-similar`, audience: `${exactAudience}?similar=1`, enabled: true },
      ],
    });
    await expect(runHook(clientId)).resolves.toMatchObject({ error: { http_code: 403 } });
    await expect(runHook(`${clientId} `)).resolves.toMatchObject({ error: { http_code: 403 } });
  });

  it('selects one exact policy among multiple clients without audience similarity', async () => {
    const first = `${prefix}${randomUUID()}`;
    const second = `${prefix}${randomUUID()}`;
    const secondAudience = 'https://second.example.test/mcp-auth';
    await prisma.oAuthClientResourcePolicy.createMany({
      data: [
        { clientId: first, audience: exactAudience, enabled: true },
        { clientId: second, audience: secondAudience, enabled: true },
      ],
    });
    await expect(runHook(first)).resolves.toMatchObject({ claims: { aud: exactAudience } });
    await expect(runHook(second)).resolves.toMatchObject({ claims: { aud: secondAudience } });
  });

  it('executes within the two-second hook budget', async () => {
    const started = performance.now();
    await runHook();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('has fixed search_path, RLS, no public policy, and only the reviewed Auth-role grant', async () => {
    const [functions, tables, policies, grants] = await Promise.all([
      prisma.$queryRaw<Array<{ security_definer: boolean; configuration: string[] | null }>>`
        SELECT procedure.prosecdef AS security_definer, procedure.proconfig AS configuration
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure.proname = 'custom_access_token_hook'
          AND pg_get_function_identity_arguments(procedure.oid) = 'event jsonb'
      `,
      prisma.$queryRaw<Array<{ rls_enabled: boolean; rls_forced: boolean }>>`
        SELECT relation.relrowsecurity AS rls_enabled, relation.relforcerowsecurity AS rls_forced
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = 'OAuthClientResourcePolicy'
      `,
      prisma.$queryRaw<Array<{ policyname: string }>>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'OAuthClientResourcePolicy'
      `,
      prisma.$queryRaw<Array<{ grantee: string; privilege_type: string }>>`
        SELECT grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_schema = 'public' AND routine_name = 'custom_access_token_hook'
        ORDER BY grantee, privilege_type
      `,
    ]);
    expect(functions).toEqual([{
      security_definer: true,
      configuration: ['search_path=pg_catalog, public'],
    }]);
    expect(tables).toEqual([{ rls_enabled: true, rls_forced: false }]);
    expect(policies).toEqual([]);
    expect(grants.every((grant) => grant.privilege_type === 'EXECUTE')).toBe(true);
    expect(grants.every((grant) => !['PUBLIC', 'anon', 'authenticated', 'service_role'].includes(grant.grantee))).toBe(true);
  });
});
