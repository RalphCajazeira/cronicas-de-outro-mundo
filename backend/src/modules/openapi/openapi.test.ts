import { describe, expect, it } from 'vitest';
import { ACTIVE_API_ROUTES, getOfficialContract } from './openapi.routes.js';

interface Operation { operationId?: string; security?: unknown; requestBody?: { content?: { 'application/json'?: { schema?: Schema } } }; description?: string; responses?: Record<string, unknown> }
interface Schema {
  $ref?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  allOf?: Schema[];
  additionalProperties?: boolean;
  enum?: unknown[];
  if?: Schema;
  then?: Schema;
  not?: Schema;
}
interface Contract {
  openapi: string;
  servers: Array<{ url: string }>;
  security: unknown;
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, Record<string, unknown>>; schemas: Record<string, Schema> };
}

const contract = getOfficialContract() as unknown as Contract;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);

function operations() {
  return Object.entries(contract.paths).flatMap(([path, pathItem]) => Object.entries(pathItem)
    .filter(([method]) => methods.has(method))
    .map(([method, operation]) => ({ path, method, operation })));
}

function resolveSchema(schema: Schema | undefined): Schema {
  if (schema?.$ref === undefined) return schema ?? {};
  return contract.components.schemas[schema.$ref.split('/').at(-1) ?? ''] ?? {};
}

function collectEnums(value: unknown, result: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEnums(item, result));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'enum' && Array.isArray(item)) result.push(item);
      collectEnums(item, result);
    }
  }
  return result;
}

describe('official OpenAPI contract', () => {
  it('is valid JSON loaded as OpenAPI 3.1 with exactly 14 unique operationIds', () => {
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(contract.openapi).toBe('3.1.0');
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(14);
  });

  it('matches every registered Express route exactly', () => {
    const documented = operations().map(({ path, method }) => `${method.toUpperCase()} ${path.replaceAll(/{([^}]+)}/g, ':$1')}`).sort();
    expect(documented).toEqual([...ACTIVE_API_ROUTES].sort());
  });

  it('uses x-rpg-key globally and explicitly keeps only public routes unauthenticated', () => {
    expect(contract.components.securitySchemes.RpgApiKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-rpg-key' });
    expect(contract.security).toEqual([{ RpgApiKey: [] }]);
    const publicIds = operations().filter(({ operation }) => Array.isArray(operation.security) && operation.security.length === 0).map(({ operation }) => operation.operationId).sort();
    expect(publicIds).toEqual(['checkHealth', 'checkReadiness', 'getOpenApiContract']);
  });

  it('contains no localhost production server', () => {
    expect(contract.servers.every(({ url }) => !/localhost|127\.0\.0\.1/i.test(url))).toBe(true);
  });

  it.each(['upsertActor', 'updateActor', 'upsertContent', 'createGameEvent'])('%s requires idempotencyKey', (operationId) => {
    const operation = operations().find((item) => item.operation.operationId === operationId)?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    const required = new Set([...(schema.required ?? []), ...(schema.allOf ?? []).flatMap((item) => resolveSchema(item).required ?? [])]);
    expect(required.has('idempotencyKey')).toBe(true);
  });

  it('documents conditional idempotency for actor-content writes', () => {
    const operation = operations().find((item) => item.operation.operationId === 'manageActorContent')?.operation;
    const schema = resolveSchema(operation?.requestBody?.content?.['application/json']?.schema);
    expect(schema.properties).toHaveProperty('idempotencyKey');
    expect(operation?.description).toContain('exigem idempotencyKey');
    expect(schema.allOf).toEqual(expect.arrayContaining([
      expect.objectContaining({ then: { required: ['idempotencyKey'] } }),
    ]));
  });

  it('documents safe errors for every protected API operation', () => {
    for (const { path, operation } of operations().filter(({ path }) => path.startsWith('/api/v1/'))) {
      expect(Object.keys(operation.responses ?? {}), path).toEqual(expect.arrayContaining(['400', '401', '404', '409', '500']));
    }
  });

  it('uses closed request objects and lowercase public enums', () => {
    const requestSchemas = operations().map(({ operation }) => resolveSchema(operation.requestBody?.content?.['application/json']?.schema)).filter((schema) => Object.keys(schema).length > 0);
    expect(requestSchemas.every((schema) => schema.additionalProperties === false)).toBe(true);
    const enumStrings = collectEnums(contract).flat().filter((value): value is string => typeof value === 'string');
    expect(enumStrings.every((value) => value === value.toLowerCase())).toBe(true);
  });

  it('contains neither legacy endpoints nor sensitive infrastructure', () => {
    const serialized = JSON.stringify(contract);
    expect(Object.keys(contract.paths).every((path) => !/rpg-gpt|rpg-state|rpg-combat|functions\/v1/i.test(path))).toBe(true);
    expect(serialized).not.toMatch(/supabase\.co|onrender\.com|service[_-]?role|postgres(?:ql)?:\/\//i);
  });
});
