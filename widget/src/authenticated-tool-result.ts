import { authenticatedContextSchema, type AuthenticatedContext } from './authenticated-context.js';
import { normalizeToolResultEvent } from './tool-result.js';
import {
  authenticatedCharacterViewSchema,
  type AuthenticatedCharacterView,
} from './authenticated-character-view.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreHostOmittedNulls(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.widgetContext)) return input;
  const authState = input.authState;
  const sessionState = input.widgetContext.sessionState;
  if (![
    'AUTHENTICATED_NO_PLAYER',
    'AUTHENTICATED',
    'AUTHORIZATION_ERROR',
  ].includes(String(authState))) return input;

  const restorePlayer = authState !== 'AUTHENTICATED' && !('player' in input);
  const restoreNarrative = !('narrativeContext' in input);
  const restoreActive = sessionState !== 'READ_ONLY_READY'
    && sessionState !== 'CHARACTER_SELECTION_REQUIRED'
    && !('activeContext' in input.widgetContext);
  const restoreConnectedPlayer = (sessionState === 'NO_PLAYER' || sessionState === 'AUTHORIZATION_ERROR')
    && !('connectedPlayer' in input.widgetContext);
  return {
    ...input,
    ...(restorePlayer ? { player: null } : {}),
    ...(restoreNarrative ? { narrativeContext: null } : {}),
    widgetContext: {
      ...input.widgetContext,
      ...(restoreActive ? { activeContext: null } : {}),
      ...(restoreConnectedPlayer ? { connectedPlayer: null } : {}),
    },
  };
}

export function parseAuthenticatedToolResult(input: unknown): AuthenticatedContext {
  const result = normalizeToolResultEvent(input);
  if (result.isError === true) throw new Error('A leitura autenticada não pôde ser concluída.');
  if (result.structuredContent === undefined) {
    throw new Error('O contexto autenticado estruturado não foi recebido.');
  }
  const parsed = authenticatedContextSchema.safeParse(
    restoreHostOmittedNulls(result.structuredContent),
  );
  if (!parsed.success) throw new Error('O contexto autenticado não corresponde ao contrato seguro.');
  return parsed.data;
}

export function parseAuthenticatedCharacterViewResult(input: unknown): AuthenticatedCharacterView {
  const result = normalizeToolResultEvent(input);
  if (result.isError === true) throw new Error('A seção autenticada não pôde ser concluída.');
  if (result.structuredContent === undefined) {
    throw new Error('A seção autenticada estruturada não foi recebida.');
  }
  const parsed = authenticatedCharacterViewSchema.safeParse(result.structuredContent);
  if (!parsed.success) throw new Error('A seção autenticada não corresponde ao contrato seguro.');
  return parsed.data;
}
