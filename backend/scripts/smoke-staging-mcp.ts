import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  CONNECT_FIXTURE_ACCOUNT_TOOL,
  HOME_RESOURCE_URI,
  LOAD_GAME_CONTEXT_TOOL,
} from '../src/modules/chatgpt-app/mcp/chatgpt-app.server.js';
import { gameContextSchema } from '../src/modules/chatgpt-app/dto/game-context.dto.js';

class SafeSmokeError extends Error {}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new SafeSmokeError(`Required staging setting is missing: ${name}`);
  return value;
}

export function stagingEndpoint(baseValue: string, allowLocal = false): URL {
  let base: URL;
  try {
    base = new URL(baseValue);
  } catch {
    throw new SafeSmokeError('Staging base URL is invalid');
  }
  const isRender = base.protocol === 'https:' && base.hostname.endsWith('.onrender.com');
  const isAllowedLocal = allowLocal
    && base.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(base.hostname);
  if (base.username !== '' || base.password !== '' || (!isRender && !isAllowedLocal)) {
    throw new SafeSmokeError('Staging MCP host is outside the public Render allowlist');
  }
  return new URL('/mcp', base);
}

async function assertUnavailable(url: URL): Promise<void> {
  const response = await fetch(url, { redirect: 'error' });
  if (response.status !== 404) throw new SafeSmokeError(`Expected OAuth-disabled endpoint to return 404: ${url.pathname}`);
}

function safeGameContext(value: unknown) {
  const parsed = gameContextSchema.parse(value);
  const serialized = JSON.stringify(parsed);
  if (/RPG_API_KEY|accessToken|refreshToken|authorizationCode|clientSecret|password|MASTER_ONLY|GameEvent|stateVersion/iu.test(serialized)) {
    throw new SafeSmokeError('Fixture response contains a forbidden field shape');
  }
  return parsed;
}

export async function runStagingMcpSmoke(
  baseValue: string,
  expectedResource: string,
  allowLocal = false,
): Promise<{ toolCount: number; resourceCount: number }> {
  const endpoint = stagingEndpoint(baseValue, allowLocal);
  if (expectedResource !== HOME_RESOURCE_URI) throw new SafeSmokeError('Staging MCP resource URI does not match the committed contract');

  const client = new Client({ name: 'cronicas-staging-smoke', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint);
  let firstSessionTerminated = false;
  await client.connect(transport as unknown as Transport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    if (!toolNames.includes(LOAD_GAME_CONTEXT_TOOL) || !toolNames.includes(CONNECT_FIXTURE_ACCOUNT_TOOL)) {
      throw new SafeSmokeError('Staging MCP tools do not match the fixture contract');
    }

    const resources = await client.listResources();
    const resourceUris = resources.resources.map((resource) => resource.uri);
    if (!resourceUris.includes(expectedResource)) throw new SafeSmokeError('Staging MCP resource is unavailable');
    const resource = await client.readResource({ uri: expectedResource });
    const home = resource.contents[0];
    if (
      resource.contents.length !== 1
      || home === undefined
      || home.mimeType !== 'text/html;profile=mcp-app'
      || !('text' in home)
      || typeof home.text !== 'string'
      || home.text.length === 0
    ) {
      throw new SafeSmokeError('Staging MCP resource contract is invalid');
    }

    const disconnected = CallToolResultSchema.parse(await client.callTool({
      name: LOAD_GAME_CONTEXT_TOOL,
      arguments: {},
    }));
    const disconnectedContext = safeGameContext(disconnected.structuredContent);
    if (disconnectedContext.authState !== 'DISCONNECTED' || !disconnectedContext.environment.fixtureMode) {
      throw new SafeSmokeError('Public staging fixture did not start disconnected');
    }

    const connected = CallToolResultSchema.parse(await client.callTool({
      name: CONNECT_FIXTURE_ACCOUNT_TOOL,
      arguments: { scenario: 'WITH_RESUME' },
    }));
    const connectedContext = safeGameContext(connected.structuredContent);
    if (
      connectedContext.authState !== 'CONNECTED_FIXTURE'
      || !connectedContext.environment.fixtureMode
      || connectedContext.environment.nonProduction
      || connectedContext.resume?.canContinue !== true
    ) {
      throw new SafeSmokeError('Public staging fixture did not return the isolated resume scenario');
    }

    const loadedAgain = CallToolResultSchema.parse(await client.callTool({
      name: LOAD_GAME_CONTEXT_TOOL,
      arguments: {},
    }));
    if (JSON.stringify(safeGameContext(loadedAgain.structuredContent)) !== JSON.stringify(connectedContext)) {
      throw new SafeSmokeError('Public staging fixture was not stable within the MCP session');
    }

    if (transport.sessionId === undefined) {
      throw new SafeSmokeError('Staging MCP transport did not establish a session');
    }
    await transport.terminateSession();
    firstSessionTerminated = true;
    await client.close();

    const freshClient = new Client({ name: 'cronicas-staging-smoke-fresh-session', version: '0.1.0' });
    const freshTransport = new StreamableHTTPClientTransport(endpoint);
    await freshClient.connect(freshTransport as unknown as Transport);
    try {
      const freshLoad = CallToolResultSchema.parse(await freshClient.callTool({
        name: LOAD_GAME_CONTEXT_TOOL,
        arguments: {},
      }));
      const freshContext = safeGameContext(freshLoad.structuredContent);
      if (freshContext.authState !== 'DISCONNECTED' || !freshContext.environment.fixtureMode) {
        throw new SafeSmokeError('A new staging MCP session did not start disconnected');
      }
    } finally {
      if (freshTransport.sessionId !== undefined) {
        await freshTransport.terminateSession().catch(() => undefined);
      }
      await freshClient.close().catch(() => undefined);
    }

    const base = new URL(endpoint.origin);
    await Promise.all([
      assertUnavailable(new URL('/mcp-auth', base)),
      assertUnavailable(new URL('/.well-known/oauth-protected-resource', base)),
      assertUnavailable(new URL('/.well-known/oauth-protected-resource/mcp-auth', base)),
      assertUnavailable(new URL('/.well-known/oauth-authorization-server', base)),
    ]);

    console.info(`Staging MCP smoke passed with ${toolNames.length} tools and ${resourceUris.length} resources`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined) {
      appendFileSync(summary, [
        '## MCP staging smoke',
        '',
        '- Initialize: passed',
        `- Tools listed: ${toolNames.length}`,
        `- Resources listed: ${resourceUris.length}`,
        '- Fixture connect/load: passed',
        '- Fixture isolation: passed',
        '- Session DELETE and fresh disconnected session: passed',
        '- `/mcp-auth`: 404',
        '- OAuth metadata: unavailable',
        '',
      ].join('\n'));
    }
    return { toolCount: toolNames.length, resourceCount: resourceUris.length };
  } finally {
    if (!firstSessionTerminated && transport.sessionId !== undefined) {
      await transport.terminateSession().catch(() => undefined);
    }
    await client.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const allowLocal = process.env.STAGING_SMOKE_ALLOW_LOCAL === 'true' && process.env.NODE_ENV !== 'production';
  await runStagingMcpSmoke(
    requiredEnvironment('STAGING_BASE_URL'),
    requiredEnvironment('STAGING_MCP_RESOURCE_URI'),
    allowLocal,
  );
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof SafeSmokeError ? error.message : 'Staging MCP smoke failed safely');
    process.exitCode = 1;
  });
}
