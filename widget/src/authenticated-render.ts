import type { AuthenticatedContext } from './authenticated-context.js';
import type {
  AuthenticatedCharacterView,
  AuthenticatedViewName,
} from './authenticated-character-view.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shell(context: AuthenticatedContext, content: string): string {
  return `
    <div class="authenticated-shell">
      <div class="environment-banner">${escapeHtml(context.widgetContext.banner)}</div>
      <header>
        <div class="sigil" aria-hidden="true">✦</div>
        <div>
          <p class="eyebrow">Portal autenticado · contexto seguro</p>
          <h1>Crônicas de Outro Mundo</h1>
        </div>
      </header>
      <main>${content}</main>
      <footer>A seleção salva apenas sua preferência. Consultas são somente leitura e ações narrativas não alteram o estado mecânico.</footer>
    </div>
  `;
}

function noPlayer(context: AuthenticatedContext): string {
  return shell(context, `
    <section class="state-card" aria-labelledby="no-player-title">
      <p class="chapter">Conta conectada</p>
      <h2 id="no-player-title">O perfil de jogador ainda não foi vinculado.</h2>
      <p>A autenticação está válida, mas nenhuma campanha pode ser exibida até o vínculo explícito.</p>
      <span class="readonly-pill">${escapeHtml(context.widgetContext.cta.label)}</span>
    </section>
  `);
}

function noCampaign(context: AuthenticatedContext): string {
  return shell(context, `
    <section class="state-card" aria-labelledby="no-campaign-title">
      <p class="chapter">Jogador conectado</p>
      <h2 id="no-campaign-title">${escapeHtml(context.widgetContext.connectedPlayer ?? '')}</h2>
      <p>Nenhuma campanha autorizada está disponível para esta conta.</p>
      <span class="readonly-pill">${escapeHtml(context.widgetContext.cta.label)}</span>
    </section>
  `);
}

function campaignList(context: AuthenticatedContext): string {
  return context.widgetContext.campaigns.map((campaign) => `
    <article class="campaign-card">
      <div>
        <p class="world-name">${escapeHtml(campaign.worldName)}</p>
        <h3>${escapeHtml(campaign.displayName)}</h3>
        <span class="status">${escapeHtml(campaign.status)}</span>
      </div>
      <button type="button" data-campaign-selection-ref="${escapeHtml(campaign.selectionRef)}">
        Selecionar campanha
      </button>
    </article>
  `).join('');
}

function characterList(context: AuthenticatedContext): string {
  const selected = context.widgetContext.activeContext?.campaign.selectionRef;
  const campaign = context.widgetContext.campaigns.find((item) => item.selectionRef === selected);
  if (campaign === undefined || campaign.characters.length === 0) {
    return '<p class="empty-note">Nenhum personagem autorizado está disponível nesta campanha.</p>';
  }
  return `
    <div class="character-grid">
      ${campaign.characters.map((character) => `
        <button class="character-card" type="button"
          data-character-selection-ref="${escapeHtml(character.selectionRef)}"
          data-campaign-selection-ref="${escapeHtml(campaign.selectionRef)}">
          <strong>${escapeHtml(character.displayName)}</strong>
          <span>Nível ${character.level} · ${escapeHtml(character.accessLabel)}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function resourceCards(resources: readonly { code: string; current: number; maximum: number | null }[]): string {
  if (resources.length === 0) {
    return '<p class="empty-note">Nenhum recurso público básico foi materializado para este personagem.</p>';
  }
  return `
    <dl class="resource-grid">
      ${resources.map((resource) => `
        <div>
          <dt>${escapeHtml(resource.code.toUpperCase())}</dt>
          <dd>${resource.current}${resource.maximum === null ? '' : ` / ${resource.maximum}`}</dd>
        </div>
      `).join('')}
    </dl>
  `;
}

const tabLabels: Readonly<Record<AuthenticatedViewName, string>> = {
  SUMMARY: 'Resumo',
  SHEET: 'Ficha',
  INVENTORY: 'Inventário',
  EQUIPMENT: 'Equipamento',
  ABILITIES: 'Habilidades',
};

function tabs(active: AuthenticatedViewName): string {
  return `
    <div class="tabs" role="tablist" aria-label="Seções do personagem">
      ${(Object.keys(tabLabels) as AuthenticatedViewName[]).map((view) => `
        <button type="button" role="tab"
          aria-selected="${String(view === active)}"
          tabindex="${view === active ? '0' : '-1'}"
          data-view="${view}">
          ${tabLabels[view]}
        </button>
      `).join('')}
    </div>
  `;
}

function identityLine(identity: {
  species: string | null;
  className: string | null;
  role: string | null;
  level: number;
  status: string;
}): string {
  return [
    identity.species,
    identity.className,
    identity.role,
    `Nível ${identity.level}`,
    identity.status,
  ].filter((value): value is string => value !== null).map(escapeHtml).join(' · ');
}

function unavailableList(items: readonly { label: string }[]): string {
  if (items.length === 0) return '';
  return `
    <aside class="unavailable-note">
      <strong>Ainda não persistido nesta versão</strong>
      <span>${items.map((item) => escapeHtml(item.label)).join(' · ')}</span>
    </aside>
  `;
}

function summary(view: Extract<AuthenticatedCharacterView, { view: 'SUMMARY' }>): string {
  return `
    <section class="view-panel" role="tabpanel">
      <p class="chapter">${escapeHtml(view.data.identity.worldName)} · ${escapeHtml(view.data.identity.campaignName)}</p>
      <h2>${escapeHtml(view.data.identity.name)}</h2>
      <p class="identity-line">${identityLine(view.data.identity)}</p>
      ${view.data.identity.description === null ? '' : `<p>${escapeHtml(view.data.identity.description)}</p>`}
      ${resourceCards(view.data.resources)}
      <div class="summary-strip">
        <strong>${view.data.activeStatusCount}</strong>
        <span>estado(s) ativo(s)</span>
      </div>
      <div class="continuity">
        <h3>Continuidade pública</h3>
        <p>${escapeHtml(view.data.continuitySummary)}</p>
      </div>
    </section>
  `;
}

function sheet(view: Extract<AuthenticatedCharacterView, { view: 'SHEET' }>): string {
  return `
    <section class="view-panel" role="tabpanel">
      <div class="section-heading">
        <div><p class="chapter">Ficha mecânica</p><h2>${escapeHtml(view.data.identity.name)}</h2></div>
        <span class="readonly-pill">${escapeHtml(view.data.ruleset.code)} · ${escapeHtml(view.data.ruleset.revision)}</span>
      </div>
      ${resourceCards(view.data.resources)}
      <h3>Atributos primários</h3>
      <div class="stat-grid">
        ${view.data.attributes.map((attribute) => `
          <article class="stat-card">
            <span>${escapeHtml(attribute.label)}</span>
            <strong>${attribute.effective}</strong>
            <small>base ${attribute.base} + progressão ${attribute.progression} · XP ${attribute.xp}</small>
          </article>
        `).join('')}
      </div>
      <h3>Atributos secundários</h3>
      <dl class="secondary-list">
        ${view.data.secondaryAttributes.map((attribute) => `
          <div><dt>${escapeHtml(attribute.label)}</dt><dd>${attribute.value}${attribute.unit === 'BASIS_POINTS' ? ' bps' : ''}</dd></div>
        `).join('')}
      </dl>
      <h3>Estados ativos</h3>
      ${view.data.activeStatusEffects.length === 0
        ? '<p class="empty-note">Nenhum estado público ativo.</p>'
        : view.data.activeStatusEffects.map((effect) => `
          <article class="compact-card">
            <strong>${escapeHtml(effect.name)}${effect.stacks > 1 ? ` ×${effect.stacks}` : ''}</strong>
            <span>${escapeHtml(effect.duration)}</span>
          </article>
        `).join('')}
      ${unavailableList(view.data.unavailable)}
    </section>
  `;
}

function inventory(
  view: Extract<AuthenticatedCharacterView, { view: 'INVENTORY' }>,
  selectedDetail: string | null,
): string {
  return `
    <section class="view-panel" role="tabpanel">
      <div class="section-heading">
        <div><p class="chapter">Carga e posses</p><h2>Inventário</h2></div>
        <span class="readonly-pill">${view.data.currency.amount} ${escapeHtml(view.data.currency.label)}</span>
      </div>
      <p>${view.data.weight.carried} / ${view.data.weight.capacity} de carga · ${escapeHtml(view.data.weight.state)}</p>
      <div class="item-list">
        ${view.data.items.length === 0 ? '<p class="empty-note">O inventário está vazio.</p>' : view.data.items.map((item, index) => {
          const key = `inventory-${index}`;
          const open = selectedDetail === key;
          return `
            <article class="item-card">
              <button type="button" class="item-button" data-detail="${key}" aria-expanded="${String(open)}">
                <span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category)} · ${item.quantity} un.</small></span>
                <span>${item.equipped ? 'Equipado' : escapeHtml(item.state)}</span>
              </button>
              ${open ? `
                <div class="item-detail">
                  ${item.description === null ? '' : `<p>${escapeHtml(item.description)}</p>`}
                  <p>Peso ${item.unitWeight} por unidade · ${item.totalWeight} total</p>
                  <p>${item.stackable ? 'Empilhável' : 'Único'} · ${item.consumable ? 'Consumível' : 'Não consumível'}</p>
                </div>
              ` : ''}
            </article>
          `;
        }).join('')}
      </div>
      ${view.data.page.nextCursor === null ? '' : '<button type="button" class="load-more" data-action="load-more">Carregar mais</button>'}
      ${unavailableList(view.data.unavailable)}
    </section>
  `;
}

function equipment(
  view: Extract<AuthenticatedCharacterView, { view: 'EQUIPMENT' }>,
  selectedDetail: string | null,
): string {
  return `
    <section class="view-panel" role="tabpanel">
      <p class="chapter">Carga equipada</p>
      <h2>Equipamento</h2>
      <p>${escapeHtml(view.data.readOnlyNotice)}</p>
      <div class="equipment-grid">
        ${view.data.slots.map((slot, index) => {
          const key = `equipment-${index}`;
          const open = selectedDetail === key;
          return `
            <article class="slot-card">
              <span>${escapeHtml(slot.label)}</span>
              ${slot.item === null
                ? '<strong>Vazio</strong>'
                : `
                  <button type="button" class="item-button" data-detail="${key}" aria-expanded="${String(open)}">
                    <strong>${escapeHtml(slot.item.name)}</strong>
                  </button>
                  ${open ? `
                    <div class="item-detail">
                      ${slot.item.description === null ? '' : `<p>${escapeHtml(slot.item.description)}</p>`}
                      ${slot.item.bonuses.map((bonus) => `<p>${escapeHtml(bonus.label)}: ${bonus.amount >= 0 ? '+' : ''}${bonus.amount}</p>`).join('')}
                      ${slot.item.requirements.map((requirement) => `<p>${escapeHtml(requirement)}</p>`).join('')}
                    </div>
                  ` : ''}
                `}
            </article>
          `;
        }).join('')}
      </div>
      ${unavailableList(view.data.unavailable)}
    </section>
  `;
}

function abilities(
  view: Extract<AuthenticatedCharacterView, { view: 'ABILITIES' }>,
  selectedDetail: string | null,
): string {
  return `
    <section class="view-panel" role="tabpanel">
      <p class="chapter">Conhecimento materializado</p>
      <h2>Habilidades</h2>
      <div class="item-list">
        ${view.data.abilities.length === 0 ? '<p class="empty-note">Nenhuma habilidade pública conhecida.</p>' : view.data.abilities.map((ability, index) => {
          const key = `ability-${index}`;
          const open = selectedDetail === key;
          return `
            <article class="item-card">
              <button type="button" class="item-button" data-detail="${key}" aria-expanded="${String(open)}">
                <span><strong>${escapeHtml(ability.name)}</strong><small>${ability.category} · ${ability.state}</small></span>
                <span>Rank ${ability.rank}</span>
              </button>
              ${open ? `
                <div class="item-detail">
                  ${ability.description === null ? '' : `<p>${escapeHtml(ability.description)}</p>`}
                  <p>${escapeHtml(ability.action.activation)} · ${escapeHtml(ability.action.cost)}</p>
                  <p>${escapeHtml(ability.action.targeting)}</p>
                  ${ability.action.effects.map((effect) => `<p>${escapeHtml(effect)}</p>`).join('')}
                  ${ability.bonuses.map((bonus) => `<p>${escapeHtml(bonus.label)}: ${bonus.amount >= 0 ? '+' : ''}${bonus.amount}</p>`).join('')}
                </div>
              ` : ''}
            </article>
          `;
        }).join('')}
      </div>
      ${view.data.page.nextCursor === null ? '' : '<button type="button" class="load-more" data-action="load-more">Carregar mais</button>'}
      ${unavailableList(view.data.unavailable)}
    </section>
  `;
}

function viewContent(
  view: AuthenticatedCharacterView,
  selectedDetail: string | null,
): string {
  if (view.view === 'SUMMARY') return summary(view);
  if (view.view === 'SHEET') return sheet(view);
  if (view.view === 'INVENTORY') return inventory(view, selectedDetail);
  if (view.view === 'EQUIPMENT') return equipment(view, selectedDetail);
  return abilities(view, selectedDetail);
}

export interface AuthenticatedRenderState {
  readonly activeView: AuthenticatedViewName;
  readonly view: AuthenticatedCharacterView | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedDetail: string | null;
  readonly selectionFeedback?: string | null;
  readonly selectionRecovery?: 'NONE' | 'RELOAD_REQUIRED' | 'SAFE_RETRY' | 'SELECT_AGAIN';
  readonly narrativeComposer?: {
    readonly draft: string;
    readonly sending: boolean;
    readonly error: string | null;
  };
  readonly observation?: {
    readonly focus: string;
    readonly feedback: string | null;
    readonly recovery: 'NONE' | 'SAFE_RETRY' | 'RELOAD_REQUIRED';
  };
}

const quickNarrativeChoices = [
  'Observar os arredores com atenção.',
  'Conversar com quem está por perto.',
  'Seguir em frente com cautela.',
] as const;

function narrativeComposer(state: AuthenticatedRenderState['narrativeComposer']): string {
  const draft = state?.draft ?? '';
  const sending = state?.sending ?? false;
  const error = state?.error ?? null;
  return `
    <section class="narrative-composer" aria-labelledby="narrative-action-title">
      <div>
        <p class="chapter">Ação livre</p>
        <h3 id="narrative-action-title">O que seu personagem faz?</h3>
        <p>O texto será enviado à conversa. Nenhuma mutação mecânica é executada por este campo.</p>
      </div>
      <div class="quick-choices" aria-label="Escolhas narrativas rápidas">
        ${quickNarrativeChoices.map((choice) => `
          <button type="button" data-action="quick-choice" data-prompt="${escapeHtml(choice)}"
            ${sending ? 'disabled' : ''}>${escapeHtml(choice)}</button>
        `).join('')}
      </div>
      <form data-action="narrative-form">
        <label for="narrative-action">Descreva sua ação...</label>
        <textarea id="narrative-action" name="narrative-action" rows="3" maxlength="500"
          placeholder="Descreva sua ação..." ${sending ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
        <div class="composer-actions">
          <span class="composer-status" aria-live="polite">
            ${sending ? 'Enviando para a conversa…' : error === null ? '' : escapeHtml(error)}
          </span>
          <button type="submit" ${sending || draft.trim().length === 0 ? 'disabled' : ''}>
            ${sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </form>
    </section>
  `;
}

function observationActions(
  context: AuthenticatedContext,
  renderState: AuthenticatedRenderState,
): string {
  const session = context.widgetContext.gameSession;
  const lastAction = session.lastAction;
  const canObserve = context.widgetContext.navigation.canMutate
    && session.status === 'ACTIVE'
    && session.canContinue;
  const focus = renderState.observation?.focus ?? '';
  const feedback = renderState.observation?.feedback ?? null;
  const recovery = renderState.observation?.recovery ?? 'NONE';
  return `
    <section class="observation-actions" aria-labelledby="observation-title">
      <div>
        <p class="chapter">Ações</p>
        <h3 id="observation-title">Observar os arredores</h3>
        <p>Registra uma única ação oficial. O resultado mecânico é confirmado pelo backend antes da narração.</p>
      </div>
      <form data-action="observation-form">
        <label for="observation-focus">Onde deseja concentrar sua atenção?</label>
        <input id="observation-focus" name="observation-focus" type="text" maxlength="300"
          value="${escapeHtml(focus)}" placeholder="Opcional" ${canObserve && !renderState.loading ? '' : 'disabled'}>
        <div class="composer-actions">
          <span class="composer-status" aria-live="polite">${feedback === null ? '' : escapeHtml(feedback)}</span>
          <button type="submit" data-action="observe" ${canObserve && !renderState.loading && recovery !== 'RELOAD_REQUIRED' ? '' : 'disabled'}>
            Observar os arredores
          </button>
        </div>
      </form>
      ${recovery === 'SAFE_RETRY' ? '<button type="button" data-action="retry-observation">Tentar novamente com segurança</button>' : ''}
      ${recovery === 'RELOAD_REQUIRED' ? '<button type="button" data-action="reload-observation">Recarregar contexto oficial</button>' : ''}
      <p class="session-version">Versão atual da sessão: ${session.stateVersion}</p>
      ${lastAction === null ? '' : `
        <article class="official-action-result" aria-live="polite">
          <p class="chapter">Última ação persistida</p>
          <strong>${escapeHtml(lastAction.summary)}</strong>
          <span>${lastAction.focus === null ? 'Sem foco específico.' : `Foco: ${escapeHtml(lastAction.focus)}`}</span>
        </article>
      `}
    </section>
  `;
}

function characterHome(context: AuthenticatedContext, state: AuthenticatedRenderState): string {
  const active = context.widgetContext.activeContext;
  if (active?.character === null || active?.character === undefined) {
    return shell(context, `
      <section>
        <p class="chapter">Jogador conectado</p>
        <h2>${escapeHtml(context.widgetContext.connectedPlayer ?? '')}</h2>
        ${context.widgetContext.campaigns.length > 1 || active === null
          ? `<div class="campaign-grid">${campaignList(context)}</div>`
          : ''}
        ${active === null ? '' : `<article class="context-card">${characterList(context)}</article>`}
      </section>
    `);
  }
  const body = state.loading
    ? '<div class="loading-state" role="status">Carregando seção autorizada…</div>'
    : state.error === null
      ? state.view === null
        ? `
          <div class="continuity">
            <h3>Continuidade pública</h3>
            <p>${escapeHtml(context.narrativeContext?.continuitySummary ?? 'Escolha uma seção para consultar.')}</p>
          </div>
        `
        : viewContent(state.view, state.selectedDetail)
      : `
        <section class="inline-error" role="alert">
          <p>${escapeHtml(state.error)}</p>
          <button type="button" data-action="retry">Tentar novamente</button>
        </section>
      `;
  const officialSelection = context.widgetContext.gameSession.selection;
  const isOfficialSelection = officialSelection?.campaignSelectionRef === active.campaign.selectionRef
    && officialSelection.characterSelectionRef === active.character.selectionRef;
  const selectionActions = `
    <section class="selection-confirmation" aria-live="polite">
      <div>
        <p class="chapter">${isOfficialSelection ? 'Seleção persistida' : 'Confirmar seleção'}</p>
        <strong>${escapeHtml(active.campaign.displayName)} · ${escapeHtml(active.character.displayName)}</strong>
        <span>${escapeHtml(active.character.accessLabel)} · versão ${active.campaign.sessionVersion}</span>
      </div>
      ${isOfficialSelection
        ? `<button type="button" data-action="continue"
            ${context.widgetContext.gameSession.canContinue ? '' : 'disabled'}>Continuar</button>`
        : `<button type="button" data-action="confirm-selection"
            ${state.loading || !context.widgetContext.navigation.canPersistSelection ? 'disabled' : ''}>
            Usar esta campanha e personagem
          </button>`}
      ${state.selectionFeedback === null || state.selectionFeedback === undefined
        ? ''
        : `<p class="${state.selectionRecovery === 'NONE' ? 'success-note' : 'error-note'}">
            ${escapeHtml(state.selectionFeedback)}
          </p>`}
      ${state.selectionRecovery === 'SAFE_RETRY'
        ? '<button type="button" data-action="retry-selection">Tentar novamente com segurança</button>'
        : state.selectionRecovery === 'RELOAD_REQUIRED'
          ? '<button type="button" data-action="reload-context">Recarregar seleção oficial</button>'
          : ''}
    </section>
  `;
  return shell(context, `
    <section class="character-workspace" aria-labelledby="character-title">
      <div class="character-heading">
        <p class="chapter">Jogador conectado · ${escapeHtml(context.widgetContext.connectedPlayer ?? '')}</p>
        <span>${escapeHtml(active.campaign.worldName)} · ${escapeHtml(active.campaign.displayName)}</span>
        <h2 id="character-title">${escapeHtml(active.character.displayName)}</h2>
      </div>
      <details class="context-switcher">
        <summary>Trocar campanha ou personagem</summary>
        <h3>Campanhas autorizadas</h3>
        <div class="campaign-grid">${campaignList(context)}</div>
        <h3>Personagens desta campanha</h3>
        ${characterList(context)}
      </details>
      ${selectionActions}
      ${observationActions(context, state)}
      ${tabs(state.activeView)}
      ${body}
      ${narrativeComposer(state.narrativeComposer)}
    </section>
  `);
}

const defaultState: AuthenticatedRenderState = {
  activeView: 'SUMMARY',
  view: null,
  loading: false,
  error: null,
  selectedDetail: null,
};

export function renderAuthenticatedContext(
  context: AuthenticatedContext,
  state: AuthenticatedRenderState = defaultState,
): string {
  if (context.authState === 'AUTHORIZATION_ERROR') {
    return shell(context, `
      <section class="state-card error-card" role="alert">
        <p class="chapter">Acesso indisponível</p>
        <h2>Não foi possível abrir esse contexto.</h2>
        <p>Reconecte a conta ou escolha somente uma campanha autorizada.</p>
        <button type="button" data-action="reconnect">Reconectar</button>
      </section>
    `);
  }
  if (context.authState === 'AUTHENTICATED_NO_PLAYER') return noPlayer(context);
  if (context.widgetContext.sessionState === 'NO_CAMPAIGN') return noCampaign(context);
  return characterHome(context, state);
}

export function renderAuthenticatedFailure(message: string): string {
  return `
    <div class="authenticated-shell">
      <div class="environment-banner">CONEXÃO NECESSÁRIA</div>
      <main>
        <section class="state-card error-card" role="alert">
          <p class="chapter">Portal interrompido</p>
          <h1>Reconecte para continuar.</h1>
          <p>${escapeHtml(message)}</p>
          <button type="button" data-action="reconnect">Reconectar</button>
        </section>
      </main>
    </div>
  `;
}
