import { describe, expect, it } from 'vitest';
import type { AuthenticatedContext } from '../src/authenticated-context.js';
import {
  renderAuthenticatedContext,
  renderAuthenticatedFailure,
} from '../src/authenticated-render.js';
import { parseAuthenticatedToolResult } from '../src/authenticated-tool-result.js';

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
        characters: [{
          selectionRef: characterSelectionRef,
          displayName: 'Test Adventurer',
          level: 1,
        }],
      }],
      activeContext: {
        campaign: {
          selectionRef: campaignSelectionRef,
          displayName: 'OAuth Readonly Test',
          worldName: 'OAuth Test World',
          status: 'active',
        },
        character: {
          selectionRef: characterSelectionRef,
          displayName: 'Test Adventurer',
          level: 1,
        },
        resources: [],
        readOnly: true,
      },
      sessionState: 'READ_ONLY_READY',
      navigation: {
        canSelectCampaign: false,
        canSelectCharacter: false,
        canViewContext: true,
        canMutate: false,
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
});
