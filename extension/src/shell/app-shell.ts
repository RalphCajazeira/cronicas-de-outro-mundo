import shellCss from '../styles/shell.css';
import { DEMO_CHARACTER, type DemoItem } from '../shared/fixture.js';
import { SHELL_TABS, type ExtensionPreferences, type ShellTab } from '../shared/types.js';

export interface ShellController {
  readonly root: HTMLElement;
  open(): void;
  close(): void;
  minimize(): void;
  destroy(): void;
}

interface ShellOptions {
  readonly root: ShadowRoot | HTMLElement;
  readonly mode: 'content' | 'page';
  readonly preferences: ExtensionPreferences;
  readonly onPreferencesChange: (patch: Partial<ExtensionPreferences>) => void;
  readonly onModeChange: (message: 'OPEN_OVERLAY' | 'CLOSE_OVERLAY' | 'MINIMIZE') => void;
  readonly onOpenPage: () => void;
}

const tabLabels: Record<ShellTab, string> = {
  summary: 'Resumo', sheet: 'Ficha', inventory: 'Inventário', equipment: 'Equipamentos', abilities: 'Habilidades', map: 'Mapa', combat: 'Combate',
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function textNode(tag: 'p' | 'h1' | 'h2' | 'h3' | 'strong' | 'small' | 'span', text: string, className?: string): HTMLElement {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

function list(items: readonly DemoItem[]): HTMLElement {
  const container = element('div', 'chronicles-list');
  for (const item of items) {
    const row = element('article', 'chronicles-list-item');
    row.append(textNode('strong', item.name), textNode('p', item.description));
    if (item.quantity !== undefined) row.append(textNode('small', `Quantidade: ${item.quantity}`));
    container.append(row);
  }
  return container;
}

function buildPanel(tab: ShellTab): HTMLElement {
  const panel = element('section');
  panel.setAttribute('role', 'tabpanel');
  panel.id = `chronicles-panel-${tab}`;
  panel.setAttribute('aria-labelledby', `chronicles-tab-${tab}`);
  if (tab === 'map' || tab === 'combat') {
    const notice = element('div', 'chronicles-coming-soon');
    notice.append(textNode('h2', tab === 'map' ? 'Mapa em breve' : 'Combate em breve'), textNode('p', 'Este módulo ainda não está disponível nesta demonstração local.'));
    panel.append(notice);
    return panel;
  }
  if (tab === 'summary') {
    const hero = element('div', 'chronicles-hero');
    const intro = element('div');
    intro.append(textNode('h2', DEMO_CHARACTER.name), textNode('p', `${DEMO_CHARACTER.title} · ${DEMO_CHARACTER.accountName}`, 'chronicles-muted'));
    hero.append(intro, textNode('span', `Nível ${DEMO_CHARACTER.level}`, 'chronicles-level'));
    const resources = element('dl', 'chronicles-grid');
    for (const resource of DEMO_CHARACTER.resources) {
      const card = element('div', 'chronicles-card');
      card.append(textNode('small', resource.label), textNode('strong', `${resource.current} / ${resource.maximum}`));
      resources.append(card);
    }
    panel.append(hero, resources, textNode('h3', 'Próximo passo', 'chronicles-muted'), textNode('p', 'A fundação visual está pronta para receber leituras autorizadas do backend em uma fase futura.', 'chronicles-muted'));
    return panel;
  }
  if (tab === 'sheet') {
    panel.append(textNode('h2', 'Ficha'), textNode('p', 'Atributos sintéticos para validação do shell.', 'chronicles-muted'));
    const attributes = element('div', 'chronicles-attribute-grid');
    for (const [label, value] of DEMO_CHARACTER.attributes) {
      const card = element('div', 'chronicles-attribute');
      card.append(textNode('span', label), textNode('strong', String(value)));
      attributes.append(card);
    }
    panel.append(attributes);
    return panel;
  }
  if (tab === 'inventory') {
    panel.append(textNode('h2', 'Inventário'), textNode('p', 'Itens estritamente locais — sem estado oficial.', 'chronicles-muted'), list(DEMO_CHARACTER.inventory));
    return panel;
  }
  if (tab === 'equipment') {
    panel.append(textNode('h2', 'Equipamentos'), textNode('p', 'Equipamento demonstrativo sem efeito mecânico.', 'chronicles-muted'), list([DEMO_CHARACTER.equipment]));
    return panel;
  }
  panel.append(textNode('h2', 'Habilidades'), textNode('p', 'Capacidades sintéticas; nenhuma ação é enviada.', 'chronicles-muted'), list(DEMO_CHARACTER.abilities));
  return panel;
}

function isHiddenElement(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('hidden') !== null) return true;
  if (element.hasAttribute('disabled')) return true;
  const { visibility, display } = getComputedStyle(element);
  if (visibility === 'hidden' || visibility === 'collapse' || display === 'none') return true;
  return false;
}

function isKeyboardFocusable(node: HTMLElement): boolean {
  if (!('tabIndex' in node)) return false;
  if (node.tabIndex < 0) return false;
  if (node instanceof HTMLAnchorElement && node.getAttribute('href') === null) return false;
  if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement || node instanceof HTMLButtonElement) {
    if (node.disabled) return false;
  }
  return !isHiddenElement(node);
}

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')]
    .filter(isKeyboardFocusable);
}

function activeElementFor(root: ShadowRoot | HTMLElement): Element | null {
  if (root instanceof ShadowRoot) return root.activeElement;
  return root.ownerDocument?.activeElement ?? document.activeElement;
}

export function createAppShell(options: ShellOptions): ShellController {
  const style = document.createElement('style');
  style.textContent = shellCss;
  const root = element('div', 'chronicles-root');
  const launcher = element('button', 'chronicles-launcher');
  launcher.type = 'button';
  launcher.textContent = '✦ Abrir Crônicas';
  launcher.title = 'Abrir Crônicas';
  launcher.setAttribute('aria-expanded', 'false');
  launcher.style.setProperty('--chronicles-launcher-right', `${options.preferences.buttonPosition.right}px`);
  launcher.style.setProperty('--chronicles-launcher-bottom', `${options.preferences.buttonPosition.bottom}px`);

  const overlay = element('div', 'chronicles-overlay');
  overlay.hidden = options.mode === 'content';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Crônicas de Outro Mundo');
  const shell = element('section', 'chronicles-shell');
  const header = element('header', 'chronicles-header');
  const brand = element('div', 'chronicles-brand');
  brand.append(textNode('span', '✦', 'chronicles-sigil'));
  const brandWords = element('div');
  brandWords.append(textNode('p', 'Crônicas de Outro Mundo', 'chronicles-eyebrow'), textNode('h1', 'Compêndio do Viajante'));
  brand.append(brandWords);
  const actions = element('div', 'chronicles-actions');
  const newTab = element('button', 'chronicles-action');
  newTab.type = 'button'; newTab.textContent = 'Abrir em aba'; newTab.title = 'Abrir a interface em uma aba da extensão';
  const minimize = element('button', 'chronicles-action');
  minimize.type = 'button'; minimize.textContent = 'Minimizar';
  const close = element('button', 'chronicles-action');
  close.type = 'button'; close.textContent = 'Fechar';
  if (options.mode === 'content') {
    actions.append(newTab, minimize, close);
    header.append(brand, actions);
  } else {
    header.append(brand);
  }
  const tabs = element('div', 'chronicles-tabs');
  tabs.setAttribute('role', 'tablist');
  const content = element('main', 'chronicles-content');
  const banner = textNode('p', 'Modo de demonstração local — sem conexão com o jogo', 'chronicles-demo-banner');
  content.setAttribute('aria-live', 'polite');
  content.append(banner);
  shell.append(header, tabs, content);
  overlay.append(shell);
  if (options.mode === 'content') root.append(launcher, overlay); else root.append(overlay);
  options.root.append(style, root);

  let activeTab = options.preferences.activeTab;
  let lastFocused: HTMLElement | null = null;
  const renderPanel = () => {
    content.replaceChildren(banner, buildPanel(activeTab));
    for (const button of tabs.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === activeTab));
      button.tabIndex = button.dataset.tab === activeTab ? 0 : -1;
    }
  };
  for (const tab of SHELL_TABS) {
    const tabButton = element('button', 'chronicles-tab');
    tabButton.type = 'button'; tabButton.id = `chronicles-tab-${tab}`; tabButton.dataset.tab = tab;
    tabButton.setAttribute('role', 'tab'); tabButton.textContent = tabLabels[tab];
    tabButton.addEventListener('click', () => {
      activeTab = tab;
      options.onPreferencesChange({ activeTab: tab });
      renderPanel();
    });
    tabs.append(tabButton);
  }
  renderPanel();

  const closeOverlay = (message: 'CLOSE_OVERLAY' | 'MINIMIZE' = 'CLOSE_OVERLAY') => {
    if (options.mode === 'page') return;
    overlay.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    launcher.dataset.open = 'false';
    options.onModeChange(message);
    (lastFocused ?? launcher).focus();
  };
  const openOverlay = () => {
    if (options.mode === 'content') {
      lastFocused ??= document.activeElement instanceof HTMLElement ? document.activeElement : launcher;
      overlay.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      launcher.dataset.open = 'true';
      options.onModeChange('OPEN_OVERLAY');
      close.focus();
    }
  };
  const minimizeOverlay = () => closeOverlay('MINIMIZE');
  launcher.addEventListener('click', () => { lastFocused = launcher; openOverlay(); });
  close.addEventListener('click', () => { closeOverlay(); });
  minimize.addEventListener('click', minimizeOverlay);
  newTab.addEventListener('click', () => { options.onOpenPage(); });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !overlay.hidden && options.mode === 'content') {
      event.preventDefault(); closeOverlay(); return;
    }
    if (event.key !== 'Tab' || overlay.hidden || options.mode !== 'content') return;
    const nodes = focusable(overlay);
    const first = nodes[0]; const last = nodes.at(-1);
    if (first === undefined || last === undefined) return;
    const activeElement = activeElementFor(options.root);
    if (event.shiftKey && activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKeyDown);
  return {
    root,
    open: openOverlay,
    close: closeOverlay,
    minimize: minimizeOverlay,
    destroy: () => { document.removeEventListener('keydown', onKeyDown); root.remove(); style.remove(); },
  };
}
