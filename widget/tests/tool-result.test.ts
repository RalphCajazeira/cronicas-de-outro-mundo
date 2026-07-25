import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  GameContextToolResultError,
  parseGameContextToolResult,
} from '../src/tool-result.js';

const disconnected = {
  authState: 'DISCONNECTED',
  player: null,
  resume: null,
  capabilities: { canStartNewGame: false, canContinue: false },
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
    expectErrorCode(
      () => parseGameContextToolResult(toolResult({
        structuredContent: { ...disconnected, MASTER_ONLY: 'never expose this' },
      })),
      'INVALID_STRUCTURED_CONTENT',
    );
  });
});
