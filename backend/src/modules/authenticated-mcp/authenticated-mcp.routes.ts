import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig, OAuthResourceServerConfig } from '../../config/env.js';
import type { createIdentityService } from '../identity/identity.service.js';
import {
  createOAuthResourceServerAuthentication,
  readAuthenticatedMcpContext,
} from '../oauth-resource-server/oauth-resource-server.middleware.js';
import { updateAuthenticationAudit } from '../../shared/http/request-audit.js';
import {
  createAuthenticatedMcpServer,
  GET_AUTHENTICATED_BOOTSTRAP_TOOL,
} from './authenticated-mcp.server.js';

interface AuthenticatedMcpSession {
  readonly bindingFingerprint: string;
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
}

type IdentityService = ReturnType<typeof createIdentityService>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mcpError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

function findSession(
  sessions: ReadonlyMap<string, AuthenticatedMcpSession>,
  request: Request,
): AuthenticatedMcpSession | undefined {
  const sessionId = request.header('mcp-session-id');
  return sessionId === undefined ? undefined : sessions.get(sessionId);
}

function auditTool(request: Request, response: Response): void {
  const body: unknown = request.body;
  if (!isRecord(body) || body.method !== 'tools/call') return;
  const params = body.params;
  if (!isRecord(params)) return;
  if (params.name === GET_AUTHENTICATED_BOOTSTRAP_TOOL) {
    updateAuthenticationAudit(response, { tool: GET_AUTHENTICATED_BOOTSTRAP_TOOL });
  }
}

export function createAuthenticatedMcpRouter(
  environment: AppConfig['NODE_ENV'],
  config: OAuthResourceServerConfig,
  identityService: IdentityService,
) {
  const router = Router();
  const sessions = new Map<string, AuthenticatedMcpSession>();

  router.use(createOAuthResourceServerAuthentication(config, identityService));

  router.post('/', async (request, response) => {
    auditTool(request, response);
    try {
      const authenticatedContext = readAuthenticatedMcpContext(request.auth);
      if (authenticatedContext === undefined) {
        updateAuthenticationAudit(response, { category: 'context_missing', result: 'denied' });
        mcpError(response, 403, 'Forbidden');
        return;
      }

      let session = findSession(sessions, request);
      if (session !== undefined && session.bindingFingerprint !== authenticatedContext.bindingFingerprint) {
        sessions.delete(request.header('mcp-session-id') ?? '');
        updateAuthenticationAudit(response, { category: 'session_identity_changed', result: 'denied' });
        try {
          await session.transport.close();
        } finally {
          mcpError(response, 403, 'Forbidden');
        }
        return;
      }

      if (session === undefined
        && request.header('mcp-session-id') === undefined
        && isInitializeRequest(request.body)) {
        const server = createAuthenticatedMcpServer(environment);
        let sessionId: string | undefined;
        let sessionCleanedUp = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (initializedSessionId) => {
            sessionId = initializedSessionId;
            sessions.set(initializedSessionId, {
              bindingFingerprint: authenticatedContext.bindingFingerprint,
              server,
              transport,
            });
          },
        });
        transport.onclose = () => {
          if (sessionCleanedUp) return;
          sessionCleanedUp = true;
          if (sessionId !== undefined && sessions.get(sessionId)?.transport === transport) {
            sessions.delete(sessionId);
          }
        };
        await server.connect(transport as unknown as Transport);
        session = {
          bindingFingerprint: authenticatedContext.bindingFingerprint,
          server,
          transport,
        };
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
    const sessionId = request.header('mcp-session-id');
    const session = findSession(sessions, request);
    if (session === undefined) {
      if (request.method === 'DELETE' && sessionId !== undefined) {
        response.status(200).end();
        return;
      }
      mcpError(response, 400, 'Bad Request: No valid MCP session');
      return;
    }
    const authenticatedContext = readAuthenticatedMcpContext(request.auth);
    if (authenticatedContext === undefined
      || session.bindingFingerprint !== authenticatedContext.bindingFingerprint) {
      if (sessionId !== undefined) sessions.delete(sessionId);
      updateAuthenticationAudit(response, { category: 'session_identity_changed', result: 'denied' });
      try {
        await session.transport.close();
      } finally {
        mcpError(response, 403, 'Forbidden');
      }
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
