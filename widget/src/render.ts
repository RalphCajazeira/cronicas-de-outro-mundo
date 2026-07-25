import type { AppState } from './app-state.js';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function shell(content: string, fixtureMode: boolean): string {
  return `
    <div class="app-shell">
      <header class="brand">
        <div class="brand__sigil" aria-hidden="true"><span>✦</span></div>
        <div>
          <p class="eyebrow">Uma jornada narrada por você</p>
          <h1>Crônicas de Outro Mundo</h1>
        </div>
      </header>
      ${fixtureMode ? '<p class="demo-badge">Demonstração local</p>' : ''}
      <main>${content}</main>
      <footer>Suas escolhas abrem o caminho. As regras preservam a história.</footer>
    </div>
  `;
}

function disconnectedView(): string {
  return shell(`
    <section class="hero-card" aria-labelledby="connect-title">
      <p class="chapter">Portal de entrada</p>
      <h2 id="connect-title">Sua próxima crônica espera.</h2>
      <p class="lead">Conecte sua conta para encontrar jornadas em andamento ou começar uma nova história.</p>
      <button class="primary-action" type="button" data-action="connect">
        <span>Conectar conta</span><span aria-hidden="true">→</span>
      </button>
      <p class="privacy-note">A conexão acontece com segurança fora desta interface. Nenhuma credencial é solicitada aqui.</p>
    </section>
  `, true);
}

function homeView(state: AppState): string {
  const context = state.context;
  if (context?.authState !== 'CONNECTED_FIXTURE' || context.player === null) return disconnectedView();
  const resume = context.resume;
  const continueDisabled = !context.capabilities.canContinue || resume === null;
  const journey = resume === null
    ? `
      <div class="journey-card journey-card--empty">
        <p class="chapter">Nenhuma jornada retomável</p>
        <h3>O mundo está pronto para um novo começo.</h3>
        <p>Quando uma campanha existir, ela aparecerá aqui sem que a interface invente uma história.</p>
      </div>
    `
    : `
      <div class="journey-card">
        <div class="journey-card__topline">
          <span>${escapeHtml(resume.worldName)}</span>
          <span class="status">${escapeHtml(resume.campaignStatus)}</span>
        </div>
        <h3>${escapeHtml(resume.campaignName)}</h3>
        <dl>
          <div><dt>Personagem</dt><dd>${escapeHtml(resume.characterName)} · Nível ${resume.characterLevel}</dd></div>
          <div><dt>Último estado</dt><dd>${escapeHtml(resume.lastKnownStateLabel)}</dd></div>
          <div><dt>Sessão</dt><dd>${escapeHtml(resume.activeSessionType)}</dd></div>
        </dl>
      </div>
    `;

  return shell(`
    <section aria-labelledby="welcome-title">
      <p class="chapter">Bem-vindo de volta</p>
      <h2 id="welcome-title">${escapeHtml(context.player.displayName)}</h2>
      <p class="lead">Escolha como deseja atravessar o portal.</p>
      ${journey}
      <div class="action-grid">
        <button class="primary-action" type="button" data-action="continue" ${continueDisabled ? 'disabled aria-disabled="true"' : ''}>
          <span>Continuar</span><span aria-hidden="true">→</span>
        </button>
        <button class="secondary-action" type="button" data-action="new-game">
          <span>Novo Jogo</span><span aria-hidden="true">＋</span>
        </button>
      </div>
    </section>
  `, context.environment.fixtureMode);
}

function continuePreview(state: AppState): string {
  const resume = state.context?.resume;
  if (resume === null || resume === undefined) return homeView(state);
  return shell(`
    <section aria-labelledby="resume-title">
      <button class="back-action" type="button" data-action="back">← Voltar</button>
      <p class="chapter">Prévia da jornada</p>
      <h2 id="resume-title">${escapeHtml(resume.campaignName)}</h2>
      <div class="preview-panel">
        <p class="location">${escapeHtml(resume.lastKnownStateLabel)}</p>
        <dl>
          <div><dt>Mundo</dt><dd>${escapeHtml(resume.worldName)}</dd></div>
          <div><dt>Herói</dt><dd>${escapeHtml(resume.characterName)}, nível ${resume.characterLevel}</dd></div>
          <div><dt>Estado</dt><dd>${escapeHtml(resume.campaignStatus)}</dd></div>
          <div><dt>Tipo de sessão</dt><dd>${escapeHtml(resume.activeSessionType)}</dd></div>
        </dl>
      </div>
      <p class="privacy-note">Esta prova mostra apenas um resumo público. Nenhum estado do jogo foi alterado.</p>
    </section>
  `, state.context?.environment.fixtureMode ?? false);
}

function newGameOptions(state: AppState): string {
  return shell(`
    <section aria-labelledby="new-game-title">
      <button class="back-action" type="button" data-action="back">← Voltar</button>
      <p class="chapter">Uma página em branco</p>
      <h2 id="new-game-title">Como deseja criar sua história?</h2>
      <p class="lead">Nesta prova, as opções são apenas visuais e não persistem nada.</p>
      <div class="creation-grid">
        <article>
          <span class="creation-icon" aria-hidden="true">⚔</span>
          <h3>Criação Rápida</h3>
          <p>Comece por um arquétipo e deixe o mundo ganhar forma durante a aventura.</p>
          <button type="button" disabled aria-disabled="true">Explorar em breve</button>
        </article>
        <article>
          <span class="creation-icon" aria-hidden="true">✧</span>
          <h3>Criação Detalhada</h3>
          <p>Defina cada aspecto do personagem e da campanha antes do primeiro capítulo.</p>
          <button type="button" disabled aria-disabled="true">Explorar em breve</button>
        </article>
      </div>
    </section>
  `, state.context?.environment.fixtureMode ?? false);
}

function errorView(state: AppState): string {
  return shell(`
    <section class="error-card" role="alert" aria-labelledby="error-title">
      <p class="chapter">O portal oscilou</p>
      <h2 id="error-title">Não foi possível carregar esta crônica.</h2>
      <p>${escapeHtml(state.errorMessage ?? 'Tente novamente em instantes.')}</p>
      ${state.context?.authState === 'CONNECTED_FIXTURE'
        ? '<button class="secondary-action" type="button" data-action="back">Voltar ao início</button>'
        : ''}
    </section>
  `, state.context?.environment.fixtureMode ?? true);
}

export function renderApp(state: AppState): string {
  switch (state.screen) {
    case 'DISCONNECTED':
      return disconnectedView();
    case 'HOME':
      return homeView(state);
    case 'CONTINUE_PREVIEW':
      return continuePreview(state);
    case 'NEW_GAME_OPTIONS':
      return newGameOptions(state);
    case 'ERROR':
      return errorView(state);
  }
}
