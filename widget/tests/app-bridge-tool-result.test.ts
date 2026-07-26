import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { parseGameContextToolResult } from '../src/tool-result.js';

const disconnectedResult: CallToolResult = {
  content: [{ type: 'text', text: 'Resumo textual não autoritativo.' }],
  structuredContent: {
    authState: 'DISCONNECTED',
    capabilities: { canStartNewGame: false, canContinue: false },
    environment: { fixtureMode: true, nonProduction: true },
  },
};

describe('official AppBridge tool-result lifecycle', () => {
  it('delivers notification params directly to the registered handler after initialization', async () => {
    const [appTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
    const app = new App(
      { name: 'Crônicas widget test', version: '0.1.0' },
      {},
      { strict: true },
    );
    const bridge = new AppBridge(
      null,
      { name: 'Crônicas host test', version: '0.1.0' },
      { serverTools: {} },
    );

    const received = new Promise<unknown>((resolve) => {
      app.addEventListener('toolresult', resolve);
    });
    bridge.oninitialized = () => {
      void bridge.sendToolInput({ arguments: {} });
      void bridge.sendToolResult(disconnectedResult);
    };

    await bridge.connect(bridgeTransport);
    await app.connect(appTransport);

    try {
      const input = await received;
      expect(input).toEqual(disconnectedResult);
      expect(input).not.toBeInstanceOf(Event);
      expect(parseGameContextToolResult(input)).toEqual({
        authState: 'DISCONNECTED',
        player: null,
        resume: null,
        capabilities: { canStartNewGame: false, canContinue: false },
        environment: { fixtureMode: true, nonProduction: true },
      });
    } finally {
      await app.close();
      await bridge.close();
    }
  });
});
