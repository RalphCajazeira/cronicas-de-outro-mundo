import { describe, expect, it } from 'vitest';
import { createInitialState, reduceAppState } from '../src/app-state.js';
import { gameContextSchema, type GameContext } from '../src/game-context.js';
import { renderApp } from '../src/render.js';

const disconnected: GameContext = {
  authState: 'DISCONNECTED',
  player: null,
  resume: null,
  capabilities: { canStartNewGame: false, canContinue: false },
  environment: { fixtureMode: true, nonProduction: true },
};

const connected: GameContext = {
  authState: 'CONNECTED_FIXTURE',
  player: { displayName: 'Ralph, viajante de Elarion' },
  resume: {
    canContinue: true,
    characterName: 'Kael',
    characterLevel: 7,
    worldName: 'Elarion',
    campaignName: 'As Cinzas do Primeiro Sol',
    campaignStatus: 'Em andamento',
    lastKnownStateLabel: 'Ruínas de Vhal',
    activeSessionType: 'Exploração',
    updatedAt: '2026-07-25T18:00:00.000Z',
  },
  capabilities: { canStartNewGame: true, canContinue: true },
  environment: { fixtureMode: true, nonProduction: true },
};

describe('home widget state', () => {
  it('renders the disconnected state without credential or identity fields', () => {
    const html = renderApp(createInitialState(disconnected));
    expect(html).toContain('Conectar conta');
    expect(html).not.toMatch(/<input|password|playerId/i);
  });

  it('renders a connected HOME with public campaign data', () => {
    const html = renderApp(createInitialState(gameContextSchema.parse(connected)));
    expect(html).toContain('Ralph, viajante de Elarion');
    expect(html).toContain('As Cinzas do Primeiro Sol');
    expect(html).toContain('Continuar');
    expect(html).not.toContain('MASTER_ONLY');
  });

  it('enables Continue only when a resumable campaign exists', () => {
    const enabled = renderApp(createInitialState(connected));
    const withoutResume = {
      ...connected,
      resume: null,
      capabilities: { ...connected.capabilities, canContinue: false },
    };
    const disabled = renderApp(createInitialState(withoutResume));
    expect(enabled).not.toMatch(/data-action="continue" disabled/);
    expect(disabled).toMatch(/data-action="continue" disabled/);
    expect(disabled).toContain('Nenhuma jornada retomável');
  });

  it('opens the public Continue preview and returns HOME', () => {
    const home = createInitialState(connected);
    const preview = reduceAppState(home, { type: 'OPEN_CONTINUE' });
    expect(preview.screen).toBe('CONTINUE_PREVIEW');
    expect(renderApp(preview)).toContain('Nenhum estado do jogo foi alterado');
    expect(reduceAppState(preview, { type: 'BACK_HOME' }).screen).toBe('HOME');
  });

  it('opens New Game options without persistence controls', () => {
    const options = reduceAppState(createInitialState(connected), { type: 'OPEN_NEW_GAME' });
    const html = renderApp(options);
    expect(options.screen).toBe('NEW_GAME_OPTIONS');
    expect(html).toContain('Criação Rápida');
    expect(html).toContain('Criação Detalhada');
    expect(html).toContain('não persistem nada');
  });

  it('renders an accessible error state', () => {
    const failed = reduceAppState(createInitialState(disconnected), { type: 'FAIL', message: 'Falha controlada' });
    expect(failed.screen).toBe('ERROR');
    expect(renderApp(failed)).toContain('role="alert"');
    expect(renderApp(failed)).toContain('Falha controlada');
  });

  it('remounts deterministically at HOME from the same MCP result', () => {
    const first = createInitialState(connected);
    const navigated = reduceAppState(first, { type: 'OPEN_NEW_GAME' });
    const remounted = createInitialState(connected);
    expect(navigated.screen).toBe('NEW_GAME_OPTIONS');
    expect(remounted).toEqual(first);
    expect(remounted.screen).toBe('HOME');
    expect(remounted.context?.capabilities.canContinue).toBe(true);
  });
});
