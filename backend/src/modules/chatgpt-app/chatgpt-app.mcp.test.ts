import type { Server } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { FixtureGameContextGateway } from './adapters/fixture-game-context.gateway.js';
import { FixtureSessionIdentityProvider } from './auth/session-identity.js';
import {
  CONNECT_FIXTURE_ACCOUNT_TOOL,
  HOME_RESOURCE_URI,
  LEGACY_HOME_RESOURCE_URI,
  LOAD_GAME_CONTEXT_TOOL,
  PREVIOUS_HOME_RESOURCE_URI,
  createChatGptAppServer,
} from './mcp/chatgpt-app.server.js';
import { gameContextSchema } from './dto/game-context.dto.js';
import { createChatGptAppRouter } from './mcp/chatgpt-app.routes.js';
import type { WidgetAssets } from './resources/widget-assets.js';

const widgetAssets: WidgetAssets = {
  readHome: () => Promise.resolve('<!doctype html><title>Crônicas widget</title>'),
  readAuthenticatedHome: () => Promise.resolve('<!doctype html><title>Crônicas authenticated widget</title>'),
  readPreview: () => Promise.resolve('<!doctype html><title>Crônicas preview</title>'),
};

type Environment = 'development' | 'test' | 'production';

interface TestMcpHost {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
  endpoint: URL;
}

async function startMcpHost(environment: Environment, proofMode = false): Promise<TestMcpHost> {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createChatGptAppRouter({ NODE_ENV: environment, CHATGPT_APP_PROOF_MODE: proofMode }, widgetAssets));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Test server did not bind to a TCP port');

  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const client = new Client({ name: 'cronicas-mcp-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint);
  await client.connect(transport as unknown as Transport);

  return {
    client,
    transport,
    endpoint,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>) {
  return CallToolResultSchema.parse(result);
}

describe('ChatGPT App MCP proof', () => {
  it('closes a server-owned transport without recursively closing the server', async () => {
    const identityProvider = new FixtureSessionIdentityProvider('test', false);
    const server = createChatGptAppServer({
      environment: 'test',
      proofMode: true,
      identityProvider,
      fixtureConnector: identityProvider,
      gameContextGateway: new FixtureGameContextGateway('test', false),
      widgetAssets,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => 'server-initiated-close',
      enableJsonResponse: true,
    });
    let cleanupCount = 0;
    transport.onclose = () => {
      if (cleanupCount > 0) return;
      cleanupCount += 1;
    };

    await server.connect(transport as unknown as Transport);
    await server.close();
    await server.close();

    expect(cleanupCount).toBe(1);
  });

  it('terminates a Streamable HTTP session once, removes it, and keeps the host available', async () => {
    const host = await startMcpHost('test');
    const errors: Error[] = [];
    host.transport.onerror = (error) => errors.push(error);

    try {
      await host.client.listTools();
      const sessionId = host.transport.sessionId;
      expect(sessionId).toBeDefined();

      await host.transport.terminateSession();
      await host.client.close();
      await host.client.close();

      const closedSession = await fetch(host.endpoint, {
        headers: { 'mcp-session-id': sessionId ?? '' },
      });
      expect(closedSession.status).toBe(400);
      expect(errors).toEqual([]);

      const nextClient = new Client({ name: 'cronicas-mcp-test-reopened', version: '0.1.0' });
      const nextTransport = new StreamableHTTPClientTransport(host.endpoint);
      await nextClient.connect(nextTransport as unknown as Transport);
      try {
        const tools = await nextClient.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain(LOAD_GAME_CONTEXT_TOOL);
      } finally {
        await nextTransport.terminateSession();
        await nextClient.close();
      }
    } finally {
      await host.close();
    }
  });

  it('keeps another MCP session functional after a neighboring session is terminated', async () => {
    const host = await startMcpHost('test');
    const secondClient = new Client({ name: 'cronicas-mcp-test-second-session', version: '0.1.0' });
    const secondTransport = new StreamableHTTPClientTransport(host.endpoint);
    await secondClient.connect(secondTransport as unknown as Transport);

    try {
      await host.client.listTools();
      await secondClient.listTools();
      await host.transport.terminateSession();

      const resource = await secondClient.readResource({ uri: HOME_RESOURCE_URI });
      expect(resource.contents).toHaveLength(1);
      expect(secondTransport.sessionId).toBeDefined();
    } finally {
      await host.client.close();
      await secondTransport.terminateSession();
      await secondClient.close();
      await host.close();
    }
  });

  it('registers the Streamable HTTP route and keeps it independent from x-rpg-key', async () => {
    const host = await startMcpHost('test', true);
    try {
      const tools = await host.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain(LOAD_GAME_CONTEXT_TOOL);
      expect(tools.tools.find((tool) => tool.name === LOAD_GAME_CONTEXT_TOOL)?._meta).toMatchObject({
        ui: { resourceUri: HOME_RESOURCE_URI },
      });
      expect(tools.tools.find((tool) => tool.name === CONNECT_FIXTURE_ACCOUNT_TOOL)?._meta).toMatchObject({
        ui: {
          resourceUri: HOME_RESOURCE_URI,
          visibility: ['app'],
        },
      });
    } finally {
      await host.close();
    }
  });

  it('serves the MCP App UI resource with the official MIME type', async () => {
    const host = await startMcpHost('test');
    try {
      const resource = await host.client.readResource({ uri: HOME_RESOURCE_URI });
      expect(resource.contents).toHaveLength(1);
      const content = resource.contents[0];
      expect(content).toMatchObject({
        uri: HOME_RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
      });
      if (content === undefined || !('text' in content)) throw new Error('UI resource did not contain text');
      expect(content.text).toContain('Crônicas widget');
    } finally {
      await host.close();
    }
  });

  it('keeps the prior resource URI available while hosts refresh their tool metadata', async () => {
    const host = await startMcpHost('test');
    try {
      for (const uri of [PREVIOUS_HOME_RESOURCE_URI, LEGACY_HOME_RESOURCE_URI]) {
        const resource = await host.client.readResource({ uri });
        expect(resource.contents).toHaveLength(1);
        expect(resource.contents[0]).toMatchObject({
          uri,
          mimeType: 'text/html;profile=mcp-app',
        });
      }
    } finally {
      await host.close();
    }
  });

  it('returns the disconnected public allowlist without secret-shaped fields', async () => {
    const host = await startMcpHost('test');
    try {
      const result = parseResult(await host.client.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      const expectedStructuredContent = {
        authState: 'DISCONNECTED',
        player: null,
        resume: null,
        capabilities: { canStartNewGame: false, canContinue: false },
        environment: { fixtureMode: true, nonProduction: true },
      };
      expect(result).toEqual({
        content: [{ type: 'text', text: 'A conta ainda não está conectada.' }],
        structuredContent: expectedStructuredContent,
      });
      expect(result.isError).toBeUndefined();
      expect(result._meta).toBeUndefined();
      expect(gameContextSchema.safeParse(expectedStructuredContent).success).toBe(true);
      expect(gameContextSchema.safeParse({ ...expectedStructuredContent, MASTER_ONLY: 'never expose this' }).success).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/RPG_API_KEY|token|secret|password|MASTER_ONLY|GameEvent|stateVersion/i);
    } finally {
      await host.close();
    }
  });

  it('connects the server-side fixture within the same MCP session', async () => {
    const host = await startMcpHost('test');
    try {
      const connected = parseResult(await host.client.callTool({
        name: CONNECT_FIXTURE_ACCOUNT_TOOL,
        arguments: {},
      }));
      expect(connected.structuredContent).toMatchObject({
        authState: 'CONNECTED_FIXTURE',
        player: { displayName: 'Ralph, viajante de Elarion' },
        resume: {
          canContinue: true,
          characterName: 'Kael',
          campaignName: 'As Cinzas do Primeiro Sol',
        },
        capabilities: { canStartNewGame: true, canContinue: true },
      });

      const loadedAgain = parseResult(await host.client.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      expect(loadedAgain.structuredContent).toEqual(connected.structuredContent);
      expect(JSON.stringify(connected.structuredContent)).not.toMatch(
        /playerId|actorId|worldId|campaignId|uuid|hash|metadata|inventory|roll/i,
      );
      expect(gameContextSchema.safeParse(connected.structuredContent).success).toBe(true);
    } finally {
      await host.close();
    }
  });

  it('does not share fixture identity between MCP sessions', async () => {
    const first = await startMcpHost('test');
    const second = await startMcpHost('test');
    try {
      await first.client.callTool({ name: CONNECT_FIXTURE_ACCOUNT_TOOL, arguments: {} });
      const secondContext = parseResult(await second.client.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      expect(secondContext.structuredContent).toMatchObject({ authState: 'DISCONNECTED' });
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('supports a connected fixture with no resumable campaign', async () => {
    const host = await startMcpHost('test');
    try {
      const result = parseResult(await host.client.callTool({
        name: CONNECT_FIXTURE_ACCOUNT_TOOL,
        arguments: { scenario: 'WITHOUT_RESUME' },
      }));
      expect(result.structuredContent).toMatchObject({
        authState: 'CONNECTED_FIXTURE',
        resume: null,
        capabilities: { canContinue: false, canStartNewGame: true },
      });
    } finally {
      await host.close();
    }
  });

  it('rejects playerId and other unsupported client identity selectors', async () => {
    const host = await startMcpHost('test');
    try {
      const loadResult = parseResult(await host.client.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: { playerId: 'attacker-selected-player' },
      }));
      const connectResult = parseResult(await host.client.callTool({
        name: CONNECT_FIXTURE_ACCOUNT_TOOL,
        arguments: { playerId: 'attacker-selected-player' },
      }));
      expect(loadResult.isError).toBe(true);
      expect(connectResult.isError).toBe(true);
      expect(loadResult.structuredContent).toBeUndefined();
      expect(connectResult.structuredContent).toBeUndefined();
      expect(JSON.stringify([loadResult, connectResult])).not.toContain('attacker-selected-player');
    } finally {
      await host.close();
    }
  });

  it('fails closed in production and does not register the fixture connection tool', async () => {
    expect(() => new FixtureSessionIdentityProvider('production', false)).toThrow('unavailable in production');
    expect(() => new FixtureGameContextGateway('production', false)).toThrow('unavailable in production');

    const host = await startMcpHost('production');
    try {
      const tools = await host.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([LOAD_GAME_CONTEXT_TOOL]);
      const result = parseResult(await host.client.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      expect(result.structuredContent).toMatchObject({
        authState: 'DISCONNECTED',
        environment: { fixtureMode: false, nonProduction: false },
      });
    } finally {
      await host.close();
    }
  });

  it('enables only the non-persistent fixture in production when proof mode is explicit', async () => {
    const host = await startMcpHost('production', true);
    try {
      const tools = await host.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        LOAD_GAME_CONTEXT_TOOL,
        CONNECT_FIXTURE_ACCOUNT_TOOL,
      ]);
      const connected = parseResult(await host.client.callTool({
        name: CONNECT_FIXTURE_ACCOUNT_TOOL,
        arguments: {},
      }));
      expect(connected.structuredContent).toMatchObject({
        authState: 'CONNECTED_FIXTURE',
        environment: { fixtureMode: true, nonProduction: false },
      });
    } finally {
      await host.close();
    }
  });
});
