import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { PlatformAdapter } from '../platform/platform-adapter.js';
import { DEMO_CHARACTER, type DemoItem } from '../shared/fixture.js';
import { SHELL_TABS, type ShellTab } from '../shared/types.js';
import { AppProviders, useGameApp } from './AppProviders.js';

const tabLabels: Record<ShellTab, string> = {
  summary: 'Resumo', sheet: 'Ficha', inventory: 'Inventário', equipment: 'Equipamentos', abilities: 'Habilidades', map: 'Mapa', combat: 'Combate',
};

function DemoList({ items }: { readonly items: readonly DemoItem[] }) {
  return <div className="chronicles-list">{items.map((item) => <article className="chronicles-list-item" key={item.name}>
    <strong>{item.name}</strong><p>{item.description}</p>{item.quantity !== undefined && <small>Quantidade: {item.quantity}</small>}
  </article>)}</div>;
}

function Panel({ tab }: { readonly tab: ShellTab }) {
  if (tab === 'map' || tab === 'combat') return <section aria-labelledby={`chronicles-tab-${tab}`} id={`chronicles-panel-${tab}`} role="tabpanel"><div className="chronicles-coming-soon"><div><h2>{tab === 'map' ? 'Mapa em breve' : 'Combate em breve'}</h2><p>Este módulo ainda não está disponível nesta demonstração local.</p></div></div></section>;
  if (tab === 'summary') return <section aria-labelledby="chronicles-tab-summary" id="chronicles-panel-summary" role="tabpanel"><div className="chronicles-hero"><div><h2>{DEMO_CHARACTER.name}</h2><p className="chronicles-muted">{DEMO_CHARACTER.title} · {DEMO_CHARACTER.accountName}</p></div><span className="chronicles-level">Nível {DEMO_CHARACTER.level}</span></div><dl className="chronicles-grid">{DEMO_CHARACTER.resources.map((resource) => <div className="chronicles-card" key={resource.label}><dt>{resource.label}</dt><dd>{resource.current} / {resource.maximum}</dd></div>)}</dl><h3 className="chronicles-muted">Próximo passo</h3><p className="chronicles-muted">A fundação visual está pronta para receber leituras autorizadas do backend em uma fase futura.</p></section>;
  if (tab === 'sheet') return <section aria-labelledby="chronicles-tab-sheet" id="chronicles-panel-sheet" role="tabpanel"><h2>Ficha</h2><p className="chronicles-muted">Atributos sintéticos para validação do shell.</p><div className="chronicles-attribute-grid">{DEMO_CHARACTER.attributes.map(([label, value]) => <div className="chronicles-attribute" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></section>;
  if (tab === 'inventory') return <section aria-labelledby="chronicles-tab-inventory" id="chronicles-panel-inventory" role="tabpanel"><h2>Inventário</h2><p className="chronicles-muted">Itens estritamente locais — sem estado oficial.</p><DemoList items={DEMO_CHARACTER.inventory} /></section>;
  if (tab === 'equipment') return <section aria-labelledby="chronicles-tab-equipment" id="chronicles-panel-equipment" role="tabpanel"><h2>Equipamentos</h2><p className="chronicles-muted">Equipamento demonstrativo sem efeito mecânico.</p><DemoList items={[DEMO_CHARACTER.equipment]} /></section>;
  return <section aria-labelledby="chronicles-tab-abilities" id="chronicles-panel-abilities" role="tabpanel"><h2>Habilidades</h2><p className="chronicles-muted">Capacidades sintéticas; nenhuma ação é enviada.</p><DemoList items={DEMO_CHARACTER.abilities} /></section>;
}

function AuthPanel() {
  const { auth, login, logout } = useGameApp();
  if (auth.status === 'authenticated') return <div className="chronicles-auth"><span>Conectado como {auth.user.displayName}</span><button className="chronicles-action" onClick={logout} type="button">Sair</button></div>;
  if (auth.status === 'authorizing') return <div className="chronicles-auth">Abrindo login seguro…</div>;
  if (auth.status === 'signed_out') return <div className="chronicles-auth"><span>Entre para conectar sua sessão do jogo.</span><button className="chronicles-action" onClick={login} type="button">Entrar</button></div>;
  return <div className="chronicles-auth"><span>Não foi possível confirmar a sessão.</span><button className="chronicles-action" onClick={login} type="button">Tentar novamente</button></div>;
}

function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')].filter((node) => node.tabIndex >= 0 && !node.hasAttribute('disabled') && !node.hidden);
}

function GameAppContent() {
  const { adapter, preferences, preferencesLoaded, savePreferences } = useGameApp();
  const [activeTab, setActiveTab] = useState<ShellTab>(preferences.activeTab);
  const [overlayOpen, setOverlayOpen] = useState(adapter.mode !== 'overlay');
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const overlayInteracted = useRef(false);

  useEffect(() => { setActiveTab(preferences.activeTab); }, [preferences.activeTab]);
  useEffect(() => { if (preferencesLoaded && adapter.mode === 'overlay' && !overlayInteracted.current) setOverlayOpen(preferences.lastMode === 'overlay'); }, [adapter.mode, preferences.lastMode, preferencesLoaded]);
  useEffect(() => { if (overlayOpen && adapter.mode === 'overlay') closeRef.current?.focus(); }, [adapter.mode, overlayOpen]);
  useEffect(() => {
    if (adapter.mode !== 'overlay') return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!overlayOpen) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const overlay = overlayRef.current;
      if (overlay === null) return;
      const nodes = focusable(overlay);
      const first = nodes[0]; const last = nodes.at(-1);
      if (first === undefined || last === undefined) return;
      const scope = overlay.getRootNode();
      const active = scope instanceof ShadowRoot ? scope.activeElement : document.activeElement;
      if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [adapter.mode, overlayOpen]);

  const selectTab = (tab: ShellTab) => { setActiveTab(tab); savePreferences({ activeTab: tab }); };
  const open = () => { overlayInteracted.current = true; setOverlayOpen(true); savePreferences({ lastMode: 'overlay' }); };
  const close = () => { overlayInteracted.current = true; setOverlayOpen(false); void adapter.close?.(); savePreferences({ lastMode: 'minimized' }); launcherRef.current?.focus(); };
  const minimize = () => { overlayInteracted.current = true; setOverlayOpen(false); void adapter.minimize?.(); savePreferences({ lastMode: 'minimized' }); launcherRef.current?.focus(); };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const movement = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (event.key === 'Home') { event.preventDefault(); tabRefs.current[0]?.focus(); selectTab(SHELL_TABS[0]); return; }
    if (event.key === 'End') { event.preventDefault(); const last = SHELL_TABS.length - 1; tabRefs.current[last]?.focus(); selectTab(SHELL_TABS[last]!); return; }
    if (movement === 0) return;
    event.preventDefault(); const next = (index + movement + SHELL_TABS.length) % SHELL_TABS.length;
    tabRefs.current[next]?.focus(); selectTab(SHELL_TABS[next]!);
  };
  const isOverlay = adapter.mode === 'overlay';
  const launcherStyle = { '--chronicles-launcher-right': `${preferences.buttonPosition.right}px`, '--chronicles-launcher-bottom': `${preferences.buttonPosition.bottom}px` } as CSSProperties;
  return <div className={`chronicles-root chronicles-root--${adapter.mode}`}>
    {isOverlay && <button aria-expanded={overlayOpen} className="chronicles-launcher" data-open={overlayOpen} onClick={open} ref={launcherRef} style={launcherStyle} title="Abrir Crônicas" type="button">✦ Abrir Crônicas</button>}
    <div aria-label="Crônicas de Outro Mundo" aria-modal={isOverlay || undefined} className="chronicles-overlay" hidden={!overlayOpen} ref={overlayRef} role={isOverlay ? 'dialog' : undefined}>
      <section className="chronicles-shell"><header className="chronicles-header"><div className="chronicles-brand"><span className="chronicles-sigil">✦</span><div><p className="chronicles-eyebrow">Crônicas de Outro Mundo</p><h1>Compêndio do Viajante</h1></div></div>
        {isOverlay && <div className="chronicles-actions">{adapter.openFullPage && <button className="chronicles-action" onClick={() => { void adapter.openFullPage?.(); }} title="Abrir a interface em uma aba da extensão" type="button">Abrir em aba</button>}<button className="chronicles-action" onClick={minimize} type="button">Minimizar</button><button className="chronicles-action" onClick={close} ref={closeRef} type="button">Fechar</button></div>}
      </header><AuthPanel /><div aria-label="Seções do compêndio" className="chronicles-tabs" role="tablist">{SHELL_TABS.map((tab, index) => <button aria-controls={`chronicles-panel-${tab}`} aria-selected={activeTab === tab} className="chronicles-tab" id={`chronicles-tab-${tab}`} key={tab} onClick={() => selectTab(tab)} onKeyDown={(event) => onTabKeyDown(event, index)} ref={(node) => { tabRefs.current[index] = node; }} role="tab" tabIndex={activeTab === tab ? 0 : -1} type="button">{tabLabels[tab]}</button>)}</div><main aria-live="polite" className="chronicles-content"><p className="chronicles-demo-banner">Modo de demonstração local — sem conexão com o jogo</p><Panel tab={activeTab} /></main></section>
    </div>
  </div>;
}

export function GameApp({ adapter }: { readonly adapter: PlatformAdapter }) {
  return <AppProviders adapter={adapter}><GameAppContent /></AppProviders>;
}
