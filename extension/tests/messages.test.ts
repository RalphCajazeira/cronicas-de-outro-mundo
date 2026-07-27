import { describe, expect, it } from 'vitest';
import { isExtensionMessage } from '../src/shared/messages.js';

describe('extension message contracts', () => {
  it('accepts the declared internal commands only', () => {
    expect(isExtensionMessage({ type: 'OPEN_OVERLAY' })).toBe(true);
    expect(isExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: { activeTab: 'inventory' } })).toBe(true);
    expect(isExtensionMessage({ type: 'OPEN_PAGE', extra: true })).toBe(false);
    expect(isExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: [] })).toBe(false);
    expect(isExtensionMessage({ type: 'READ_CHAT' })).toBe(false);
  });
});
