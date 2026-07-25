import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig } from '../../../config/env.js';
import {
  DisconnectedSessionIdentityProvider,
  FixtureSessionIdentityProvider,
} from '../auth/session-identity.js';
import { FixtureGameContextGateway } from '../adapters/fixture-game-context.gateway.js';
import type { WidgetAssets } from '../resources/widget-assets.js';
import { createChatGptAppServer } from './chatgpt-app.server.js';

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function mcpError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

export function createChatGptAppRouter(
  config: Pick<AppConfig, 'NODE_ENV' | 'CHATGPT_APP_PROOF_MODE'>,
  widgetAssets: WidgetAssets,
) {
  const router = Router();
  const sessions = new Map<string, McpSession>();

  function findSession(request: Request): McpSession | undefined {
    const sessionId = request.header('mcp-session-id');
    return sessionId === undefined ? undefined : sessions.get(sessionId);
  }

  router.post('/', async (request, response) => {
    try {
      let session = findSession(request);

      if (session === undefined && request.header('mcp-session-id') === undefined && isInitializeRequest(request.body)) {
        const fixtureMode = config.NODE_ENV !== 'production' || config.CHATGPT_APP_PROOF_MODE;
        const identityProvider = fixtureMode
          ? new FixtureSessionIdentityProvider(config.NODE_ENV, config.CHATGPT_APP_PROOF_MODE)
          : new DisconnectedSessionIdentityProvider();
        const gameContextGateway = fixtureMode
          ? new FixtureGameContextGateway(config.NODE_ENV, config.CHATGPT_APP_PROOF_MODE)
          : undefined;

        const server = createChatGptAppServer({
          environment: config.NODE_ENV,
          proofMode: fixtureMode,
          identityProvider,
          ...(identityProvider instanceof FixtureSessionIdentityProvider
            ? { fixtureConnector: identityProvider }
            : {}),
          ...(gameContextGateway === undefined ? {} : { gameContextGateway }),
          widgetAssets,
        });

        let sessionId: string | undefined;
        let sessionCleanedUp = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId) => {
            sessionId = initializedSessionId;
            sessions.set(initializedSessionId, { server, transport });
          },
        });
        transport.onclose = () => {
          if (sessionCleanedUp) return;
          sessionCleanedUp = true;
          if (sessionId !== undefined && sessions.get(sessionId)?.transport === transport) {
            sessions.delete(sessionId);
          }
        };
        // The SDK's transport declarations do not currently model exactOptionalPropertyTypes.
        await server.connect(transport as unknown as Transport);
        session = { server, transport };
      }

      if (session === undefined) {
        mcpError(response, 400, 'Bad Request: No valid MCP session');
        return;
      }

      await session.transport.handleRequest(request, response, request.body);
    } catch {
      if (!response.headersSent) mcpError(response, 500, 'Internal MCP server error');
    }
  });

  const handleEstablishedSession = async (request: Request, response: Response) => {
    const session = findSession(request);
    if (session === undefined) {
      mcpError(response, 400, 'Bad Request: No valid MCP session');
      return;
    }
    try {
      await session.transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) mcpError(response, 500, 'Internal MCP server error');
    }
  };

  router.get('/', handleEstablishedSession);
  router.delete('/', handleEstablishedSession);

  return router;
}
