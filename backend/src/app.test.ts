import request from 'supertest';
import { ActorStatus, ActorType, ContentStatus, ContentType, type ContentDefinition } from './generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppConfig } from './config/env.js';
import type { ActorRepository } from './modules/actors/actors.types.js';
import type { ContentRepository } from './modules/content/content.types.js';

const config: AppConfig = { NODE_ENV: 'test', PORT: 3000, DATABASE_URL: 'postgresql://test:test@localhost:5432/test', DIRECT_URL: 'postgresql://test:test@localhost:5432/test', RPG_API_KEY: 'test-key' };
const actor = { id: '7e7b7cbe-5767-47de-a0b5-4b7bc9365c89', code: 'ralph', name: 'Ralph', actorType: ActorType.CHARACTER, species: null, className: 'Aventureiro', level: 1, xp: 0, gold: 0, health: 20, maxHealth: 20, mana: 10, maxMana: 10, attributes: { strength: 5 }, resistances: {}, affinities: {}, status: ActorStatus.ACTIVE };
const contentItem = { state: 'LEARNING', rank: 1, progress: 10, mastery: 0, equipped: false, quantity: 1, notes: 'Treino inicial com Lyra', contentDefinition: { code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: 'SKILL', description: 'Movimento pelo vento.', mechanics: { effect: 'mobility' }, requirements: { level: 1 }, presentation: { element: 'wind' }, tags: ['wind'], schemaVersion: 1, status: 'ACTIVE' } };
const definition: ContentDefinition = { id: 'b41c2a1c-e2d2-4498-a7be-1f07cd85de1a', worldId: 'e2dc20e8-51dc-47d2-a5be-b841d08fa610', campaignId: null, code: 'wind_breeze_step', name: 'Passo da Brisa', contentType: ContentType.SKILL, description: null, mechanics: {}, requirements: {}, presentation: {}, tags: ['wind'], schemaVersion: 1, status: ContentStatus.ACTIVE, metadata: {}, createdAt: new Date(), updatedAt: new Date() };

function appWith(
  actorRepository: ActorRepository = { findByReference: () => Promise.resolve(actor), listContent: () => Promise.resolve([contentItem]) },
  contentRepository: ContentRepository = { findByReference: () => Promise.resolve(definition) },
) {
  return createApp(config, { actorRepository, contentRepository });
}

describe('HTTP API', () => {
  it('returns health without authentication', async () => { const response = await request(appWith()).get('/health'); expect(response.status).toBe(200); expect(response.body).toMatchObject({ status: 'ok', service: 'cronicas-backend' }); });
  it('rejects a private route without x-rpg-key', async () => { expect((await request(appWith()).get('/api/v1/characters/ralph')).status).toBe(401); });
  it('rejects a private route with the wrong x-rpg-key', async () => { expect((await request(appWith()).get('/api/v1/characters/ralph').set('x-rpg-key', 'wrong-key')).status).toBe(401); });
  it('reaches the controller with a valid key and normalizes a character', async () => { const response = await request(appWith()).get('/api/v1/characters/ralph').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual({ code: 'ralph', name: 'Ralph', actorType: 'character', species: null, className: 'Aventureiro', level: 1, xp: 0, gold: 0, health: 20, maxHealth: 20, mana: 10, maxMana: 10, attributes: { strength: 5 }, resistances: {}, affinities: {}, status: 'active' }); expect(response.body).not.toHaveProperty('id'); });
  it('validates an invalid characterRef', async () => { expect((await request(appWith()).get('/api/v1/characters/not%20valid').set('x-rpg-key', 'test-key')).status).toBe(400); });
  it('returns 404 for a missing character', async () => { const repository: ActorRepository = { findByReference: () => Promise.resolve(null), listContent: () => Promise.resolve(null) }; expect((await request(appWith(repository)).get('/api/v1/characters/missing').set('x-rpg-key', 'test-key')).status).toBe(404); });
  it('normalizes character content', async () => { const response = await request(appWith()).get('/api/v1/characters/ralph/content').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toEqual([expect.objectContaining({ code: 'wind_breeze_step', contentType: 'skill', state: 'learning', status: 'active', progress: 10, notes: 'Treino inicial com Lyra', mechanics: { effect: 'mobility' } })]); expect(JSON.stringify(response.body)).not.toContain('contentDefinition'); });
  it('normalizes content and omits raw Prisma fields', async () => { const response = await request(appWith()).get('/api/v1/content/wind_breeze_step').set('x-rpg-key', 'test-key'); expect(response.status).toBe(200); expect(response.body).toMatchObject({ code: 'wind_breeze_step', contentType: 'skill', status: 'active' }); expect(response.body).not.toHaveProperty('id'); expect(response.body).not.toHaveProperty('worldId'); });
  it('returns a contract-safe 404 for a missing content definition', async () => { const repository: ContentRepository = { findByReference: () => Promise.resolve(null) }; const response = await request(appWith(undefined, repository)).get('/api/v1/content/missing').set('x-rpg-key', 'test-key'); expect(response.status).toBe(404); expect(response.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Content not found' } }); });
  it('does not expose repository errors', async () => { const repository: ActorRepository = { findByReference: () => Promise.reject(new Error('postgresql://secret@remote/internal Prisma failure')), listContent: () => Promise.resolve([]) }; const response = await request(appWith(repository)).get('/api/v1/actors/ralph').set('x-rpg-key', 'test-key'); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('Prisma'); expect(JSON.stringify(response.body)).not.toContain('secret'); });
});
