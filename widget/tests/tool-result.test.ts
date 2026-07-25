import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  describeToolResultBoundary,
  GameContextToolResultError,
  normalizeToolResultEvent,
  parseGameContextToolResult,
} from '../src/tool-result.js';
import { createInitialState } from '../src/app-state.js';
import { renderApp } from '../src/render.js';

const disconnected = {
  authState: 'DISCONNECTED',
  player: null,
  resume: null,
  capabilities: { canStartNewGame: false, canContinue: false },
  environment: { fixtureMode: true, nonProduction: true },
} as const;

const connected = {
  authState: 'CONNECTED_FIXTURE',
  player: { displayName: 'Viajante da demonstração' },
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
} as const;

function toolResult(overrides: Partial<CallToolResult> = {}): CallToolResult {
  return {
    content: [{ type: 'text', text: 'Resumo compatível somente para leitura.' }],
    structuredContent: disconnected,
    ...overrides,
  };
}

function expectErrorCode(action: () => unknown, code: GameContextToolResultError['code']): void {
  try {
    action();
    throw new Error('Expected parser to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GameContextToolResultError);
    expect((error as GameContextToolResultError).code).toBe(code);
  }
}

describe('game context tool result parser', () => {
  it('extracts only structuredContent from a complete CallToolResult', () => {
    expect(parseGameContextToolResult(toolResult())).toEqual(disconnected);
  });

  it('normalizes a direct CallToolResult without an envelope', () => {
    expect(normalizeToolResultEvent(toolResult())).toEqual(toolResult());
  });

  it('normalizes the host DOM CustomEvent envelope through detail', () => {
    const event = new CustomEvent('toolresult', { detail: toolResult() });
    expect(parseGameContextToolResult(event)).toEqual(disconnected);
    expect(renderApp(createInitialState(parseGameContextToolResult(event)))).toContain('Conectar conta');
  });

  it('rejects an unrecognized envelope instead of searching nested params or result fields', () => {
    for (const envelope of [
      { params: toolResult() },
      { result: toolResult() },
      { detail: toolResult() },
      new CustomEvent('message', { detail: toolResult() }),
    ]) {
      expectErrorCode(
        () => parseGameContextToolResult(envelope),
        'UNRECOGNIZED_HOST_ENVELOPE',
      );
    }
  });

  it('does not parse textual content when structuredContent is present', () => {
    expect(parseGameContextToolResult(toolResult({
      content: [{ type: 'text', text: '{"authState":"CONNECTED_FIXTURE"}' }],
    }))).toEqual(disconnected);
  });

  it('rejects a missing structuredContent independently from a tool error', () => {
    expectErrorCode(
      () => parseGameContextToolResult(toolResult({ structuredContent: undefined })),
      'MISSING_STRUCTURED_CONTENT',
    );
  });

  it('handles a tool error before attempting to validate structuredContent', () => {
    expectErrorCode(
      () => parseGameContextToolResult(toolResult({
        isError: true,
        structuredContent: { authState: 'DISCONNECTED' },
      })),
      'TOOL_ERROR',
    );
  });

  it('rejects a schema mismatch, including additional fields', () => {
    try {
      parseGameContextToolResult(toolResult({
        structuredContent: { ...disconnected, MASTER_ONLY: 'never expose this' },
      }));
      throw new Error('Expected parser to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GameContextToolResultError);
      const contractError = error as GameContextToolResultError;
      expect(contractError.code).toBe('INVALID_STRUCTURED_CONTENT');
      expect(contractError.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'unrecognized_keys',
          receivedType: 'object',
        }),
      ]));
      expect(JSON.stringify(contractError.diagnostics)).not.toContain('never expose this');
    }
  });

  it('keeps repeated direct and event results deterministic', () => {
    const direct = parseGameContextToolResult(toolResult());
    const repeated = parseGameContextToolResult(new CustomEvent('toolresult', {
      detail: toolResult(),
    }));
    expect(createInitialState(repeated)).toEqual(createInitialState(direct));
  });

  it('normalizes CONNECTED_FIXTURE results for the same app state pipeline', () => {
    const context = parseGameContextToolResult(new CustomEvent('toolresult', {
      detail: toolResult({ structuredContent: connected }),
    }));
    const html = renderApp(createInitialState(context));
    expect(html).toContain('Continuar');
    expect(html).toContain('Novo Jogo');
  });

  it('describes only structural metadata when the boundary is invalid', () => {
    const diagnostic = describeToolResultBoundary(new CustomEvent('toolresult', {
      detail: { structuredContent: { player: { displayName: 'sensitive-value' } } },
    }));
    expect(diagnostic).toMatchObject({
      isEvent: true,
      isCustomEvent: true,
    });
    expect(diagnostic.properties).toEqual(expect.arrayContaining([
      { path: 'detail.structuredContent', present: true, type: 'object' },
    ]));
    expect(JSON.stringify(diagnostic)).not.toContain('sensitive-value');
  });
});
