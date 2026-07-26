import type { AuthenticatedContext } from './authenticated-context.js';

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
          <p class="eyebrow">Portal autenticado · somente leitura</p>
          <h1>Crônicas de Outro Mundo</h1>
        </div>
      </header>
      <main>${content}</main>
      <footer>Nenhuma ação mecânica ou narrativa pode ser executada nesta tela.</footer>
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
        Ver contexto
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
          <span>Nível ${character.level}</span>
        </button>
      `).join('')}
    </div>
  `;
}

function resourceList(context: AuthenticatedContext): string {
  const resources = context.widgetContext.activeContext?.resources ?? [];
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

function authorizedHome(context: AuthenticatedContext): string {
  const active = context.widgetContext.activeContext;
  const selectedCharacter = active?.character;
  return shell(context, `
    <section aria-labelledby="player-title">
      <p class="chapter">Jogador conectado</p>
      <h2 id="player-title">${escapeHtml(context.widgetContext.connectedPlayer ?? '')}</h2>
      ${context.widgetContext.campaigns.length > 1 || active === null
        ? `<div class="campaign-grid">${campaignList(context)}</div>`
        : ''}
      ${active === null ? '' : `
        <article class="context-card">
          <p class="world-name">${escapeHtml(active.campaign.worldName)}</p>
          <h3>${escapeHtml(active.campaign.displayName)}</h3>
          <p class="readonly-pill">Contexto oficial somente leitura</p>
          ${selectedCharacter === null || selectedCharacter === undefined
            ? characterList(context)
            : `
              <div class="character-heading">
                <span>Personagem autorizado</span>
                <strong>${escapeHtml(selectedCharacter.displayName)} · Nível ${selectedCharacter.level}</strong>
              </div>
              ${resourceList(context)}
              <div class="continuity">
                <h4>Continuidade pública</h4>
                <p>${escapeHtml(context.narrativeContext?.continuitySummary ?? 'Nenhum resumo público disponível.')}</p>
              </div>
            `}
        </article>
      `}
    </section>
  `);
}

export function renderAuthenticatedContext(context: AuthenticatedContext): string {
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
  return authorizedHome(context);
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
