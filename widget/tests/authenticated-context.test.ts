import { describe, expect, it } from 'vitest';
import type { AuthenticatedContext } from '../src/authenticated-context.js';
import {
  renderAuthenticatedContext,
  renderAuthenticatedFailure,
} from '../src/authenticated-render.js';
import {
  parseAuthenticatedSelectionResult,
  parseAuthenticatedObservationResult,
  parseAuthenticatedToolResult,
} from '../src/authenticated-tool-result.js';

const campaignSelectionRef = `sel_${'a'.repeat(43)}`;
const characterSelectionRef = `sel_${'b'.repeat(43)}`;

function context(
  overrides: Partial<AuthenticatedContext> = {},
): AuthenticatedContext {
  return {
    authState: 'AUTHENTICATED',
    player: { displayName: 'OAuth Staging Tester' },
    narrativeContext: {
      campaignName: 'OAuth Readonly Test',
      characterName: 'Test Adventurer',
      publicLocation: null,
      continuitySummary: 'Nenhum checkpoint narrativo público persistido.',
      pendingDecision: null,
      criticalResources: [],
      narrationClassification: 'NONE',
    },
    widgetContext: {
      banner: 'STAGING — CONTA SINTÉTICA',
      connectedPlayer: 'OAuth Staging Tester',
      campaigns: [{
        selectionRef: campaignSelectionRef,
        displayName: 'OAuth Readonly Test',
        worldName: 'OAuth Test World',
        status: 'active',
        sessionVersion: 1,
        characters: [{
          selectionRef: characterSelectionRef,
          displayName: 'Test Adventurer',
          level: 1,
          accessLabel: 'Jogável',
        }],
      }],
      activeContext: {
        campaign: {
          selectionRef: campaignSelectionRef,
          displayName: 'OAuth Readonly Test',
          worldName: 'OAuth Test World',
          status: 'active',
          sessionVersion: 1,
        },
        character: {
          selectionRef: characterSelectionRef,
          displayName: 'Test Adventurer',
          level: 1,
          accessLabel: 'Jogável',
        },
        resources: [],
        readOnly: true,
      },
      gameSession: {
        status: 'ACTIVE',
        stateVersion: 1,
        canContinue: true,
        selection: { campaignSelectionRef, characterSelectionRef },
        lastAction: null,
      },
      sessionState: 'READ_ONLY_READY',
      navigation: {
        canSelectCampaign: false,
        canSelectCharacter: false,
        canViewContext: true,
        canMutate: false,
        canPersistSelection: true,
        canContinue: true,
      },
      cta: {
        kind: 'VIEW_CONTEXT',
        label: 'Contexto somente leitura',
      },
    },
    environment: {
      appEnvironment: 'staging',
      runtimeMode: 'production',
      syntheticAccount: true,
    },
    ...overrides,
  };
}

function toolResult(value: AuthenticatedContext) {
  return {
    content: [{ type: 'text' as const, text: 'Safe summary' }],
    structuredContent: value,
  };
}

describe('authenticated read-only widget', () => {
  it('parses only strict structured content and rejects MASTER_ONLY additions', () => {
    expect(parseAuthenticatedToolResult(toolResult(context()))).toEqual(context());
    expect(() => parseAuthenticatedToolResult(toolResult({
      ...context(),
      MASTER_ONLY: 'secret',
    } as AuthenticatedContext))).toThrow(/contrato seguro/u);
  });

  it('restores a null session selection omitted by the ChatGPT host', () => {
    const withoutSession = context();
    withoutSession.widgetContext.gameSession = {
      status: 'NONE',
      stateVersion: 0,
      canContinue: false,
      selection: null,
      lastAction: null,
    };
    const hostOutput = structuredClone(withoutSession) as AuthenticatedContext & {
      widgetContext: AuthenticatedContext['widgetContext'] & {
        gameSession: Omit<AuthenticatedContext['widgetContext']['gameSession'], 'selection'>;
      };
    };
    delete (hostOutput.widgetContext.gameSession as Partial<
      AuthenticatedContext['widgetContext']['gameSession']
    >).selection;

    expect(parseAuthenticatedToolResult({
      content: [{ type: 'text' as const, text: 'Safe summary' }],
      structuredContent: hostOutput,
    })).toEqual(withoutSession);
  });

  it('renders the staging banner, player, campaign, character, and read-only continuity', () => {
    const html = renderAuthenticatedContext(context());
    expect(html).toContain('STAGING — CONTA SINTÉTICA');
    expect(html).toContain('OAuth Staging Tester');
    expect(html).toContain('OAuth Readonly Test');
    expect(html).toContain('Test Adventurer');
    expect(html).toContain('Nenhum checkpoint narrativo público persistido.');
    expect(html).toContain('somente leitura');
    expect(html).not.toMatch(/atacar|usar item|equipar|criar campanha|continuar aventura/i);
  });

  it('renders no-Player, no-campaign, campaign selection, authorization error, and reconnect states', () => {
    const noPlayer = context({
      authState: 'AUTHENTICATED_NO_PLAYER',
      player: null,
      narrativeContext: null,
      widgetContext: {
        ...context().widgetContext,
        connectedPlayer: null,
        campaigns: [],
        activeContext: null,
        sessionState: 'NO_PLAYER',
        navigation: {
          canSelectCampaign: false,
          canSelectCharacter: false,
          canViewContext: false,
          canMutate: false,
          canPersistSelection: false,
          canContinue: false,
        },
        cta: { kind: 'LINK_PLAYER', label: 'Aguardar vínculo do jogador' },
      },
    });
    expect(renderAuthenticatedContext(noPlayer)).toContain('ainda não foi vinculado');

    const noCampaign = context({
      narrativeContext: null,
      widgetContext: {
        ...context().widgetContext,
        campaigns: [],
        activeContext: null,
        sessionState: 'NO_CAMPAIGN',
        navigation: {
          canSelectCampaign: false,
          canSelectCharacter: false,
          canViewContext: false,
          canMutate: false,
          canPersistSelection: false,
          canContinue: false,
        },
        cta: { kind: 'WAIT_FOR_CAMPAIGN', label: 'Nenhuma campanha autorizada' },
      },
    });
    expect(renderAuthenticatedContext(noCampaign)).toContain('Nenhuma campanha autorizada');

    const campaignSelection = context({
      narrativeContext: null,
      widgetContext: {
        ...context().widgetContext,
        activeContext: null,
        sessionState: 'CAMPAIGN_SELECTION_REQUIRED',
        navigation: {
          canSelectCampaign: true,
          canSelectCharacter: false,
          canViewContext: false,
          canMutate: false,
          canPersistSelection: false,
          canContinue: false,
        },
        cta: { kind: 'SELECT_CAMPAIGN', label: 'Selecionar campanha' },
      },
    });
    expect(renderAuthenticatedContext(campaignSelection)).toContain('data-campaign-selection-ref');

    const authorizationError = context({
      authState: 'AUTHORIZATION_ERROR',
      player: null,
      narrativeContext: null,
      widgetContext: {
        ...context().widgetContext,
        connectedPlayer: null,
        campaigns: [],
        activeContext: null,
        sessionState: 'AUTHORIZATION_ERROR',
        navigation: {
          canSelectCampaign: false,
          canSelectCharacter: false,
          canViewContext: false,
          canMutate: false,
          canPersistSelection: false,
          canContinue: false,
        },
        cta: { kind: 'RECONNECT', label: 'Reconectar com segurança' },
      },
    });
    expect(renderAuthenticatedContext(authorizationError)).toContain('data-action="reconnect"');
    expect(renderAuthenticatedFailure('Sessão expirada')).toContain('Reconecte');
  });

  it('remounts deterministically and escapes all displayed text', () => {
    const malicious = context({
      player: { displayName: '<img src=x onerror=alert(1)>' },
      widgetContext: {
        ...context().widgetContext,
        connectedPlayer: '<img src=x onerror=alert(1)>',
      },
    });
    const first = renderAuthenticatedContext(malicious);
    const second = renderAuthenticatedContext(malicious);
    expect(second).toBe(first);
    expect(first).not.toContain('<img');
    expect(first).toContain('&lt;img');
  });

  it('renders confirmation, safe retry, conflict recovery, and Continue without mechanical controls', () => {
    const preview = context();
    preview.widgetContext.gameSession = {
      status: 'NONE',
      stateVersion: 0,
      canContinue: false,
      selection: null,
      lastAction: null,
    };
    preview.widgetContext.activeContext!.campaign.sessionVersion = 0;
    expect(renderAuthenticatedContext(preview)).toContain('data-action="confirm-selection"');

    const renderState = {
      activeView: 'SUMMARY' as const,
      view: null,
      loading: false,
      error: null,
      selectedDetail: null,
    };
    const safeRetry = renderAuthenticatedContext(preview, {
      ...renderState,
      selectionFeedback: 'Repita a mesma solicitação.',
      selectionRecovery: 'SAFE_RETRY',
    });
    expect(safeRetry).toContain('data-action="retry-selection"');
    const conflict = renderAuthenticatedContext(preview, {
      ...renderState,
      selectionFeedback: 'A seleção mudou.',
      selectionRecovery: 'RELOAD_REQUIRED',
    });
    expect(conflict).toContain('data-action="reload-context"');

    const persisted = renderAuthenticatedContext(context());
    expect(persisted).toContain('data-action="continue"');
    expect(persisted).not.toMatch(/data-action="attack|data-action="use|data-action="equip/i);
  });

  it('renders the v5 observation action and its persisted official result without exposing private data', () => {
    const playable = context();
    playable.widgetContext.navigation.canMutate = true;
    playable.widgetContext.gameSession.lastAction = {
      type: 'OBSERVE',
      status: 'RESOLVED',
      summary: 'A observação foi registrada.',
      focus: 'a porta antiga',
      occurredAt: '2026-07-27T02:00:00.000Z',
      discoveredFacts: [],
    };
    const html = renderAuthenticatedContext(playable);
    expect(html).toContain('Onde deseja concentrar sua atenção?');
    expect(html).toContain('data-action="observation-form"');
    expect(html).toContain('Observar os arredores');
    expect(html).toContain('Versão atual da sessão: 1');
    expect(html).toContain('A observação foi registrada.');
    expect(html).not.toMatch(/MASTER_ONLY|secret|uuid/i);
  });

  it('strictly parses stable selection results and rejects privileged additions', () => {
    const result = {
      status: 'SUCCESS',
      previousSessionVersion: 0,
      sessionVersion: 1,
      selection: { campaignSelectionRef, characterSelectionRef },
      canContinue: true,
      recovery: 'NONE',
      message: 'Seleção salva.',
    };
    const selectionToolResult = (structuredContent: unknown) => ({
      content: [{ type: 'text' as const, text: 'Seleção segura' }],
      structuredContent,
    });
    expect(parseAuthenticatedSelectionResult(selectionToolResult(result)))
      .toEqual(result);
    expect(() => parseAuthenticatedSelectionResult(selectionToolResult({
      ...result,
      MASTER_ONLY: 'secret',
    }))).toThrow(/contrato seguro/u);
  });

  it('strictly parses an official observation result and rejects privileged additions', () => {
    const observation = {
      action: {
        type: 'OBSERVE',
        status: 'RESOLVED',
        summary: 'A observação foi registrada.',
        focus: null,
        occurredAt: '2026-07-27T02:00:00.000Z',
      },
      continuity: { sessionVersion: 2, canContinue: true },
      discoveredFacts: [],
    };
    const observationToolResult = (structuredContent: unknown) => ({
      content: [{ type: 'text' as const, text: 'Observação oficial' }],
      structuredContent,
    });
    expect(parseAuthenticatedObservationResult(observationToolResult(observation))).toEqual(observation);
    expect(() => parseAuthenticatedObservationResult(observationToolResult({
      ...observation,
      MASTER_ONLY: 'secret',
    }))).toThrow(/contrato seguro/u);
  });
});
