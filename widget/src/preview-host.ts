import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const foundStatusElement = document.querySelector<HTMLElement>('#preview-status');
const foundFrame = document.querySelector<HTMLIFrameElement>('#widget-frame');
if (foundStatusElement === null || foundFrame === null) throw new Error('Preview host elements are missing');
const statusElement = foundStatusElement;
const frame = foundFrame;

function setStatus(message: string, state: 'loading' | 'ready' | 'error'): void {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

async function startPreview(): Promise<void> {
  const client = new Client({
    name: 'cronicas-local-preview',
    version: '0.1.0',
  });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', window.location.origin)));

  const resource = await client.readResource({ uri: 'ui://game/home/v2.html' });
  const htmlContent = resource.contents.find((content) => 'text' in content);
  if (htmlContent === undefined || !('text' in htmlContent)) throw new Error('Widget resource did not return HTML');

  let initialResult = CallToolResultSchema.parse(await client.callTool({
    name: 'loadGameContext',
    arguments: {},
  }));

  const requestedScenario = new URLSearchParams(window.location.search).get('scenario');
  if (requestedScenario === 'without-resume') {
    initialResult = CallToolResultSchema.parse(await client.callTool({
      name: 'connectFixtureAccount',
      arguments: { scenario: 'WITHOUT_RESUME' },
    }));
  }

  const bridge = new AppBridge(
    client,
    {
      name: 'Crônicas — Host local',
      version: '0.1.0',
    },
    {
      serverTools: {},
      logging: {},
    },
    {
      hostContext: {
        theme: 'dark',
        displayMode: 'inline',
        locale: 'pt-BR',
        platform: 'web',
      },
    },
  );

  bridge.oninitialized = () => {
    void bridge.sendToolInput({ arguments: {} });
    void bridge.sendToolResult(initialResult);
    setStatus('Ciclo MCP local conectado', 'ready');
  };

  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  frame.srcdoc = htmlContent.text;
}

setStatus('Conectando ao MCP local…', 'loading');
void startPreview().catch(() => {
  setStatus('Falha ao iniciar a prova local', 'error');
});
