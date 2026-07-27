import { describe, expect, it, vi } from 'vitest';
import {
  callCompatibilityTool,
  connectWithTimeout,
  createInitialContextRefreshGate,
  readCompatibilityToolOutput,
  readToolResultNotification,
  sendCompatibilityMessage,
} from '../src/host-compatibility.js';

describe('ChatGPT host compatibility bridge', () => {
  it('accepts only the standard tool-result notification from the expected parent', () => {
    const parent = {} as MessageEventSource;
    const result = {
      content: [{ type: 'text', text: 'Resumo seguro' }],
      structuredContent: { authState: 'AUTHENTICATED' },
    };

    expect(readToolResultNotification({
      source: parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: result,
      },
    }, parent)).toEqual(result);
    expect(readToolResultNotification({
      source: {} as MessageEventSource,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: result,
      },
    }, parent)).toBeUndefined();
    expect(readToolResultNotification({
      source: parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input',
        params: result,
      },
    }, parent)).toBeUndefined();
  });

  it('wraps compatibility toolOutput in the same strict result envelope', () => {
    const structuredContent = { authState: 'AUTHENTICATED' };
    expect(readCompatibilityToolOutput({
      openai: { toolOutput: structuredContent },
    })).toEqual({
      content: [],
      structuredContent,
    });
    expect(readCompatibilityToolOutput({})).toBeUndefined();
  });

  it('prefers the complete MCP result preserved in ChatGPT response metadata', () => {
    const result = {
      content: [{ type: 'text', text: 'Resumo seguro' }],
      structuredContent: { authState: 'AUTHENTICATED' },
    };
    expect(readCompatibilityToolOutput({
      openai: {
        toolOutput: { authState: 'OUTDATED' },
        toolResponseMetadata: { mcp_tool_result: result },
      },
    })).toBe(result);
  });

  it('bounds a host connection that never completes', async () => {
    await expect(connectWithTimeout(new Promise(() => undefined), 1))
      .rejects.toThrow(/timed out/u);
    await expect(connectWithTimeout(Promise.resolve(), 10)).resolves.toBeUndefined();
  });

  it('requests one backend refresh after a historical widget result is mounted', () => {
    const shouldRefresh = createInitialContextRefreshGate();
    expect(shouldRefresh()).toBe(true);
    expect(shouldRefresh()).toBe(false);
    expect(shouldRefresh()).toBe(false);
  });

  it('delegates lazy tool calls without changing their name or arguments', async () => {
    const result = { structuredContent: { view: 'SUMMARY' } };
    const callTool = vi.fn().mockResolvedValue(result);
    const argumentsValue = {
      view: 'SUMMARY',
      campaignSelectionRef: `sel_${'a'.repeat(43)}`,
      characterSelectionRef: `sel_${'b'.repeat(43)}`,
    };

    await expect(callCompatibilityTool(
      { openai: { callTool } },
      'loadAuthenticatedCharacterView',
      argumentsValue,
    )).resolves.toBe(result);
    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith('loadAuthenticatedCharacterView', argumentsValue);
  });

  it('fails closed when the compatibility call bridge is unavailable', async () => {
    await expect(callCompatibilityTool(
      {},
      'loadAuthenticatedCharacterView',
      { view: 'SUMMARY' },
    )).rejects.toThrow(/unavailable/u);
  });

  it('sends narrative text through the ChatGPT compatibility alias', async () => {
    const sendFollowUpMessage = vi.fn().mockResolvedValue({ isError: false });
    await expect(sendCompatibilityMessage(
      { openai: { sendFollowUpMessage } },
      'Observar os arredores sem agir.',
    )).resolves.toEqual({ isError: false });
    expect(sendFollowUpMessage).toHaveBeenCalledWith({
      prompt: 'Observar os arredores sem agir.',
      scrollToBottom: true,
    });
  });
});
