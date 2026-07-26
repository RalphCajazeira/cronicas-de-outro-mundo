import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import { readAuthenticatedMcpContext } from '../oauth-resource-server/oauth-resource-server.middleware.js';

export const GET_AUTHENTICATED_BOOTSTRAP_TOOL = 'getAuthenticatedBootstrap';

export const authenticatedBootstrapSchema = z.object({
  authenticated: z.literal(true),
  userStatus: z.literal('ACTIVE'),
  environment: z.enum(['development', 'test', 'production']),
}).strict();

export function createAuthenticatedMcpServer(environment: AppConfig['NODE_ENV']): McpServer {
  const server = new McpServer(
    {
      name: 'cronicas-de-outro-mundo-authenticated',
      version: '0.1.0',
    },
    {
      instructions: 'Use only authenticated, read-only tools exposed by this server.',
    },
  );

  server.registerTool(
    GET_AUTHENTICATED_BOOTSTRAP_TOOL,
    {
      title: 'Confirmar sessão autenticada',
      description: 'Confirma somente que a identidade externa corresponde a um usuário interno ativo.',
      inputSchema: z.object({}).strict(),
      outputSchema: authenticatedBootstrapSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (_input, extra) => {
      const authenticatedContext = readAuthenticatedMcpContext(extra.authInfo);
      if (authenticatedContext === undefined || authenticatedContext.userStatus !== 'ACTIVE') {
        throw new Error('Authenticated MCP context is unavailable');
      }
      const bootstrap = authenticatedBootstrapSchema.parse({
        authenticated: true,
        userStatus: authenticatedContext.userStatus,
        environment,
      });
      return {
        structuredContent: bootstrap,
        content: [{ type: 'text' as const, text: 'Authenticated bootstrap is available.' }],
      };
    },
  );

  return server;
}
