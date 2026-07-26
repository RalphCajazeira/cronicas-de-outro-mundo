import { App } from '@modelcontextprotocol/ext-apps';
import { createInitialState, reduceAppState, type AppState } from './app-state.js';
import { renderApp } from './render.js';
import {
  GameContextToolResultError,
  parseGameContextToolResult,
} from './tool-result.js';

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

function applyToolResult(input: unknown): void {
  const context = parseGameContextToolResult(input);
  delete root!.dataset.contractDiagnostic;
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

function reportSafeContractDiagnostic(error: unknown): void {
  if (!(error instanceof GameContextToolResultError) || error.diagnostics === undefined) return;
  const safeDiagnostic = {
    code: error.code,
    diagnostics: error.diagnostics,
  };
  console.error('[cronicas-widget] toolresult contract diagnostic', safeDiagnostic);
  root!.dataset.contractDiagnostic = JSON.stringify(safeDiagnostic);
  Object.defineProperty(window, '__CRONICAS_SAFE_CONTRACT_DIAGNOSTIC__', {
    configurable: true,
    enumerable: false,
    value: safeDiagnostic,
    writable: false,
  });
}

const handleToolResult = (input: unknown): void => {
  try {
    applyToolResult(input);
  } catch (error) {
    reportSafeContractDiagnostic(error);
    fail(error instanceof Error ? error.message : 'Não foi possível interpretar o contexto público.');
  }
};

const handleClick = (event: Event): void => {
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
};

app.addEventListener('toolresult', handleToolResult);
root.addEventListener('click', handleClick);

window.addEventListener('pagehide', () => {
  app.removeEventListener('toolresult', handleToolResult);
  root.removeEventListener('click', handleClick);
  void app.close();
}, { once: true });

root.innerHTML = '<div class="loading-state" role="status">Abrindo o portal…</div>';
void app.connect().catch(() => {
  fail('Não foi possível estabelecer a comunicação com o host.');
});
