import type { ExtensionPreferences } from './types.js';

export type ExtensionMessage =
  | { readonly type: 'OPEN_OVERLAY' }
  | { readonly type: 'CLOSE_OVERLAY' }
  | { readonly type: 'MINIMIZE' }
  | { readonly type: 'OPEN_PAGE' }
  | { readonly type: 'GET_PREFERENCES' }
  | { readonly type: 'SAVE_PREFERENCES'; readonly preferences: Partial<ExtensionPreferences> }
  | { readonly type: 'PING' };

export type ExtensionResponse =
  | { readonly ok: true; readonly preferences?: ExtensionPreferences; readonly pong?: true }
  | { readonly ok: false; readonly error: 'INVALID_MESSAGE' | 'UNAVAILABLE' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (['OPEN_OVERLAY', 'CLOSE_OVERLAY', 'MINIMIZE', 'OPEN_PAGE', 'GET_PREFERENCES', 'PING'].includes(value.type)) {
    return onlyKeys(value, ['type']);
  }
  return value.type === 'SAVE_PREFERENCES'
    && onlyKeys(value, ['type', 'preferences'])
    && isRecord(value.preferences);
}

export function sendExtensionMessage(message: ExtensionMessage): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage(message);
}
