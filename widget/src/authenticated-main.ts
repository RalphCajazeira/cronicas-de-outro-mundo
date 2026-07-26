import { App } from '@modelcontextprotocol/ext-apps';
import type { AuthenticatedContext } from './authenticated-context.js';
import type {
  AuthenticatedCharacterView,
  AuthenticatedViewName,
} from './authenticated-character-view.js';
import {
  renderAuthenticatedContext,
  renderAuthenticatedFailure,
} from './authenticated-render.js';
import {
  parseAuthenticatedCharacterViewResult,
  parseAuthenticatedToolResult,
} from './authenticated-tool-result.js';
import { normalizeToolResultEvent } from './tool-result.js';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('Authenticated widget root not found');

const app = new App(
  {
    name: 'Crônicas de Outro Mundo — Personagem autenticado',
    version: '0.2.0',
  },
  {},
  { autoResize: true, strict: true },
);

const orderedViews: readonly AuthenticatedViewName[] = [
  'SUMMARY',
  'SHEET',
  'INVENTORY',
  'EQUIPMENT',
  'ABILITIES',
];

let context: AuthenticatedContext | null = null;
let activeView: AuthenticatedViewName = 'SUMMARY';
let views: Partial<Record<AuthenticatedViewName, AuthenticatedCharacterView>> = {};
let loading = false;
let errorMessage: string | null = null;
let selectedDetail: string | null = null;
let currentCharacterRef: string | null = null;
let lastViewArguments: Record<string, string> | null = null;

function render(): void {
  if (context === null) return;
  root!.innerHTML = renderAuthenticatedContext(context, {
    activeView,
    view: views[activeView] ?? null,
    loading,
    error: errorMessage,
    selectedDetail,
  });
}

function selectedRefs(): { campaignSelectionRef: string; characterSelectionRef: string } | null {
  const active = context?.widgetContext.activeContext;
  if (active?.character === null || active?.character === undefined) return null;
  return {
    campaignSelectionRef: active.campaign.selectionRef,
    characterSelectionRef: active.character.selectionRef,
  };
}

function mergePage(
  previous: AuthenticatedCharacterView | undefined,
  next: AuthenticatedCharacterView,
  requestedCursor: string | undefined,
): AuthenticatedCharacterView {
  if (requestedCursor === undefined || previous === undefined || previous.view !== next.view) return next;
  if (previous.view === 'INVENTORY' && next.view === 'INVENTORY') {
    return {
      ...next,
      data: {
        ...next.data,
        items: [...previous.data.items, ...next.data.items],
      },
    };
  }
  if (previous.view === 'ABILITIES' && next.view === 'ABILITIES') {
    return {
      ...next,
      data: {
        ...next.data,
        abilities: [...previous.data.abilities, ...next.data.abilities],
      },
    };
  }
  return next;
}

function applyResult(input: unknown): void {
  try {
    const normalized = normalizeToolResultEvent(input);
    const structured = normalized.structuredContent;
    const isCharacterView = typeof structured === 'object'
      && structured !== null
      && 'view' in structured;
    if (isCharacterView) {
      const view = parseAuthenticatedCharacterViewResult(input);
      const requestedCursor = lastViewArguments?.view === view.view
        ? lastViewArguments.cursor
        : undefined;
      views[view.view] = mergePage(views[view.view], view, requestedCursor);
      lastViewArguments = null;
      activeView = view.view;
      loading = false;
      errorMessage = null;
      selectedDetail = null;
      render();
      return;
    }

    const nextContext = parseAuthenticatedToolResult(input);
    const nextCharacterRef = nextContext.widgetContext.activeContext?.character?.selectionRef ?? null;
    if (nextCharacterRef !== currentCharacterRef) {
      views = {};
      activeView = 'SUMMARY';
      selectedDetail = null;
      currentCharacterRef = nextCharacterRef;
    }
    context = nextContext;
    loading = false;
    errorMessage = null;
    render();
    if (nextCharacterRef !== null && views.SUMMARY === undefined) loadView('SUMMARY');
  } catch {
    if (context === null) {
      root!.innerHTML = renderAuthenticatedFailure(
        'A sessão autenticada não está disponível. Nenhum dado do jogo foi alterado.',
      );
      return;
    }
    loading = false;
    errorMessage = 'Não foi possível carregar esta seção. Nenhum dado do jogo foi alterado.';
    render();
  }
}

function loadContext(argumentsValue: Record<string, string>): void {
  loading = true;
  errorMessage = null;
  render();
  void app.callServerTool({
    name: 'loadAuthenticatedGameContext',
    arguments: argumentsValue,
  }).then(applyResult).catch(() => {
    loading = false;
    errorMessage = 'Não foi possível atualizar o contexto autorizado.';
    render();
  });
}

function loadView(view: AuthenticatedViewName, cursor?: string): void {
  const refs = selectedRefs();
  if (refs === null) return;
  activeView = view;
  selectedDetail = null;
  if (cursor === undefined && views[view] !== undefined) {
    loading = false;
    errorMessage = null;
    render();
    return;
  }
  const argumentsValue = {
    view,
    ...refs,
    ...(cursor === undefined ? {} : { cursor }),
  };
  lastViewArguments = argumentsValue;
  loading = true;
  errorMessage = null;
  render();
  void app.callServerTool({
    name: 'loadAuthenticatedCharacterView',
    arguments: argumentsValue,
  }).then(applyResult).catch(() => {
    loading = false;
    errorMessage = 'Não foi possível carregar esta seção. Tente novamente com a mesma seleção.';
    render();
  });
}

function retry(): void {
  if (lastViewArguments === null) {
    loadView(activeView);
    return;
  }
  loading = true;
  errorMessage = null;
  render();
  void app.callServerTool({
    name: 'loadAuthenticatedCharacterView',
    arguments: lastViewArguments,
  }).then(applyResult).catch(() => {
    loading = false;
    errorMessage = 'A nova tentativa não pôde ser concluída.';
    render();
  });
}

function handleClick(event: Event): void {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
  if (target === null) return;
  if (target.dataset.action === 'reconnect') {
    window.location.reload();
    return;
  }
  if (target.dataset.action === 'retry') {
    retry();
    return;
  }
  if (target.dataset.action === 'load-more') {
    const current = views[activeView];
    const cursor = current?.view === 'INVENTORY' || current?.view === 'ABILITIES'
      ? current.data.page.nextCursor
      : null;
    if (cursor !== null && cursor !== undefined) loadView(activeView, cursor);
    return;
  }
  const detail = target.dataset.detail;
  if (detail !== undefined) {
    selectedDetail = selectedDetail === detail ? null : detail;
    render();
    return;
  }
  const requestedView = target.dataset.view as AuthenticatedViewName | undefined;
  if (requestedView !== undefined && orderedViews.includes(requestedView)) {
    loadView(requestedView);
    return;
  }
  const campaignSelectionRef = target.dataset.campaignSelectionRef;
  const characterSelectionRef = target.dataset.characterSelectionRef;
  if (characterSelectionRef !== undefined && campaignSelectionRef !== undefined) {
    loadContext({ campaignSelectionRef, characterSelectionRef });
    return;
  }
  if (campaignSelectionRef !== undefined) loadContext({ campaignSelectionRef });
}

function handleKeydown(event: KeyboardEvent): void {
  const tab = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('[role="tab"]')
    : null;
  if (tab === null || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const currentIndex = orderedViews.indexOf(activeView);
  const nextIndex = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? orderedViews.length - 1
      : event.key === 'ArrowRight'
        ? (currentIndex + 1) % orderedViews.length
        : (currentIndex - 1 + orderedViews.length) % orderedViews.length;
  loadView(orderedViews[nextIndex] ?? 'SUMMARY');
  queueMicrotask(() => root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
}

app.addEventListener('toolresult', applyResult);
root.addEventListener('click', handleClick);
root.addEventListener('keydown', handleKeydown);
window.addEventListener('pagehide', () => {
  app.removeEventListener('toolresult', applyResult);
  root.removeEventListener('click', handleClick);
  root.removeEventListener('keydown', handleKeydown);
  void app.close();
}, { once: true });

root.innerHTML = '<div class="loading-state" role="status">Carregando contexto autorizado…</div>';
void app.connect().catch(() => {
  root!.innerHTML = renderAuthenticatedFailure(
    'A sessão autenticada não está disponível. Nenhum dado do jogo foi alterado.',
  );
});
