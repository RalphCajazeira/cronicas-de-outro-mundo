import request from 'supertest';
import { ActorStatus, ActorType, ContentStatus, ContentType, type ContentDefinition } from './generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppConfig } from './config/env.js';
import type { ActorRepository } from './modules/actors/actors.types.js';
import type { ContentRepository } from './modules/content/content.types.js';
import type { GptRepository } from './modules/gpt/gpt.types.js';
import type { ReadinessCheck } from './modules/health/health.routes.js';
import { getOfficialContract } from './modules/openapi/openapi.routes.js';

const config: AppConfig = { NODE_ENV: 'test', HOST: '0.0.0.0', PORT: 3000, DATABASE_URL: 'postgresql://test:test@localhost:5432/test', DIRECT_URL: 'postgresql://test:test@localhost:5432/test', RPG_API_KEY: 'test-key' };
const actor = { id: '7e7b7cbe-5767-47de-a0b5-4b7bc9365c89', code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, species: null, className: 'Aventureiro', level: 1, xp: 0, gold: 0, health: 20, maxHealth: 20, mana: 10, maxMana: 10, attributes: { strength: 5 }, resistances: {}, affinities: {}, status: ActorStatus.ACTIVE };
const contentItem = { state: 'LEARNING', rank: 1, progress: 10, mastery: 0, equipped: false, quantity: 1, notes: 'Treino inicial com Lyra', contentDefinition: { code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: 'SKILL', description: 'Movimento pelo vento.', mechanics: { effect: 'mobility' }, requirements: { level: 1 }, presentation: { element: 'wind' }, tags: ['wind'], schemaVersion: 1, status: 'ACTIVE' } };
const definition: ContentDefinition = { id: 'b41c2a1c-e2d2-4498-a7be-1f07cd85de1a', worldId: 'e2dc20e8-51dc-47d2-a5be-b841d08fa610', campaignId: null, code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: ContentType.SKILL, description: null, mechanics: {}, requirements: {}, presentation: {}, tags: ['wind'], schemaVersion: 1, status: ContentStatus.ACTIVE, metadata: {}, createdAt: new Date(), updatedAt: new Date() };
const emptyGptRepository: GptRepository = {
  loadGame: () => Promise.resolve({}), listCampaignActors: () => Promise.resolve([]), upsertActor: () => Promise.resolve({}),
  patchActor: () => Promise.resolve({}), upsertContent: () => Promise.resolve({}), manageActorContent: () => Promise.resolve({}), createEvent: () => Promise.resolve({}),
};

function appWith(
  actorRepository: ActorRepository = { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([contentItem]) },
  contentRepository: ContentRepository = { findByReference: () => Promise.resolve(definition) },
  gptRepository: GptRepository = {
    loadGame: (input) => Promise.resolve({ ...input, protagonist: { code: 'ralph' } }),
    listCampaignActors: () => Promise.resolve([{ code: 'ralph', actorType: 'character' }]),
    upsertActor: (input) => Promise.resolve({ code: input.code, name: input.name, actorType: input.actorType }),
    patchActor: (actorRef, input) => Promise.resolve({ code: actorRef, health: input.health }),
    upsertContent: (input) => Promise.resolve({ code: input.code, contentType: input.contentType }),
    manageActorContent: (_actorRef, input) => Promise.resolve({ operation: input.operation, state: input.changes?.state ?? 'known' }),
    createEvent: (input) => Promise.resolve({ eventType: input.eventType, title: input.title }),
  },
  readiness: ReadinessCheck = { check: () => Promise.resolve(true) },
) {
  return createApp(config, { actorRepository, contentRepository, gptRepository, readiness });
}

describe('HTTP API', () => {
  it('returns health without authentication', async () => { const response = await request(appWith()).get('/health'); expect(response.status).toBe(200); expect(response.body).toEqual({ status: 'ok' }); });
  it('returns safe readiness states without authentication', async () => {
    const ready = await request(appWith()).get('/health/ready');
    const notReady = await request(appWith(undefined, undefined, undefined, { check: () => Promise.reject(new Error('postgresql://secret/internal')) })).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready' });
    expect(notReady.status).toBe(503);
    expect(notReady.body).toEqual({ status: 'not_ready' });
    expect(JSON.stringify(notReady.body)).not.toContain('secret');
  });
  it('serves OpenAPI publicly with the configured base URL', async () => {
    const response = await request(createApp({ ...config, PUBLIC_BASE_URL: 'https://rpg.example.com' }, {
      actorRepository: { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([]) },
      contentRepository: { findByReference: () => Promise.resolve(definition) },
      gptRepository: emptyGptRepository,
      readiness: { check: () => Promise.resolve(true) },
    })).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ servers: [{ url: 'https://rpg.example.com' }] });
    expect(getOfficialContract()).toMatchObject({ servers: [{ url: 'https://api.example.com' }] });
  });
  it('rejects a private route without x-rpg-key', async () => { expect((await request(appWith()).get('/api/v1/characters/ralph')).status).toBe(401); });
  it('rejects a private route with the wrong x-rpg-key', async () => { expect((await request(appWith()).get('/api/v1/characters/ralph').set('x-rpg-key', 'wrong-key')).status).toBe(401); });
  it('reaches the controller with a valid key and normalizes a character', async () => { const response = await request(appWith()).get('/api/v1/characters/ralph').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual({ code: 'ralph', name: 'Ralph', actorType: 'character', species: null, className: 'Aventureiro', level: 1, xp: 0, gold: 0, health: 20, maxHealth: 20, mana: 10, maxMana: 10, attributes: { strength: 5 }, resistances: {}, affinities: {}, status: 'active' }); expect(response.body).not.toHaveProperty('id'); });
  it('validates an invalid characterRef', async () => { expect((await request(appWith()).get('/api/v1/characters/not%20valid').set('x-rpg-key', 'test-key')).status).toBe(400); });
  it('returns 404 for a missing character', async () => { const repository: ActorRepository = { findByReference: () => Promise.resolve(null), listContent: () => Promise.resolve(null) }; expect((await request(appWith(repository)).get('/api/v1/characters/missing').set('x-rpg-key', 'test-key')).status).toBe(404); });
  it('normalizes character content', async () => { const response = await request(appWith()).get('/api/v1/characters/ralph/content').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual([expect.objectContaining({ code: 'wind_breeze_step', contentType: 'skill', state: 'learning', status: 'active', progress: 10, notes: 'Treino inicial com Lyra', mechanics: { effect: 'mobility' } })]); expect(JSON.stringify(response.body)).not.toContain('contentDefinition'); });
  it('normalizes content and omits raw Prisma fields', async () => { const response = await request(appWith()).get('/api/v1/content/wind_breeze_step').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toMatchObject({ code: 'wind_breeze_step', contentType: 'skill', status: 'active' }); expect(response.body).not.toHaveProperty('id'); expect(response.body).not.toHaveProperty('worldId'); });
  it('returns a contract-safe 404 for a missing content definition', async () => { const repository: ContentRepository = { findByReference: () => Promise.resolve(null) }; const response = await request(appWith(undefined, repository)).get('/api/v1/content/missing').set('x-rpg-key', 'test-key'); expect(response.status).toBe(404); expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Content not found' } }); });
  it('does not expose repository errors', async () => { const repository: ActorRepository = { findByReference: () => Promise.reject(new Error('postgresql://secret@remote/internal Prisma failure')), listContent: () => Promise.resolve([]) }; const response = await request(appWith(repository)).get('/api/v1/actors/ralph').set('x-rpg-key', 'test-key'); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('Prisma'); expect(JSON.stringify(response.body)).not.toContain('secret'); });
  it('loads the game with defaults through the protected GPT API', async () => {
    const response = await request(appWith()).post('/api/v1/game/load').set('x-rpg-key', 'test-key').send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ playerRef: 'ralph', worldRef: 'elarion', campaignRef: 'main-campaign' });
  });
  it('lists campaign actors and supports actor upsert and approved patch fields', async () => {
    const list = await request(appWith()).get('/api/v1/campaigns/main-campaign/actors').set('x-rpg-key', 'test-key');
    const upsert = await request(appWith()).post('/api/v1/actors/upsert').set('x-rpg-key', 'test-key').send({ idempotencyKey: 'actor-create-001', code: 'orin', name: 'Orin', actorType: 'npc' });
    const patchResponse = await request(appWith()).patch('/api/v1/actors/orin').set('x-rpg-key', 'test-key').send({ idempotencyKey: 'actor-patch-001', health: 7 });
    expect(list.body).toEqual([{ code: 'ralph', actorType: 'character' }]);
    expect(upsert.body).toMatchObject({ code: 'orin', actorType: 'npc' });
    expect(patchResponse.body).toMatchObject({ code: 'orin', health: 7 });
  });
  it('rejects arbitrary actor relation fields', async () => {
    const response = await request(appWith()).patch('/api/v1/actors/ralph').set('x-rpg-key', 'test-key').send({ idempotencyKey: 'actor-patch-002', campaignId: 'forbidden' });
    expect(response.status).toBe(400);
  });
  it('upserts content and validates actor-content idempotency for writes', async () => {
    const content = await request(appWith()).post('/api/v1/content/upsert').set('x-rpg-key', 'test-key').send({
      idempotencyKey: 'content-upsert-001', contentType: 'skill', code: 'quiet-step', name: 'Passo Silencioso',
      description: 'Movimento discreto.', mechanics: {}, requirements: {}, presentation: {}, tags: ['stealth'], schemaVersion: 1, status: 'active',
    });
    const invalidManage = await request(appWith()).post('/api/v1/actors/ralph/content/manage').set('x-rpg-key', 'test-key').send({ operation: 'learn', contentRef: 'quiet-step', contentType: 'skill' });
    const manage = await request(appWith()).post('/api/v1/actors/ralph/content/manage').set('x-rpg-key', 'test-key').send({ operation: 'learn', contentRef: 'quiet-step', contentType: 'skill', idempotencyKey: 'learn-quiet-step-001' });
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ code: 'quiet-step', contentType: 'skill' });
    expect(invalidManage.status).toBe(400);
    expect(manage.body).toMatchObject({ operation: 'learn' });
  });
  it('registers events and requires authentication before input validation', async () => {
    const unauthorized = await request(appWith()).post('/api/v1/events').send({});
    const event = await request(appWith()).post('/api/v1/events').set('x-rpg-key', 'test-key').send({ campaignRef: 'main-campaign', eventType: 'scene-ended', title: 'Cena encerrada', payload: {}, idempotencyKey: 'event-scene-001' });
    expect(unauthorized.status).toBe(401);
    expect(event.body).toMatchObject({ eventType: 'scene-ended', title: 'Cena encerrada' });
  });
});
