import { spawnSync } from 'node:child_process';
import process from 'node:process';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { parseConfig } from '../../src/config/env.js';
import { prismaActorRepository } from '../../src/modules/actors/actors.repository.js';
import type { ActorRepository } from '../../src/modules/actors/actors.types.js';
import { prismaContentRepository } from '../../src/modules/content/content.repository.js';
import { disconnectPrisma, prisma } from '../../src/shared/database/prisma.js';

const config = parseConfig(process.env);
const app = createApp(config, { actorRepository: prismaActorRepository, contentRepository: prismaContentRepository });
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

  it('contains every principal table', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('Player', 'World', 'Campaign', 'Actor', 'ContentDefinition', 'ActorContent', 'GameEvent')
    `;
    expect(rows.map((row) => row.table_name).sort()).toEqual(['Actor', 'ActorContent', 'Campaign', 'ContentDefinition', 'GameEvent', 'Player', 'World']);
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
    expect(response.body).toMatchObject({ status: 'ok', service: 'cronicas-backend' });
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
    const failingApp = createApp(config, { actorRepository: failingRepository, contentRepository: prismaContentRepository });
    const response = await request(failingApp).get('/api/v1/actors/ralph').set('x-rpg-key', config.RPG_API_KEY);
    const serialized = JSON.stringify(response.body);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
    expect(serialized).not.toMatch(/Prisma|SELECT|postgresql:\/\/|game_gpt_test|secret|stack/i);
  });
});
