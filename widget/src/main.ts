import { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createInitialState, reduceAppState, type AppState } from './app-state.js';
import { renderApp } from './render.js';
import { parseGameContextToolResult } from './tool-result.js';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('Widget root not found');

const app = new App(
  {
    name: 'Crônicas de Outro Mundo',
    version: '0.1.0',
  },
  {},
  { autoResize: true, strict: true },
);

let state: AppState | null = null;

function paint(): void {
  if (state !== null) root!.innerHTML = renderApp(state);
}

function applyToolResult(result: CallToolResult): void {
  const context = parseGameContextToolResult(result);
  state = state === null
    ? createInitialState(context)
    : reduceAppState(state, { type: 'APPLY_CONTEXT', context });
  paint();
}

function fail(message: string): void {
  if (state === null) {
    root!.innerHTML = `<div class="startup-error" role="alert">${message}</div>`;
    return;
  }
  state = reduceAppState(state, { type: 'FAIL', message });
  paint();
}

app.addEventListener('toolresult', (result) => {
  try {
    applyToolResult(result);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Não foi possível interpretar o contexto público.');
  }
});

root.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
  if (target === null || state === null) return;

  const action = target.dataset.action;
  if (action === 'back') {
    state = reduceAppState(state, { type: 'BACK_HOME' });
    paint();
    return;
  }
  if (action === 'continue') {
    state = reduceAppState(state, { type: 'OPEN_CONTINUE' });
    paint();
    return;
  }
  if (action === 'new-game') {
    state = reduceAppState(state, { type: 'OPEN_NEW_GAME' });
    paint();
    return;
  }
  if (action === 'connect') {
    target.disabled = true;
    target.setAttribute('aria-busy', 'true');
    void app.callServerTool({
      name: 'connectFixtureAccount',
      arguments: {},
    }).then((result) => {
      applyToolResult(result);
    }).catch(() => {
      fail('A conexão de demonstração não está disponível neste ambiente.');
    });
  }
});

root.innerHTML = '<div class="loading-state" role="status">Abrindo o portal…</div>';
void app.connect().catch(() => {
  fail('Não foi possível estabelecer a comunicação com o host.');
});
