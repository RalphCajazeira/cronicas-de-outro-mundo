import { describe, expect, it } from 'vitest';
import { isExtensionAuthStateChangedEvent, isExtensionMessage } from '../src/shared/messages.js';

describe('extension message contracts', () => {
  it('accepts the declared internal commands only', () => {
    expect(isExtensionMessage({ type: 'OPEN_OVERLAY' })).toBe(true);
    expect(isExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: { activeTab: 'inventory' } })).toBe(true);
    expect(isExtensionMessage({ type: 'OPEN_PAGE', extra: true })).toBe(false);
    expect(isExtensionMessage({ type: 'SAVE_PREFERENCES', preferences: [] })).toBe(false);
    expect(isExtensionMessage({ type: 'READ_CHAT' })).toBe(false);
    expect(isExtensionMessage({ type: 'AUTH_LOGIN', accessToken: 'forbidden' })).toBe(false);
  });

  it('permits only the public auth projection in session-change broadcasts', () => {
    expect(isExtensionAuthStateChangedEvent({ type: 'AUTH_STATE_CHANGED', auth: { status: 'signed_out' } })).toBe(true);
    expect(isExtensionAuthStateChangedEvent({ type: 'AUTH_STATE_CHANGED', auth: { status: 'authenticated', user: { displayName: 'Aventureira' } } })).toBe(true);
    expect(isExtensionAuthStateChangedEvent({ type: 'AUTH_STATE_CHANGED', auth: { status: 'authenticated', user: { displayName: 'Aventureira' }, accessToken: 'forbidden' } })).toBe(false);
  });
});
