import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import type { AppConfig } from '../../../config/env.js';
import type { GameContextGateway } from '../adapters/game-context.gateway.js';
import type {
  FixtureScenario,
  FixtureSessionConnector,
  SessionIdentityProvider,
} from '../auth/session-identity.js';
import {
  disconnectedGameContext,
  gameContextSchema,
  type GameContextDto,
} from '../dto/game-context.dto.js';
import type { WidgetAssets } from '../resources/widget-assets.js';

// v3 intentionally invalidates hosts that cache an earlier inline widget bundle by URI.
export const HOME_RESOURCE_URI = 'ui://game/home/v3.html';
export const PREVIOUS_HOME_RESOURCE_URI = 'ui://game/home/v2.html';
export const LEGACY_HOME_RESOURCE_URI = 'ui://game/home/v1.html';
export const LOAD_GAME_CONTEXT_TOOL = 'loadGameContext';
export const CONNECT_FIXTURE_ACCOUNT_TOOL = 'connectFixtureAccount';

interface ChatGptAppServerDependencies {
  environment: AppConfig['NODE_ENV'];
  proofMode: boolean;
  identityProvider: SessionIdentityProvider;
  fixtureConnector?: FixtureSessionConnector;
  gameContextGateway?: GameContextGateway;
  widgetAssets: WidgetAssets;
}

function toolResult(context: GameContextDto) {
  const summary = context.authState === 'DISCONNECTED'
    ? 'A conta ainda não está conectada.'
    : context.capabilities.canContinue
      ? 'Contexto de demonstração carregado com uma campanha retomável.'
      : 'Contexto de demonstração carregado sem campanha retomável.';

  return {
    structuredContent: gameContextSchema.parse(context),
    content: [{ type: 'text' as const, text: summary }],
  };
}

export function createChatGptAppServer(dependencies: ChatGptAppServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: 'cronicas-de-outro-mundo',
      version: '0.1.0',
    },
    {
      instructions: 'Load the public game context before showing the Crônicas de Outro Mundo home interface.',
    },
  );

  registerAppTool(
    server,
    LOAD_GAME_CONTEXT_TOOL,
    {
      title: 'Carregar contexto do jogo',
      description: 'Carrega somente o contexto público autorizado para a tela inicial do jogo.',
      inputSchema: z.object({}).strict(),
      outputSchema: gameContextSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: {
          resourceUri: HOME_RESOURCE_URI,
          visibility: ['model', 'app'],
        },
      },
    },
    async () => {
      const identity = await dependencies.identityProvider.getIdentity();
      if (identity === null) {
        return toolResult(disconnectedGameContext(
          dependencies.proofMode,
          dependencies.environment !== 'production',
        ));
      }
      if (dependencies.gameContextGateway === undefined) {
        throw new Error('Authenticated game context gateway is unavailable');
      }
      return toolResult(await dependencies.gameContextGateway.loadGameContext(identity));
    },
  );

  if (
    dependencies.proofMode
    && dependencies.fixtureConnector !== undefined
    && dependencies.gameContextGateway !== undefined
  ) {
    registerAppTool(
      server,
      CONNECT_FIXTURE_ACCOUNT_TOOL,
      {
        title: 'Conectar conta de demonstração',
        description: 'Conecta a identidade fixture da sessão local. Disponível apenas em desenvolvimento e testes.',
        inputSchema: z.object({
          scenario: z.enum(['WITH_RESUME', 'WITHOUT_RESUME']).default('WITH_RESUME'),
        }).strict(),
        outputSchema: gameContextSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          ui: {
            resourceUri: HOME_RESOURCE_URI,
            visibility: ['app'],
          },
        },
      },
      async ({ scenario }: { scenario: FixtureScenario }) => {
        const identity = await dependencies.fixtureConnector!.connectFixture(scenario);
        return toolResult(await dependencies.gameContextGateway!.loadGameContext(identity));
      },
    );
  }

  const registerHomeResource = (name: string, uri: string): void => {
    registerAppResource(
      server,
      name,
      uri,
      {
        description: 'Interface inicial do jogo.',
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
          uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: await dependencies.widgetAssets.readHome(),
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
  };

  registerHomeResource('Crônicas de Outro Mundo — Início', HOME_RESOURCE_URI);
  registerHomeResource('Crônicas de Outro Mundo — Início (compatibilidade v2)', PREVIOUS_HOME_RESOURCE_URI);
  registerHomeResource('Crônicas de Outro Mundo — Início (compatibilidade v1)', LEGACY_HOME_RESOURCE_URI);

  return server;
}
