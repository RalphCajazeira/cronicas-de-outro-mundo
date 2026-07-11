import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Router } from 'express';

const contractPath = [resolve('gpt/openapi.json'), resolve('../gpt/openapi.json')].find(existsSync);
if (contractPath === undefined) throw new Error('Official OpenAPI contract not found');
const officialContract = JSON.parse(readFileSync(contractPath, 'utf8')) as Record<string, unknown>;

export const ACTIVE_API_ROUTES = [
  'GET /health',
  'GET /health/ready',
  'GET /openapi.json',
  'POST /api/v1/game/load',
  'GET /api/v1/campaigns/:campaignRef/actors',
  'GET /api/v1/characters/:characterRef',
  'GET /api/v1/characters/:characterRef/content',
  'GET /api/v1/actors/:actorRef',
  'POST /api/v1/actors/upsert',
  'PATCH /api/v1/actors/:actorRef',
  'POST /api/v1/actors/:actorRef/content/manage',
  'GET /api/v1/content/:contentRef',
  'POST /api/v1/content/upsert',
  'POST /api/v1/events',
] as const;

export function createOpenApiRouter(baseUrl: string) {
  return Router().get('/', (_request, response) => {
    response.json({ ...officialContract, servers: [{ url: baseUrl }] });
  });
}

export function getOfficialContract(): Record<string, unknown> {
  return structuredClone(officialContract);
}
