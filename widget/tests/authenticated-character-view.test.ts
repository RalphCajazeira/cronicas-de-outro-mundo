import { describe, expect, it } from 'vitest';
import type { AuthenticatedContext } from '../src/authenticated-context.js';
import type { AuthenticatedCharacterView } from '../src/authenticated-character-view.js';
import { renderAuthenticatedContext } from '../src/authenticated-render.js';
import {
  parseAuthenticatedCharacterViewResult,
  parseAuthenticatedToolResult,
} from '../src/authenticated-tool-result.js';

const campaignSelectionRef = `sel_${'a'.repeat(43)}`;
const characterSelectionRef = `sel_${'b'.repeat(43)}`;

const context: AuthenticatedContext = {
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
        level: 3,
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
        level: 3,
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
    cta: { kind: 'VIEW_CONTEXT', label: 'Contexto somente leitura' },
  },
  environment: {
    appEnvironment: 'staging',
    runtimeMode: 'production',
    syntheticAccount: true,
  },
};

const summary: AuthenticatedCharacterView = {
  view: 'SUMMARY',
  readOnly: true,
  data: {
    identity: {
      name: 'Test Adventurer',
      species: 'Humana',
      className: 'Exploradora',
      role: null,
      description: 'Personagem sintética.',
      level: 3,
      status: 'active',
      campaignName: 'OAuth Readonly Test',
      worldName: 'OAuth Test World',
    },
    resources: [
      { code: 'hp', current: 30, maximum: 40 },
      { code: 'mana', current: 20, maximum: 25 },
      { code: 'sp', current: 18, maximum: 22 },
    ],
    activeStatusCount: 1,
    continuitySummary: 'Nenhum checkpoint narrativo público persistido.',
    availableViews: ['SUMMARY', 'SHEET', 'INVENTORY', 'EQUIPMENT', 'ABILITIES'],
  },
};

const inventory: AuthenticatedCharacterView = {
  view: 'INVENTORY',
  readOnly: true,
  data: {
    currency: { code: 'gold', label: 'Ouro', amount: 42 },
    weight: { carried: 2, capacity: 50, state: 'normal' },
    items: [{
      name: '<img src=x onerror=alert(1)>',
      description: 'Item sintético.',
      category: 'consumable',
      quantity: 2,
      unitWeight: 1,
      totalWeight: 2,
      stackable: true,
      equipable: false,
      consumable: true,
      equipped: false,
      equippedSlots: [],
      state: 'available',
    }],
    page: {
      nextCursor: `cur_${'c'.repeat(43)}`,
      itemCount: 21,
      pageSize: 20,
    },
    unavailable: [{
      code: 'quality',
      label: 'Qualidade por instância',
      reason: 'NOT_PERSISTED_IN_CURRENT_VERSION',
    }],
  },
};

function toolResult(structuredContent: unknown) {
  return {
    content: [{ type: 'text' as const, text: 'Seção segura' }],
    structuredContent,
  };
}

describe('authenticated character widget v2', () => {
  it('restores nullable context fields omitted by the ChatGPT host before strict parsing', () => {
    const narrativeContext = context.narrativeContext!;
    const {
      publicLocation: _publicLocation,
      pendingDecision: _pendingDecision,
      ...hostNarrativeContext
    } = narrativeContext;
    const hostContext = {
      ...context,
      narrativeContext: hostNarrativeContext,
    };

    expect(parseAuthenticatedToolResult(toolResult(hostContext))).toEqual(context);
  });

  it('parses the strict view contract and rejects extra privileged fields', () => {
    expect(parseAuthenticatedCharacterViewResult(toolResult(summary))).toEqual(summary);
    expect(() => parseAuthenticatedCharacterViewResult(toolResult({
      ...summary,
      MASTER_ONLY: 'secret',
    } as AuthenticatedCharacterView))).toThrow(/contrato seguro/u);
  });

  it('restores nullable view fields omitted by the ChatGPT host without relaxing the schema', () => {
    const { role: _role, ...hostIdentity } = summary.data.identity;
    const hostSummary = {
      ...summary,
      data: {
        ...summary.data,
        identity: hostIdentity,
      },
    };
    expect(parseAuthenticatedCharacterViewResult(toolResult(hostSummary))).toEqual(summary);
  });

  it('renders all lazy tabs and the authorized summary without mutation controls', () => {
    const html = renderAuthenticatedContext(context, {
      activeView: 'SUMMARY',
      view: summary,
      loading: false,
      error: null,
      selectedDetail: null,
    });

    expect(html).toContain('Resumo');
    expect(html).toContain('Ficha');
    expect(html).toContain('Inventário');
    expect(html).toContain('Equipamento');
    expect(html).toContain('Habilidades');
    expect(html).toContain('30 / 40');
    expect(html).not.toMatch(/data-action="equip|data-action="use|data-action="attack/i);
  });

  it('escapes item content, exposes pagination, and renders an explicit unavailable marker', () => {
    const html = renderAuthenticatedContext(context, {
      activeView: 'INVENTORY',
      view: inventory,
      loading: false,
      error: null,
      selectedDetail: 'inventory-0',
    });

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('data-action="load-more"');
    expect(html).toContain('Qualidade por instância');
    expect(html).toContain('Ainda não persistido nesta versão');
  });

  it('renders bounded loading and retry states without discarding the current context', () => {
    expect(renderAuthenticatedContext(context, {
      activeView: 'SHEET',
      view: null,
      loading: true,
      error: null,
      selectedDetail: null,
    })).toContain('Carregando seção autorizada');
    expect(renderAuthenticatedContext(context, {
      activeView: 'SHEET',
      view: null,
      loading: false,
      error: 'Falha segura',
      selectedDetail: null,
    })).toContain('data-action="retry"');
  });

  it('renders a non-mechanical narrative composer with quick choices and safe status', () => {
    const html = renderAuthenticatedContext(context, {
      activeView: 'SUMMARY',
      view: summary,
      loading: false,
      error: null,
      selectedDetail: null,
      narrativeComposer: {
        draft: '<ação livre>',
        sending: false,
        error: null,
      },
    });
    expect(html).toContain('Descreva sua ação...');
    expect(html).toContain('data-action="narrative-form"');
    expect(html).toContain('data-action="quick-choice"');
    expect(html).toContain('&lt;ação livre&gt;');
    expect(html).not.toContain('<ação livre>');
    expect(html).toContain('Nenhuma mutação mecânica');

    const sending = renderAuthenticatedContext(context, {
      activeView: 'SUMMARY',
      view: summary,
      loading: false,
      error: null,
      selectedDetail: null,
      narrativeComposer: {
        draft: 'Observar.',
        sending: true,
        error: null,
      },
    });
    expect(sending).toContain('Enviando para a conversa');
    expect(sending).toContain('disabled');
  });
});
