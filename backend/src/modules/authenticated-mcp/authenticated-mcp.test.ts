import type { Server } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import type { ExternalIdentityRecord, IdentityRepository } from '../identity/identity.types.js';
import { createIdentityService } from '../identity/identity.service.js';
import { createProtectedResourceMetadataRouter } from '../oauth-resource-server/protected-resource-metadata.routes.js';
import {
  createOAuthResourceServerAuthentication,
} from '../oauth-resource-server/oauth-resource-server.middleware.js';
import type { OAuthResourceServerConfig } from '../../config/env.js';
import { createRequestAudit, type HttpAuditRecord } from '../../shared/http/request-audit.js';
import { createHealthRouter } from '../health/health.routes.js';
import { createChatGptAppRouter } from '../chatgpt-app/mcp/chatgpt-app.routes.js';
import type { WidgetAssets } from '../chatgpt-app/resources/widget-assets.js';
import type {
  AuthenticatedGameContextRepository,
} from '../authenticated-game-context/authenticated-game-context.types.js';
import { createAuthenticatedGameContextService } from '../authenticated-game-context/authenticated-game-context.service.js';
import {
  startOAuthTestIssuer,
  symmetricToken,
  type OAuthTestIssuer,
} from '../../../tests/support/oauth-test-issuer.js';
import { createAuthenticatedMcpRouter } from './authenticated-mcp.routes.js';
import {
  AUTHENTICATED_HOME_RESOURCE_URI,
  authenticatedBootstrapSchema,
  GET_AUTHENTICATED_BOOTSTRAP_TOOL,
  LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL,
  LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
  SELECT_AUTHENTICATED_GAME_CONTEXT_TOOL,
} from './authenticated-mcp.server.js';
import { authenticatedGameContextSchema } from '../authenticated-game-context/authenticated-game-context.dto.js';
import { createAuthenticatedCharacterViewService } from '../authenticated-character-view/authenticated-character-view.service.js';
import type {
  AuthenticatedCharacterSnapshot,
  AuthenticatedCharacterViewRepository,
} from '../authenticated-character-view/authenticated-character-view.types.js';
import { authenticatedCharacterViewSchema } from '../authenticated-character-view/authenticated-character-view.dto.js';
import { authenticatedSelectionRef } from '../authenticated-game-context/authenticated-selection-ref.js';
import { createAuthenticatedGameSessionService } from '../authenticated-game-session/authenticated-game-session.service.js';
import type { AuthenticatedGameSessionRepository } from '../authenticated-game-session/authenticated-game-session.types.js';
import { authenticatedGameSessionSelectionResultSchema } from '../authenticated-game-session/authenticated-game-session.dto.js';

const widgetAssets: WidgetAssets = {
  readHome: () => Promise.resolve('<!doctype html><title>Public fixture</title>'),
  readAuthenticatedHome: () => Promise.resolve('<!doctype html><title>Authenticated home</title>'),
  readPreview: () => Promise.resolve('<!doctype html><title>Public preview</title>'),
};

let oauthIssuer: OAuthTestIssuer;

beforeAll(async () => {
  oauthIssuer = await startOAuthTestIssuer();
});

beforeEach(() => {
  oauthIssuer.reset();
});

afterAll(async () => {
  await oauthIssuer.close();
});

function identity(
  subject: string,
  status: UserStatus = UserStatus.ACTIVE,
  overrides: Partial<ExternalIdentityRecord['user']> = {},
): ExternalIdentityRecord {
  const internalUserId = subject === 'second-subject'
    ? '00000000-0000-4000-8000-000000000002'
    : '00000000-0000-4000-8000-000000000001';
  return {
    id: `external-${subject}`,
    issuer: oauthIssuer.issuer,
    subject,
    user: {
      id: internalUserId,
      status,
      suspendedAt: status === UserStatus.SUSPENDED ? new Date('2026-01-01T00:00:00.000Z') : null,
      deletedAt: status === UserStatus.DELETED ? new Date('2026-01-01T00:00:00.000Z') : null,
      ...overrides,
    },
  };
}

function repository(records: readonly ExternalIdentityRecord[]): IdentityRepository {
  return {
    findByPrincipal: (principal) => Promise.resolve(records.filter(
      (record) => record.issuer === principal.issuer && record.subject === principal.subject,
    )),
  };
}

function gameAccessRepository(): AuthenticatedGameContextRepository {
  return {
    findGameAccessByUserId: (requestedUserId) => Promise.resolve({
      id: requestedUserId,
      status: UserStatus.ACTIVE,
      suspendedAt: null,
      deletedAt: null,
      player: {
        id: 'player-synthetic',
        displayName: 'OAuth Staging Tester',
      },
      campaignMemberships: [{
        campaignId: 'campaign-synthetic',
        userId: requestedUserId,
        role: CampaignMembershipRole.PLAYER,
        status: CampaignMembershipStatus.ACTIVE,
        revokedAt: null,
        campaign: {
          id: 'campaign-synthetic',
          name: 'OAuth Readonly Test',
          status: CampaignStatus.ACTIVE,
          world: { name: 'OAuth Test World' },
        },
      }],
      actorControls: [{
        actorId: 'actor-synthetic',
        userId: requestedUserId,
        permission: ActorControlPermission.CONTROL,
        revokedAt: null,
        actor: {
          id: 'actor-synthetic',
          campaignId: 'campaign-synthetic',
          name: 'Test Adventurer',
          level: 1,
          actorType: ActorType.CHARACTER,
          status: ActorStatus.ACTIVE,
          resources: [],
          derivedSnapshot: null,
        },
      }],
    }),
  };
}

function minimalCharacterSnapshot(): AuthenticatedCharacterSnapshot {
  const primaryAttributes = {
    strength: 10,
    vitality: 10,
    agility: 10,
    dexterity: 10,
    intelligence: 10,
    wisdom: 10,
    perception: 10,
    willpower: 10,
    luck: 10,
  };
  return {
    actor: {
      id: 'actor-synthetic',
      name: 'Test Adventurer',
      species: null,
      className: null,
      role: null,
      description: null,
      level: 1,
      xp: 0,
      gold: 0,
      status: 'active',
      campaignName: 'OAuth Readonly Test',
      worldName: 'OAuth Test World',
      engineTick: 0n,
    },
    storedAttributes: Object.entries(primaryAttributes).map(([code, baseValue]) => ({
      code,
      baseValue,
      earnedValue: 0,
      xp: 0,
    })),
    mechanicalSheet: {
      primaryAttributes,
      resources: {
        hp: { current: 20, max: 20, stateVersion: 1 },
        mana: { current: 10, max: 10, stateVersion: 1 },
        sp: { current: 10, max: 10, stateVersion: 1 },
      },
      secondaryAttributes: {
        actorPhysicalPower: 10,
        actorMagicalPower: 10,
        physicalDefense: 5,
        magicalDefense: 5,
        accuracy: 10,
        evasion: 10,
        stealth: 10,
        detection: 10,
        baseAttackSpeedBps: 10_000,
        baseCastingSpeedBps: 10_000,
        criticalChanceBps: 500,
        criticalDamageBps: 15_000,
        movementSpeed: 5,
        carryingCapacity: 50,
        physicalResistanceBps: 0,
        magicalResistanceBps: 0,
        elementalResistanceBps: {},
        hpRegen: 1,
        manaRegen: 1,
        spRegen: 1,
      },
      mechanicsStateVersion: 1,
      inventoryStateVersion: 1,
      effectsStateVersion: 1,
      ruleset: { code: 'core-v1', revision: '1.2.0' },
    },
    inventory: [],
    abilities: [],
    statusEffects: [],
  };
}

interface AuthenticatedHost {
  readonly audits: HttpAuditRecord[];
  readonly endpoint: URL;
  readonly metadataEndpoint: URL;
  readonly rootMetadataEndpoint: URL;
  readonly resourceUri: string;
  close(): Promise<void>;
  token(subject?: string, scope?: string, clientId?: string | null): Promise<string>;
}

async function startHost(
  records: readonly ExternalIdentityRecord[],
  configOverrides: Partial<OAuthResourceServerConfig> = {},
  gameContextRepository: AuthenticatedGameContextRepository = {
    findGameAccessByUserId: () => Promise.resolve(null),
  },
  characterViewRepository: AuthenticatedCharacterViewRepository = {
    loadAuthorizedCharacterSnapshot: () => Promise.resolve(null),
  },
  gameSessionRepository: AuthenticatedGameSessionRepository = {
    select: (_userId, input) => Promise.resolve({
      status: 'REJECTED',
      previousSessionVersion: input.baseSessionVersion,
      sessionVersion: input.baseSessionVersion,
      selection: null,
      canContinue: false,
      recovery: 'SELECT_AGAIN',
      message: 'A seleção solicitada não está disponível para esta conta.',
    }),
  },
): Promise<AuthenticatedHost> {
  const app = express();
  const audits: HttpAuditRecord[] = [];
  app.use(createRequestAudit((record) => audits.push(record)));
  app.use(express.json({ limit: '100kb' }));
  app.use('/health', createHealthRouter({ check: () => Promise.resolve(true) }));
  app.use('/mcp', createChatGptAppRouter({ NODE_ENV: 'test', CHATGPT_APP_PROOF_MODE: false }, widgetAssets));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Authenticated MCP test host did not bind');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const endpoint = new URL('/mcp-auth', origin);
  const config = oauthIssuer.config(endpoint.href, configOverrides);
  const identityService = createIdentityService(repository(records));
  app.use(createProtectedResourceMetadataRouter(config));
  app.get('/authenticated-context-probe', createOAuthResourceServerAuthentication(config, identityService), (request, response) => {
    response.json({
      authorizationHeaderPresent: request.headers.authorization !== undefined,
      rawAuthorizationHeaderPresent: request.rawHeaders.some((header) => header.toLowerCase() === 'authorization'),
      auth: request.auth,
    });
  });
  app.use('/mcp-auth', createAuthenticatedMcpRouter(
    { APP_ENV: 'test', NODE_ENV: 'test' },
    config,
    identityService,
    createAuthenticatedGameContextService(gameContextRepository, {
      APP_ENV: 'test',
      NODE_ENV: 'test',
    }),
    createAuthenticatedCharacterViewService(gameContextRepository, characterViewRepository),
    widgetAssets,
    createAuthenticatedGameSessionService(gameSessionRepository),
  ));

  return {
    audits,
    endpoint,
    metadataEndpoint: new URL('/.well-known/oauth-protected-resource/mcp-auth', origin),
    rootMetadataEndpoint: new URL('/.well-known/oauth-protected-resource', origin),
    resourceUri: endpoint.href,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    }),
    token: (subject = 'active-subject', scope = 'openid', clientId = 'synthetic-client') => oauthIssuer.sign({
      audience: endpoint.href,
      clientId,
      scope,
      subject,
    }),
  };
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'authenticated-test-client', version: '0.1.0' },
    },
  };
}

function protectedRequest(token?: string, sessionId?: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify(initializeBody()),
  };
}

async function connectClient(host: AuthenticatedHost, token: string) {
  const client = new Client({ name: 'authenticated-mcp-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(host.endpoint, {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

describe('authenticated MCP resource server', () => {
  it('publishes canonical protected resource metadata without secrets or authorization-server impersonation', async () => {
    const host = await startHost([identity('active-subject')]);
    try {
      const response = await fetch(host.metadataEndpoint);
      expect(response.status).toBe(200);
      const metadata: unknown = await response.json();
      expect(metadata).toEqual({
        resource: host.resourceUri,
        authorization_servers: [oauthIssuer.issuer],
        scopes_supported: ['openid'],
        bearer_methods_supported: ['header'],
      });
      const rootResponse = await fetch(host.rootMetadataEndpoint);
      expect(rootResponse.status).toBe(200);
      expect(await rootResponse.json()).toEqual(metadata);
      expect(JSON.stringify(metadata)).not.toMatch(/secret|token|password|private/i);
      const incorrectAuthorizationMetadata = await fetch(new URL('/.well-known/oauth-authorization-server', host.endpoint));
      expect(incorrectAuthorizationMetadata.status).toBe(404);
    } finally {
      await host.close();
    }
  });

  it('returns a Bearer challenge with resource metadata for missing and malformed tokens', async () => {
    const host = await startHost([identity('active-subject')]);
    try {
      const missing = await fetch(host.endpoint, protectedRequest());
      expect(missing.status).toBe(401);
      expect(missing.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", error_description="Missing Authorization header", scope="openid", resource_metadata="${host.metadataEndpoint.href}"`,
      );
      expect(await missing.json()).toMatchObject({ error: 'invalid_token' });

      const malformed = await fetch(host.endpoint, {
        ...protectedRequest(),
        headers: {
          ...protectedRequest().headers,
          authorization: 'Basic malformed',
        },
      });
      expect(malformed.status).toBe(401);
      expect(malformed.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", error_description="Access token is invalid", scope="openid", resource_metadata="${host.metadataEndpoint.href}"`,
      );
      expect(await malformed.json()).toMatchObject({ error: 'invalid_token' });
      expect(host.audits.map((record) => record.authentication?.category)).toEqual([
        'token_missing',
        'token_malformed',
      ]);
    } finally {
      await host.close();
    }
  });

  it('applies the same absolute Bearer challenge to every protected method before MCP session handling', async () => {
    const host = await startHost([identity('active-subject')]);
    try {
      for (const method of ['GET', 'POST', 'DELETE'] as const) {
        const response = await fetch(host.endpoint, {
          method,
          ...(method === 'POST' ? protectedRequest() : {}),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('mcp-session-id')).toBeNull();
        expect(response.headers.get('www-authenticate')).toBe(
          `Bearer error="invalid_token", error_description="Missing Authorization header", scope="openid", resource_metadata="${host.metadataEndpoint.href}"`,
        );
      }
    } finally {
      await host.close();
    }
  });

  it('rejects ambiguous, oversized, non-Bearer, and query-string credentials while accepting Bearer scheme casing', async () => {
    const host = await startHost([identity('active-subject')]);
    try {
      for (const authorization of [
        '',
        'Basic opaque',
        'Bearer',
        'Bearer first second',
        'Bearer first,Bearer second',
        `Bearer ${'a'.repeat(8_193)}`,
      ]) {
        const response = await fetch(host.endpoint, {
          ...protectedRequest(),
          headers: { ...protectedRequest().headers, authorization },
        });
        expect(response.status).toBe(401);
      }

      const queryCredential = new URL(host.endpoint);
      queryCredential.searchParams.set('access_token', await host.token());
      const ignoredQueryToken = await fetch(queryCredential, protectedRequest());
      expect(ignoredQueryToken.status).toBe(401);
      expect(host.audits.at(-1)?.path).toBe('/mcp-auth');
      expect(host.audits.at(-1)?.authentication?.category).toBe('query_credential_forbidden');

      const bearerWithQueryCredential = await fetch(queryCredential, protectedRequest(await host.token()));
      expect(bearerWithQueryCredential.status).toBe(401);
      expect(host.audits.at(-1)?.authentication?.category).toBe('query_credential_forbidden');

      const lowerCaseBearer = await fetch(host.endpoint, {
        ...protectedRequest(),
        headers: {
          ...protectedRequest().headers,
          authorization: `bearer ${await host.token()}`,
        },
      });
      expect(lowerCaseBearer.status).toBe(200);
    } finally {
      await host.close();
    }
  });

  it.each([
    ['expired', 'token_expired', async (host: AuthenticatedHost) => oauthIssuer.sign({
      audience: host.resourceUri,
      expiresAt: Math.floor(Date.now() / 1_000) - 1,
      subject: 'active-subject',
    })],
    ['wrong issuer', 'issuer_invalid', async (host: AuthenticatedHost) => oauthIssuer.sign({
      audience: host.resourceUri,
      issuer: 'https://other-issuer.example.test',
      subject: 'active-subject',
    })],
    ['wrong audience', 'audience_invalid', async () => oauthIssuer.sign({
      audience: 'https://other-environment.example.test/mcp-auth',
      subject: 'active-subject',
    })],
    ['forbidden algorithm', 'algorithm_forbidden', async (host: AuthenticatedHost) => symmetricToken({
      iss: oauthIssuer.issuer,
      sub: 'active-subject',
      aud: host.resourceUri,
      exp: Math.floor(Date.now() / 1_000) + 60,
      scope: 'openid',
    })],
  ])('returns a sanitized 401 for a %s token', async (_label, category, createToken) => {
    const host = await startHost([identity('active-subject')]);
    try {
      const token = await createToken(host);
      const response = await fetch(host.endpoint, protectedRequest(token));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer error="invalid_token"');
      const body = JSON.stringify(await response.json());
      expect(body).not.toContain(token);
      expect(body).not.toContain('active-subject');
      expect(body).not.toContain(oauthIssuer.jwksUri);
      expect(host.audits.at(-1)?.authentication).toMatchObject({
        category,
        result: 'denied',
      });
    } finally {
      await host.close();
    }
  });

  it('returns 403 for insufficient scope without exposing identity data', async () => {
    const host = await startHost([identity('active-subject')]);
    try {
      const token = await host.token('active-subject', 'email');
      const response = await fetch(host.endpoint, protectedRequest(token));
      expect(response.status).toBe(403);
      expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
      expect(response.headers.get('www-authenticate')).toContain('scope="openid"');
      expect(JSON.stringify(await response.json())).not.toContain('active-subject');
      expect(host.audits.at(-1)?.authentication?.category).toBe('scope_insufficient');
    } finally {
      await host.close();
    }
  });

  it('optionally enforces the exact OAuth client without weakening audience or identity checks', async () => {
    const host = await startHost(
      [identity('active-subject')],
      { allowedClientIds: ['allowed-synthetic-client'] },
    );
    try {
      for (const clientId of ['other-client', null] as const) {
        const response = await fetch(host.endpoint, protectedRequest(
          await host.token('active-subject', 'openid', clientId),
        ));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: 'access_denied',
          error_description: 'Authenticated principal is not authorized',
        });
        expect(host.audits.at(-1)?.authentication?.category).toBe('client_not_allowed');
      }

      const allowed = await fetch(host.endpoint, protectedRequest(
        await host.token('active-subject', 'openid', 'allowed-synthetic-client'),
      ));
      expect(allowed.status).toBe(200);
    } finally {
      await host.close();
    }
  });

  it('removes the raw credential and all free JWT claims before downstream request handling', async () => {
    const host = await startHost([identity('active-subject')]);
    const token = await host.token();
    try {
      const probe = await fetch(new URL('/authenticated-context-probe', host.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(probe.status).toBe(200);
      expect(await probe.json()).toMatchObject({
        authorizationHeaderPresent: false,
        rawAuthorizationHeaderPresent: false,
        auth: {
          token: '',
          clientId: '',
          scopes: [],
          extra: {
            authenticatedMcp: {
              userStatus: 'ACTIVE',
            },
          },
        },
      });
      const serialized = JSON.stringify(await (await fetch(new URL('/authenticated-context-probe', host.endpoint), {
        headers: { authorization: `Bearer ${token}` },
      })).json());
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain('active-subject');
      expect(serialized).not.toContain('synthetic-client');
      expect(serialized).not.toContain(oauthIssuer.issuer);
    } finally {
      await host.close();
    }
  });

  it.each([
    ['identity_not_found', () => []],
    ['user_suspended', () => [identity('active-subject', UserStatus.SUSPENDED)]],
    ['user_unavailable', () => [identity('active-subject', UserStatus.DELETED)]],
    ['identity_inconsistent', () => [identity('active-subject', UserStatus.ACTIVE, { suspendedAt: new Date('2026-01-01T00:00:00.000Z') })]],
    ['identity_conflict', () => [identity('active-subject'), { ...identity('active-subject'), id: 'duplicate-external' }]],
  ] as const)('fails closed with 403 and sanitized audit category %s', async (category, createRecords) => {
    const host = await startHost(createRecords());
    try {
      const token = await host.token();
      const response = await fetch(host.endpoint, protectedRequest(token));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'access_denied',
        error_description: 'Authenticated principal is not authorized',
      });
      const record = host.audits.at(-1);
      expect(record?.authentication).toMatchObject({
        category,
        issuerDisposition: 'allowed',
        result: 'denied',
      });
      const serialized = JSON.stringify(record);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain('active-subject');
      expect(serialized).not.toContain('Authorization');
    } finally {
      await host.close();
    }
  });

  it('exposes the authenticated catalog while bootstrap performs no domain access', async () => {
    const host = await startHost([identity('active-subject')]);
    const { client, transport } = await connectClient(host, await host.token());
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(4);
      expect(tools.tools[0]).toMatchObject({
        name: GET_AUTHENTICATED_BOOTSTRAP_TOOL,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      const result = CallToolResultSchema.parse(await client.callTool({
        name: GET_AUTHENTICATED_BOOTSTRAP_TOOL,
        arguments: {},
      }));
      expect(authenticatedBootstrapSchema.parse(result.structuredContent)).toEqual({
        authenticated: true,
        userStatus: 'ACTIVE',
        environment: 'test',
        runtimeMode: 'test',
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/issuer|subject|email|userId|player|campaign|actor|narrative|claim|token/i);
      const audit = host.audits.at(-1);
      expect(audit?.authentication).toMatchObject({
        category: 'authenticated',
        result: 'allowed',
        tool: GET_AUTHENTICATED_BOOTSTRAP_TOOL,
      });
      expect(audit?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(audit?.traceId).toMatch(/^[0-9a-f-]{36}$/u);
    } finally {
      await transport.terminateSession();
      await client.close();
      await host.close();
    }
  });

  it('loads only the authorized read-only projection and serves its separate widget resource', async () => {
    const host = await startHost(
      [identity('active-subject')],
      {},
      gameAccessRepository(),
      {
        loadAuthorizedCharacterSnapshot: () => Promise.resolve(minimalCharacterSnapshot()),
      },
    );
    const { client, transport } = await connectClient(host, await host.token());
    try {
      const tools = await client.listTools();
      expect(tools.tools.find((tool) => tool.name === LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL))
        .toMatchObject({
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: {
            ui: {
              resourceUri: AUTHENTICATED_HOME_RESOURCE_URI,
            },
          },
        });
      expect(tools.tools.find((tool) => tool.name === LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL))
        .toMatchObject({
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: {
            ui: {
              resourceUri: AUTHENTICATED_HOME_RESOURCE_URI,
            },
          },
        });
      expect(tools.tools.find((tool) => tool.name === SELECT_AUTHENTICATED_GAME_CONTEXT_TOOL))
        .toMatchObject({
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          _meta: {
            ui: {
              resourceUri: AUTHENTICATED_HOME_RESOURCE_URI,
              visibility: ['app'],
            },
          },
        });
      const resources = await client.listResources();
      expect(resources.resources).toContainEqual(expect.objectContaining({
        uri: AUTHENTICATED_HOME_RESOURCE_URI,
      }));
      const resource = await client.readResource({ uri: AUTHENTICATED_HOME_RESOURCE_URI });
      expect(resource.contents[0]).toMatchObject({
        uri: AUTHENTICATED_HOME_RESOURCE_URI,
        text: '<!doctype html><title>Authenticated home</title>',
      });

      const result = CallToolResultSchema.parse(await client.callTool({
        name: LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      const context = authenticatedGameContextSchema.parse(result.structuredContent);
      expect(context).toMatchObject({
        authState: 'AUTHENTICATED',
        player: { displayName: 'OAuth Staging Tester' },
        narrativeContext: {
          campaignName: 'OAuth Readonly Test',
          characterName: 'Test Adventurer',
        },
        widgetContext: {
          banner: 'TEST — CONTEXTO AUTENTICADO',
          sessionState: 'READ_ONLY_READY',
          navigation: { canMutate: false },
        },
        environment: {
          appEnvironment: 'test',
          runtimeMode: 'test',
          syntheticAccount: false,
        },
      });
      expect(result.content).toEqual([{
        type: 'text',
        text: 'Contexto autenticado somente leitura carregado para a conta de teste.',
      }]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/userId|issuer|subject|email|token|claim|metadata|MASTER_ONLY|secret|inventory/i);
      expect(host.audits.at(-1)?.authentication).toMatchObject({
        category: 'game_context_allowed',
        result: 'allowed',
        reasonCode: 'context_loaded',
        tool: LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
      });

      const characterResult = CallToolResultSchema.parse(await client.callTool({
        name: LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL,
        arguments: {
          view: 'SUMMARY',
          campaignSelectionRef: authenticatedSelectionRef(
            'campaign',
            '00000000-0000-4000-8000-000000000001',
            'campaign-synthetic',
          ),
          characterSelectionRef: authenticatedSelectionRef(
            'character',
            '00000000-0000-4000-8000-000000000001',
            'actor-synthetic',
          ),
        },
      }));
      expect(characterResult.isError, JSON.stringify(characterResult)).not.toBe(true);
      expect(authenticatedCharacterViewSchema.parse(characterResult.structuredContent))
        .toMatchObject({
          view: 'SUMMARY',
          readOnly: true,
          data: { identity: { name: 'Test Adventurer' } },
        });
      expect(JSON.stringify(characterResult)).not.toMatch(
        /actor-synthetic|campaign-synthetic|userId|issuer|subject|token|metadata|MASTER_ONLY/i,
      );
      expect(host.audits.at(-1)?.authentication).toMatchObject({
        category: 'game_context_allowed',
        result: 'allowed',
        reasonCode: 'character_summary_loaded',
        tool: LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL,
      });
    } finally {
      await transport.terminateSession();
      await client.close();
      await host.close();
    }
  });

  it('returns a generic authorization state for a foreign opaque selection and rejects raw IDs', async () => {
    const host = await startHost(
      [identity('active-subject')],
      {},
      gameAccessRepository(),
    );
    const { client, transport } = await connectClient(host, await host.token());
    try {
      const denied = CallToolResultSchema.parse(await client.callTool({
        name: LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
        arguments: { campaignSelectionRef: `sel_${'x'.repeat(43)}` },
      }));
      expect(authenticatedGameContextSchema.parse(denied.structuredContent)).toMatchObject({
        authState: 'AUTHORIZATION_ERROR',
        player: null,
        narrativeContext: null,
        widgetContext: {
          campaigns: [],
          sessionState: 'AUTHORIZATION_ERROR',
        },
      });
      expect(JSON.stringify(denied)).not.toMatch(/campaign-synthetic|actor-synthetic|owner|membership/i);
      expect(host.audits.at(-1)?.authentication).toMatchObject({
        category: 'game_context_denied',
        result: 'denied',
        reasonCode: 'resource_unavailable',
      });

      const rawId = CallToolResultSchema.parse(await client.callTool({
        name: LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
        arguments: { campaignSelectionRef: '7b43ce60-3dca-4ab0-8fe1-33a2ca9e43ba' },
      }));
      expect(rawId.isError).toBe(true);
      expect(JSON.stringify(rawId)).not.toContain('campaign-synthetic');
    } finally {
      await transport.terminateSession();
      await client.close();
      await host.close();
    }
  });

  it('keeps selection app-only, versioned, idempotent, and mechanically non-destructive', async () => {
    const calls: Array<{ userId: string; baseSessionVersion: number; origin: string }> = [];
    const campaignSelectionRef = authenticatedSelectionRef(
      'campaign',
      '00000000-0000-4000-8000-000000000001',
      'campaign-synthetic',
    );
    const characterSelectionRef = authenticatedSelectionRef(
      'character',
      '00000000-0000-4000-8000-000000000001',
      'actor-synthetic',
    );
    const host = await startHost(
      [identity('active-subject')],
      {},
      gameAccessRepository(),
      { loadAuthorizedCharacterSnapshot: () => Promise.resolve(minimalCharacterSnapshot()) },
      {
        select: (userId, input, selectionAudit) => {
          calls.push({ userId, baseSessionVersion: input.baseSessionVersion, origin: selectionAudit.origin });
          return Promise.resolve({
            status: 'SUCCESS',
            previousSessionVersion: 0,
            sessionVersion: 1,
            selection: { campaignSelectionRef, characterSelectionRef },
            canContinue: true,
            recovery: 'NONE',
            message: 'Campanha e personagem salvos para continuar depois.',
          });
        },
      },
    );
    const { client, transport } = await connectClient(host, await host.token());
    try {
      const selected = CallToolResultSchema.parse(await client.callTool({
        name: SELECT_AUTHENTICATED_GAME_CONTEXT_TOOL,
        arguments: {
          campaignSelectionRef,
          characterSelectionRef,
          idempotencyKey: 'selection-test-001',
          baseSessionVersion: 0,
        },
      }));
      expect(authenticatedGameSessionSelectionResultSchema.parse(selected.structuredContent))
        .toMatchObject({ status: 'SUCCESS', sessionVersion: 1, canContinue: true });
      expect(calls).toEqual([{
        userId: '00000000-0000-4000-8000-000000000001',
        baseSessionVersion: 0,
        origin: 'widget',
      }]);
      expect(JSON.stringify(selected)).not.toMatch(/campaign-synthetic|actor-synthetic|userId|MASTER_ONLY/i);
    } finally {
      await transport.terminateSession();
      await client.close();
      await host.close();
    }
  });

  it('binds one identity per session, rejects a subject change, and isolates another session', async () => {
    const host = await startHost([identity('active-subject'), identity('second-subject')]);
    const first = await connectClient(host, await host.token('active-subject'));
    const second = await connectClient(host, await host.token('second-subject'));
    try {
      await first.client.listTools();
      await first.client.listTools();
      await second.client.listTools();
      expect(first.transport.sessionId).toBeDefined();
      expect(second.transport.sessionId).toBeDefined();
      expect(first.transport.sessionId).not.toBe(second.transport.sessionId);

      const changedIdentityToken = await host.token('second-subject');
      const changed = await fetch(host.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${changedIdentityToken}`,
          'content-type': 'application/json',
          'mcp-session-id': first.transport.sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} }),
      });
      expect(changed.status).toBe(403);
      expect(await changed.json()).toMatchObject({ error: { message: 'Forbidden' } });
      expect((await second.client.listTools()).tools.length).toBeGreaterThan(0);
      expect(host.audits.at(-2)?.authentication?.category).toBe('session_identity_changed');
    } finally {
      await first.client.close();
      await second.transport.terminateSession();
      await second.client.close();
      await host.close();
    }
  });

  it('revalidates token and active User state on every established-session request', async () => {
    const records = [identity('active-subject')];
    const host = await startHost(records);
    const token = await host.token();
    const { client, transport } = await connectClient(host, token);
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      const toolsListBody = JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/list', params: {} });

      const missing = await fetch(host.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
        },
        body: toolsListBody,
      });
      expect(missing.status).toBe(401);

      const expired = await fetch(host.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${await oauthIssuer.sign({
            audience: host.resourceUri,
            expiresAt: Math.floor(Date.now() / 1_000) - 60,
            scope: 'openid',
            subject: 'active-subject',
          })}`,
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
        },
        body: toolsListBody,
      });
      expect(expired.status).toBe(401);

      records[0] = identity('active-subject', UserStatus.SUSPENDED);
      const suspended = await fetch(host.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
        },
        body: toolsListBody,
      });
      expect(suspended.status).toBe(403);

      records[0] = identity('active-subject');
      expect((await client.listTools()).tools).toHaveLength(4);
    } finally {
      await transport.terminateSession();
      await client.close();
      await host.close();
    }
  });

  it('cleans a session on DELETE idempotently and keeps health and the public fixture MCP available', async () => {
    const host = await startHost([identity('active-subject')]);
    const token = await host.token();
    const { client, transport } = await connectClient(host, token);
    const publicClient = new Client({ name: 'public-fixture-test', version: '0.1.0' });
    const publicTransport = new StreamableHTTPClientTransport(new URL('/mcp', host.endpoint));
    await publicClient.connect(publicTransport as unknown as Transport);
    try {
      const sessionId = transport.sessionId;
      expect(sessionId).toBeDefined();
      await transport.terminateSession();
      const secondDelete = await fetch(host.endpoint, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${token}`,
          'mcp-session-id': sessionId ?? '',
        },
      });
      expect(secondDelete.status).toBe(200);
      expect((await fetch(new URL('/health/ready', host.endpoint))).status).toBe(200);
      expect((await publicClient.listTools()).tools.length).toBeGreaterThan(0);

      const publicSessionOnAuthenticatedEndpoint = await fetch(host.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'mcp-session-id': publicTransport.sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 93, method: 'tools/list', params: {} }),
      });
      expect(publicSessionOnAuthenticatedEndpoint.status).toBe(400);

      const authenticatedSessionOnPublicEndpoint = await fetch(new URL('/mcp', host.endpoint), {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId ?? '',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 94, method: 'tools/list', params: {} }),
      });
      expect(authenticatedSessionOnPublicEndpoint.status).toBe(400);
    } finally {
      await client.close();
      await publicTransport.terminateSession();
      await publicClient.close();
      await host.close();
    }
  });
});
