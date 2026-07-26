import { App } from '@modelcontextprotocol/ext-apps';
import type { AuthenticatedContext } from './authenticated-context.js';
import {
  renderAuthenticatedContext,
  renderAuthenticatedFailure,
} from './authenticated-render.js';
import { parseAuthenticatedToolResult } from './authenticated-tool-result.js';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('Authenticated widget root not found');

const app = new App(
  {
    name: 'Crônicas de Outro Mundo — Contexto autenticado',
    version: '0.1.0',
  },
  {},
  { autoResize: true, strict: true },
);

let context: AuthenticatedContext | null = null;

function applyResult(input: unknown): void {
  context = parseAuthenticatedToolResult(input);
  root!.innerHTML = renderAuthenticatedContext(context);
}

function fail(): void {
  root!.innerHTML = renderAuthenticatedFailure(
    'A sessão autenticada não está disponível. Nenhum dado do jogo foi alterado.',
  );
}

function loadSelection(argumentsValue: Record<string, string>): void {
  void app.callServerTool({
    name: 'loadAuthenticatedGameContext',
    arguments: argumentsValue,
  }).then(applyResult).catch(fail);
}

const handleClick = (event: Event): void => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
  if (target === null) return;
  if (target.dataset.action === 'reconnect') {
    window.location.reload();
    return;
  }
  const campaignSelectionRef = target.dataset.campaignSelectionRef;
  const characterSelectionRef = target.dataset.characterSelectionRef;
  if (characterSelectionRef !== undefined && campaignSelectionRef !== undefined) {
    loadSelection({ campaignSelectionRef, characterSelectionRef });
    return;
  }
  if (campaignSelectionRef !== undefined) loadSelection({ campaignSelectionRef });
};

app.addEventListener('toolresult', applyResult);
root.addEventListener('click', handleClick);
window.addEventListener('pagehide', () => {
  app.removeEventListener('toolresult', applyResult);
  root.removeEventListener('click', handleClick);
  void app.close();
}, { once: true });

root.innerHTML = '<div class="loading-state" role="status">Carregando contexto autorizado…</div>';
void app.connect().catch(fail);
