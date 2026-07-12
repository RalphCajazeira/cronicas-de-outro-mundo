import { spawnSync } from 'node:child_process';
import process from 'node:process';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { parseConfig } from '../../src/config/env.js';
import { prismaActorRepository } from '../../src/modules/actors/actors.repository.js';
import type { ActorRepository } from '../../src/modules/actors/actors.types.js';
import { prismaContentRepository } from '../../src/modules/content/content.repository.js';
import { prismaGptRepository } from '../../src/modules/gpt/gpt.repository.js';
import { prismaReadinessCheck } from '../../src/modules/health/health.repository.js';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';

const config = parseConfig(process.env);
const dependencies = { actorRepository: prismaActorRepository, contentRepository: prismaContentRepository, gptRepository: prismaGptRepository, readiness: prismaReadinessCheck };
const app = createApp(config, dependencies);
const authenticated = (path: string) => request(app).get(path).set('x-rpg-key', config.RPG_API_KEY);

afterAll(async () => {
  await disconnectPrisma();
});

describe('migration and PostgreSQL schema', () => {
  it('records the initial migration as successfully applied', async () => {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>`
      SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL
    `;
    const migration = rows.find((row) => row.migration_name === '20260711183000_init');
    expect(migration?.finished_at).toBeInstanceOf(Date);
  });

  it('records the production GPT security migration as successfully applied', async () => {
    const migration = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = '20260711223000_production_gpt_security' AND rolled_back_at IS NULL
    `;
    expect(migration[0]?.finished_at).toBeInstanceOf(Date);
  });

  it('contains every principal table', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
    `;
    expect(rows.map((row) => row.table_name).sort()).toEqual(['Actor', 'ActorContent', 'Campaign', 'ContentDefinition', 'GameEvent', 'IdempotencyRecord', 'Player', 'World']);
  });

  it('contains the principal foreign keys', async () => {
    const rows = await prisma.$queryRaw<Array<{ constraint_name: string }>>`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
    `;
    expect(rows.map((row) => row.constraint_name)).toEqual(expect.arrayContaining([
      'World_playerId_fkey', 'Campaign_worldId_fkey', 'Actor_campaignId_fkey',
      'ActorContent_actorId_fkey', 'ActorContent_contentDefinitionId_fkey',
    ]));
  });

  it('contains the partial global ContentDefinition index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ContentDefinition_global_scope_key'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toContain('WHERE ("campaignId" IS NULL)');
  });

  it('enables RLS without public policies on every Node platform table', async () => {
    const tables = await prisma.$queryRaw<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
    `;
    expect(tables).toHaveLength(8);
    expect(tables.every((table) => table.relrowsecurity)).toBe(true);
    expect(tables.every((table) => !table.relforcerowsecurity)).toBe(true);
    await expect(prisma.$queryRaw<Array<{ tablename: string }>>`SELECT tablename::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')`).resolves.toHaveLength(0);
  });

  it('does not grant table privileges to PUBLIC', async () => {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) privilege
      WHERE n.nspname = 'public'
        AND c.relname IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent', 'IdempotencyRecord')
        AND privilege.grantee = 0
    `;
    expect(rows[0]?.count).toBe(0);
  });

  it('keeps conditional Supabase revocations compatible when local roles do not exist', async () => {
    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`;
    expect(roles.map((role) => role.rolname).every((role) => ['anon', 'authenticated'].includes(role))).toBe(true);
    await expect(prisma.player.count()).resolves.toBeGreaterThanOrEqual(1);
  });
});

describe('idempotent seed', () => {
  async function counts() {
    const [players, worlds, campaigns, actors, definitions, links] = await Promise.all([
      prisma.player.count(), prisma.world.count(), prisma.campaign.count(), prisma.actor.count(),
      prisma.contentDefinition.count(), prisma.actorContent.count(),
    ]);
    return { players, worlds, campaigns, actors, definitions, links };
  }

  it('creates the expected initial records', async () => {
    await expect(counts()).resolves.toEqual({ players: 1, worlds: 1, campaigns: 1, actors: 2, definitions: 1, links: 1 });
  });

  it('keeps counts and the Ralph content link unchanged on a second seed', async () => {
    const before = await counts();
    const npmCli = process.env.npm_execpath;
    expect(npmCli).toBeDefined();
    const result = spawnSync(process.execPath, [npmCli ?? '', 'run', 'prisma:seed'], { env: process.env, stdio: 'pipe', encoding: 'utf8' });
    expect(result.status).toBe(0);
    await expect(counts()).resolves.toEqual(before);

    const ralph = await prisma.actor.findFirstOrThrow({ where: { code: 'ralph' }, include: { content: { include: { contentDefinition: true } } } });
    const lyraCount = await prisma.actor.count({ where: { code: 'lyra' } });
    const definitionCount = await prisma.contentDefinition.count({ where: { code: 'wind_breeze_step' } });
    expect(lyraCount).toBe(1);
    expect(definitionCount).toBe(1);
    expect(ralph.content).toHaveLength(1);
    expect(ralph.content[0]).toMatchObject({ state: 'LEARNING', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' });
  });
});

describe('complete API with real repositories', () => {
  it('serves health in memory without authentication', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('reports database readiness without leaking connection details', async () => {
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|Prisma|game_gpt_test/i);
  });

  it('enforces authentication without exposing the configured key', async () => {
    const absent = await request(app).get('/api/v1/characters/ralph');
    const wrong = await request(app).get('/api/v1/characters/ralph').set('x-rpg-key', 'wrong-key');
    expect(absent.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify([absent.body, wrong.body])).not.toContain(config.RPG_API_KEY);
  });

  it('returns Ralph by code and UUID as a normalized character', async () => {
    const byCode = await authenticated('/api/v1/characters/ralph');
    const id = (await prisma.actor.findFirstOrThrow({ where: { code: 'ralph' }, select: { id: true } })).id;
    const byId = await authenticated(`/api/v1/characters/${id}`);
    expect(byCode.status).toBe(200);
    expect(byId.status).toBe(200);
    expect(byCode.body).toMatchObject({ code: 'ralph', actorType: 'character', status: 'active' });
    expect(byId.body).toEqual(byCode.body);
    expect(byCode.body).not.toHaveProperty('id');
  });

  it('returns Ralph content with the database enum normalized', async () => {
    const response = await authenticated('/api/v1/characters/ralph/content');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ code: 'wind_breeze_step', state: 'learning', rank: 1, progress: 10, mastery: 0, notes: 'Treino inicial com Lyra' })]);
    expect(JSON.stringify(response.body)).not.toContain('contentDefinition');
  });

  it('returns Lyra and Passo da Brisa through real queries', async () => {
    const lyra = await authenticated('/api/v1/actors/lyra');
    const content = await authenticated('/api/v1/content/wind_breeze_step');
    expect(lyra.body).toMatchObject({ code: 'lyra', actorType: 'spirit', status: 'active' });
    expect(content.body).toMatchObject({ code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: 'skill', status: 'active' });
    expect(content.body).not.toHaveProperty('worldId');
  });

  it('distinguishes invalid and valid missing references', async () => {
    const invalid = await authenticated('/api/v1/actors/not%20valid');
    const missing = await authenticated('/api/v1/actors/11111111-1111-4111-8111-111111111111');
    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
  });

  it('converts a real PostgreSQL failure to a safe HTTP error', async () => {
    const failingRepository: ActorRepository = {
      async findByReference() {
        await prisma.$queryRawUnsafe('SELECT * FROM "table_that_does_not_exist"');
        return null;
      },
      listContent: () => Promise.resolve([]),
    };
    const failingApp = createApp(config, { ...dependencies, actorRepository: failingRepository });
    const response = await request(failingApp).get('/api/v1/actors/ralph').set('x-rpg-key', config.RPG_API_KEY);
    const serialized = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(serialized).not.toMatch(/Prisma|SELECT|postgresql:\/\/|game_gpt_test|secret|stack/i);
  });
});

describe('GPT v1 persistence with real transactions', () => {
  const post = (path: string, body: object) => request(app).post(path).set('x-rpg-key', config.RPG_API_KEY).send(body);
  const patch = (path: string, body: object) => request(app).patch(path).set('x-rpg-key', config.RPG_API_KEY).send(body);

  it('loads normalized state with protagonist, actors, linked content and limited events', async () => {
    const response = await post('/api/v1/game/load', {});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      player: { ref: 'ralph' }, world: { ref: 'elarion' }, campaign: { ref: 'main-campaign', status: 'active' },
      protagonist: { code: 'ralph', actorType: 'character' },
    });
    const body = response.body as Record<string, unknown>;
    expect(body.mainActors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'lyra', actorType: 'spirit' })]));
    expect(body.linkedContent).toEqual(expect.arrayContaining([expect.objectContaining({ actorRef: 'ralph', code: 'wind_breeze_step', state: 'learning' })]));
    expect(Array.isArray(body.recentEvents)).toBe(true);
    if (Array.isArray(body.recentEvents)) expect(body.recentEvents.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(response.body)).not.toMatch(/"id"|campaignId|worldId|actorId/);
  });

  it('starts a complete new scope idempotently and refuses incompatible reuse', async () => {
    const body = {
      idempotencyKey: 'integration-start-game-001', playerRef: 'new-player', playerDisplayName: 'Novo Jogador',
      worldRef: 'new-world', worldName: 'Novo Mundo', campaignRef: 'new-campaign', campaignName: 'Nova Campanha',
      protagonist: { code: 'new-player', name: 'Novo Herói', actorType: 'character', className: 'Explorador', health: 18, maxHealth: 18, mana: 6, maxMana: 6, attributes: { vitality: 4 } },
    };
    const first = await post('/api/v1/game/start', body);
    const retry = await post('/api/v1/game/start', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({
      player: { ref: 'new-player' }, world: { ref: 'new-world' }, campaign: { ref: 'new-campaign', status: 'active' },
      protagonist: { code: 'new-player', actorType: 'character', health: 18 }, mainActors: [], linkedContent: [], recentEvents: [],
    });
    await expect(prisma.player.count({ where: { slug: 'new-player' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);

    const conflict = await post('/api/v1/game/start', { ...body, campaignName: 'Outra Campanha' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
  });

  it('does not overwrite an existing campaign when starting a game', async () => {
    const key = 'integration-start-existing-001';
    const response = await post('/api/v1/game/start', {
      idempotencyKey: key, playerDisplayName: 'Ralph', worldName: 'Elarion', campaignName: 'Campanha Principal',
      protagonist: { code: 'ralph', name: 'Ralph', actorType: 'character' },
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'CONFLICT', message: 'Campaign already contains state' } });
    await expect(prisma.idempotencyRecord.count({ where: { key } })).resolves.toBe(0);
  });

  it('lists campaign actors with normalized enums', async () => {
    const response = await authenticated('/api/v1/campaigns/main-campaign/actors');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ralph', actorType: 'character', status: 'active' }),
      expect.objectContaining({ code: 'lyra', actorType: 'spirit', status: 'active' }),
    ]));
  });

  it('upserts one actor under concurrent retries and rejects incompatible key reuse', async () => {
    const body = { idempotencyKey: 'integration-actor-orin-001', code: 'orin', name: 'Orin', actorType: 'npc', role: 'Guardião', health: 12, maxHealth: 12, mana: 2, maxMana: 2, metadata: { zeta: 1, alpha: { second: 2, first: 1 } } };
    const reorderedBody = { metadata: { alpha: { first: 1, second: 2 }, zeta: 1 }, maxMana: 2, mana: 2, maxHealth: 12, health: 12, role: 'Guardião', actorType: 'npc', name: 'Orin', code: 'orin', idempotencyKey: 'integration-actor-orin-001' };
    const [first, retry] = await Promise.all([post('/api/v1/actors/upsert', body), post('/api/v1/actors/upsert', reorderedBody)]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    await expect(prisma.actor.count({ where: { code: 'orin' } })).resolves.toBe(1);
    await expect(prisma.idempotencyRecord.count({ where: { key: body.idempotencyKey } })).resolves.toBe(1);

    const conflict = await post('/api/v1/actors/upsert', { ...body, name: 'Outro Orin' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: { code: 'CONFLICT', message: 'Idempotency key already used' } });
  });

  it('patches only approved actor mechanics idempotently', async () => {
    const body = { idempotencyKey: 'integration-actor-orin-patch-001', health: 9, xp: 25, attributes: { strength: 7 }, status: 'active' };
    const first = await patch('/api/v1/actors/orin', body);
    const retry = await patch('/api/v1/actors/orin', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'orin', health: 9, xp: 25, attributes: { strength: 7 }, status: 'active' });
    expect(first.body).not.toHaveProperty('id');
  });

  it('upserts a complete content definition idempotently', async () => {
    const body = {
      idempotencyKey: 'integration-content-quiet-step-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso',
      description: 'Movimento discreto.', mechanics: { effect: 'stealth' }, requirements: { level: 1 }, presentation: { sound: 'none' },
      tags: ['stealth'], schemaVersion: 1, status: 'active',
    };
    const first = await post('/api/v1/content/upsert', body);
    const retry = await post('/api/v1/content/upsert', body);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ code: 'quiet-step', contentType: 'skill', status: 'active' });
    await expect(prisma.contentDefinition.count({ where: { code: 'quiet-step' } })).resolves.toBe(1);
  });

  it('gets, lists, learns, updates, equips, unequips and removes actor content', async () => {
    const getExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'get', contentRef: 'wind_breeze_step', contentType: 'skill' });
    const listExisting = await post('/api/v1/actors/ralph/content/manage', { operation: 'list' });
    expect(getExisting.body).toMatchObject({ code: 'wind_breeze_step', state: 'learning' });
    expect(listExisting.body).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'wind_breeze_step' })]));

    const learnBody = { operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-learn-quiet-step-001', changes: { progress: 5, notes: 'Primeiro treino' } };
    const learn = await post('/api/v1/actors/ralph/content/manage', learnBody);
    const learnRetry = await post('/api/v1/actors/ralph/content/manage', learnBody);
    expect(learn.status).toBe(200);
    expect(learnRetry.body).toEqual(learn.body);
    expect(learn.body).toMatchObject({ code: 'quiet-step', state: 'learning', progress: 5 });

    const update = await post('/api/v1/actors/ralph/content/manage', { operation: 'update', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-update-quiet-step-001', changes: { state: 'known', rank: 2, progress: 30, mastery: 4 } });
    const equip = await post('/api/v1/actors/ralph/content/manage', { operation: 'equip', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-equip-quiet-step-001' });
    const unequip = await post('/api/v1/actors/ralph/content/manage', { operation: 'unequip', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-unequip-quiet-step-001' });
    const remove = await post('/api/v1/actors/ralph/content/manage', { operation: 'remove', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'integration-remove-quiet-step-001' });
    expect(update.body).toMatchObject({ state: 'known', rank: 2, progress: 30, mastery: 4 });
    expect(equip.body).toMatchObject({ equipped: true });
    expect(unequip.body).toMatchObject({ equipped: false });
    expect(remove.body).toMatchObject({ actorRef: 'ralph', contentRef: 'quiet-step', removed: true });
    await expect(prisma.actorContent.count({ where: { contentDefinition: { code: 'quiet-step' } } })).resolves.toBe(0);
  });

  it('rolls back the idempotency reservation when the related mutation fails', async () => {
    const key = 'integration-rollback-link-001';
    const failed = await post('/api/v1/actors/missing/content/manage', { operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: key });
    expect(failed.status).toBe(404);
    await expect(prisma.idempotencyRecord.count({ where: { key } })).resolves.toBe(0);
  });

  it('persists one event for repeated and concurrent idempotent requests', async () => {
    const body = { campaignRef: 'main-campaign', actorRef: 'ralph', eventType: 'quiet-step-trained', title: 'Treino concluído', payload: { progress: 30 }, idempotencyKey: 'integration-event-training-001' };
    const [first, retry] = await Promise.all([post('/api/v1/events', body), post('/api/v1/events', body)]);
    expect(first.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(first.body).toMatchObject({ campaignRef: 'main-campaign', actorRef: 'ralph', eventType: 'quiet-step-trained' });
    await expect(prisma.gameEvent.count({ where: { idempotencyKey: body.idempotencyKey } })).resolves.toBe(1);
  });
});
