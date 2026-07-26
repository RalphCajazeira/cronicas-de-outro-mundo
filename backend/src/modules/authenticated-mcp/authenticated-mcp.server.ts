import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import {
  authenticatedGameContextSchema,
  authorizationErrorContext,
  loadAuthenticatedGameContextInputSchema,
} from '../authenticated-game-context/authenticated-game-context.dto.js';
import { AuthenticatedGameContextAccessError } from '../authenticated-game-context/authenticated-game-context.errors.js';
import type { createAuthenticatedGameContextService } from '../authenticated-game-context/authenticated-game-context.service.js';
import {
  authenticatedCharacterViewToolOutputSchema,
  loadAuthenticatedCharacterViewInputSchema,
} from '../authenticated-character-view/authenticated-character-view.dto.js';
import type { createAuthenticatedCharacterViewService } from '../authenticated-character-view/authenticated-character-view.service.js';
import type { WidgetAssets } from '../chatgpt-app/resources/widget-assets.js';
import { readAuthenticatedMcpContext } from '../oauth-resource-server/oauth-resource-server.middleware.js';

export const GET_AUTHENTICATED_BOOTSTRAP_TOOL = 'getAuthenticatedBootstrap';
export const LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL = 'loadAuthenticatedGameContext';
export const LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL = 'loadAuthenticatedCharacterView';
export const AUTHENTICATED_HOME_RESOURCE_URI = 'ui://game/authenticated-home/v3.html';

export const authenticatedBootstrapSchema = z.object({
  authenticated: z.literal(true),
  userStatus: z.literal('ACTIVE'),
  environment: z.enum(['local', 'test', 'staging', 'production']),
  runtimeMode: z.enum(['development', 'test', 'production']),
}).strict();

type AuthenticatedGameContextService = ReturnType<typeof createAuthenticatedGameContextService>;
type AuthenticatedCharacterViewService = ReturnType<typeof createAuthenticatedCharacterViewService>;

export function createAuthenticatedMcpServer(
  config: Pick<AppConfig, 'APP_ENV' | 'NODE_ENV'>,
  gameContextService: AuthenticatedGameContextService,
  characterViewService: AuthenticatedCharacterViewService,
  widgetAssets: WidgetAssets,
): McpServer {
  const server = new McpServer(
    {
      name: 'cronicas-de-outro-mundo-authenticated',
      version: '0.1.0',
    },
    {
      instructions: 'Use only authenticated, read-only tools. Load the authorized game context before showing the authenticated home interface.',
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
        environment: config.APP_ENV,
        runtimeMode: config.NODE_ENV,
      });
      return {
        structuredContent: bootstrap,
        content: [{ type: 'text' as const, text: 'Authenticated bootstrap is available.' }],
      };
    },
  );

  registerAppTool(
    server,
    LOAD_AUTHENTICATED_GAME_CONTEXT_TOOL,
    {
      title: 'Carregar contexto autenticado',
      description: 'Carrega somente campanhas e personagens autorizados para a conta conectada, sem alterar o jogo.',
      inputSchema: loadAuthenticatedGameContextInputSchema,
      outputSchema: authenticatedGameContextSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: AUTHENTICATED_HOME_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async (input, extra) => {
      const authenticatedContext = readAuthenticatedMcpContext(extra.authInfo);
      if (authenticatedContext === undefined || authenticatedContext.userStatus !== 'ACTIVE') {
        throw new Error('Authenticated MCP context is unavailable');
      }
      const resourceFingerprint = input.characterSelectionRef?.slice(4, 16)
        ?? input.campaignSelectionRef?.slice(4, 16);
      try {
        const context = await gameContextService.load(authenticatedContext.userId, input);
        authenticatedContext.recordAuthorizationDecision({
          result: 'allowed',
          reasonCode: 'context_loaded',
          ...(resourceFingerprint === undefined ? {} : { resourceFingerprint }),
        });
        return {
          structuredContent: context,
          content: [{
            type: 'text' as const,
            text: 'Contexto autenticado somente leitura carregado para a conta de teste.',
          }],
        };
      } catch (error) {
        if (!(error instanceof AuthenticatedGameContextAccessError)) throw error;
        authenticatedContext.recordAuthorizationDecision({
          result: 'denied',
          reasonCode: error.reasonCode,
          ...(resourceFingerprint === undefined ? {} : { resourceFingerprint }),
        });
        return {
          structuredContent: authorizationErrorContext(config.APP_ENV, config.NODE_ENV),
          content: [{
            type: 'text' as const,
            text: 'O contexto solicitado não está disponível para esta conta.',
          }],
        };
      }
    },
  );

  registerAppTool(
    server,
    LOAD_AUTHENTICATED_CHARACTER_VIEW_TOOL,
    {
      title: 'Consultar personagem autenticado',
      description: 'Carrega uma seção autorizada e somente leitura da ficha do personagem conectado.',
      inputSchema: loadAuthenticatedCharacterViewInputSchema,
      outputSchema: authenticatedCharacterViewToolOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: AUTHENTICATED_HOME_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async (input, extra) => {
      const authenticatedContext = readAuthenticatedMcpContext(extra.authInfo);
      if (authenticatedContext === undefined || authenticatedContext.userStatus !== 'ACTIVE') {
        throw new Error('Authenticated MCP context is unavailable');
      }
      const resourceFingerprint = input.characterSelectionRef?.slice(4, 16)
        ?? input.campaignSelectionRef?.slice(4, 16);
      try {
        const view = await characterViewService.load(authenticatedContext.userId, input);
        authenticatedContext.recordAuthorizationDecision({
          result: 'allowed',
          reasonCode: `character_${input.view.toLowerCase()}_loaded`,
          ...(resourceFingerprint === undefined ? {} : { resourceFingerprint }),
        });
        return {
          structuredContent: view,
          content: [{
            type: 'text' as const,
            text: `Seção ${input.view.toLowerCase()} carregada em modo somente leitura.`,
          }],
        };
      } catch (error) {
        if (!(error instanceof AuthenticatedGameContextAccessError)) throw error;
        authenticatedContext.recordAuthorizationDecision({
          result: 'denied',
          reasonCode: error.reasonCode,
          ...(resourceFingerprint === undefined ? {} : { resourceFingerprint }),
        });
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: 'Esta seção do personagem não está disponível para a conta conectada.',
          }],
        };
      }
    },
  );

  registerAppResource(
    server,
    'Crônicas de Outro Mundo — Personagem autenticado',
    AUTHENTICATED_HOME_RESOURCE_URI,
    {
      description: 'Interface autenticada v2 somente leitura do jogador e de seu personagem.',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
      },
    },
    async () => ({
      contents: [{
        uri: AUTHENTICATED_HOME_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: await widgetAssets.readAuthenticatedHome(),
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: [],
            },
          },
        },
      }],
    }),
  );

  return server;
}
