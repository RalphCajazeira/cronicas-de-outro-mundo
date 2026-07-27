import { z } from 'zod';
import { authenticatedContextSchema, type AuthenticatedContext } from './authenticated-context.js';
import { normalizeToolResultEvent } from './tool-result.js';
import {
  authenticatedCharacterViewSchema,
  type AuthenticatedCharacterView,
} from './authenticated-character-view.js';

const selectionRefSchema = z.string().regex(/^sel_[A-Za-z0-9_-]{43}$/u);
export const authenticatedSelectionResultSchema = z.object({
  status: z.enum(['SUCCESS', 'CONFLICT', 'SAFE_RETRY', 'REJECTED']),
  previousSessionVersion: z.number().int().min(0),
  sessionVersion: z.number().int().min(0),
  selection: z.object({
    campaignSelectionRef: selectionRefSchema,
    characterSelectionRef: selectionRefSchema,
  }).strict().nullable(),
  canContinue: z.boolean(),
  recovery: z.enum(['NONE', 'RELOAD_REQUIRED', 'SAFE_RETRY', 'SELECT_AGAIN']),
  message: z.string().min(1).max(200),
}).strict();
export type AuthenticatedSelectionResult = z.infer<typeof authenticatedSelectionResultSchema>;

export const authenticatedObservationResultSchema = z.object({
  action: z.object({
    type: z.literal('OBSERVE'),
    status: z.enum(['RESOLVED', 'CONFLICT', 'BLOCKED', 'REJECTED']),
    summary: z.string().min(1).max(500),
    focus: z.string().min(1).max(300).nullable(),
    occurredAt: z.string().datetime(),
  }).strict(),
  continuity: z.object({
    sessionVersion: z.number().int().min(0),
    canContinue: z.boolean(),
  }).strict(),
  discoveredFacts: z.array(z.string().min(1).max(240)).max(15),
}).strict();
export type AuthenticatedObservationResult = z.infer<typeof authenticatedObservationResultSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreMissingNulls(
  input: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return keys.reduce<Record<string, unknown>>(
    (restored, key) => key in restored ? restored : { ...restored, [key]: null },
    input,
  );
}

function restoreNullableResources(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((resource) => isRecord(resource)
    ? restoreMissingNulls(resource, ['maximum'])
    : resource);
}

function restoreAuthenticatedContextNulls(input: unknown): unknown {
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
  const narrativeContext = isRecord(input.narrativeContext)
    ? {
        ...restoreMissingNulls(input.narrativeContext, [
          'characterName',
          'publicLocation',
          'pendingDecision',
        ]),
        criticalResources: restoreNullableResources(input.narrativeContext.criticalResources),
      }
    : input.narrativeContext;
  const activeContext = isRecord(input.widgetContext.activeContext)
    ? {
        ...restoreMissingNulls(input.widgetContext.activeContext, ['character']),
        resources: restoreNullableResources(input.widgetContext.activeContext.resources),
      }
    : input.widgetContext.activeContext;
  const gameSession = isRecord(input.widgetContext.gameSession)
    ? restoreMissingNulls(input.widgetContext.gameSession, ['selection', 'lastAction'])
    : input.widgetContext.gameSession;
  return {
    ...input,
    ...(restorePlayer ? { player: null } : {}),
    ...(restoreNarrative ? { narrativeContext: null } : { narrativeContext }),
    widgetContext: {
      ...input.widgetContext,
      ...(restoreActive ? { activeContext: null } : { activeContext }),
      ...(restoreConnectedPlayer ? { connectedPlayer: null } : {}),
      gameSession,
    },
  };
}

function restoreIdentityNulls(input: unknown): unknown {
  return isRecord(input)
    ? restoreMissingNulls(input, ['species', 'className', 'role', 'description'])
    : input;
}

function restoreActionNulls(input: unknown): unknown {
  return isRecord(input) ? restoreMissingNulls(input, ['actionProfile']) : input;
}

function restorePageNulls(input: unknown): unknown {
  return isRecord(input) ? restoreMissingNulls(input, ['nextCursor']) : input;
}

function restoreAuthenticatedViewNulls(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.data)) return input;
  const data = input.data;

  if (input.view === 'SUMMARY') {
    return { ...input, data: { ...data, identity: restoreIdentityNulls(data.identity) } };
  }
  if (input.view === 'SHEET') {
    return {
      ...input,
      data: {
        ...data,
        identity: restoreIdentityNulls(data.identity),
        activeStatusEffects: Array.isArray(data.activeStatusEffects)
          ? data.activeStatusEffects.map((effect) => isRecord(effect)
            ? restoreMissingNulls(effect, ['description'])
            : effect)
          : data.activeStatusEffects,
      },
    };
  }
  if (input.view === 'INVENTORY') {
    return {
      ...input,
      data: {
        ...data,
        items: Array.isArray(data.items)
          ? data.items.map((item) => isRecord(item)
            ? restoreMissingNulls(item, ['description'])
            : item)
          : data.items,
        page: restorePageNulls(data.page),
      },
    };
  }
  if (input.view === 'EQUIPMENT') {
    return {
      ...input,
      data: {
        ...data,
        slots: Array.isArray(data.slots)
          ? data.slots.map((slot) => {
              if (!isRecord(slot)) return slot;
              const restoredSlot = restoreMissingNulls(slot, ['item']);
              if (!isRecord(restoredSlot.item)) return restoredSlot;
              const restoredItem = restoreMissingNulls(restoredSlot.item, [
                'description',
                'action',
              ]);
              return {
                ...restoredSlot,
                item: {
                  ...restoredItem,
                  action: restoreActionNulls(restoredItem.action),
                },
              };
            })
          : data.slots,
      },
    };
  }
  if (input.view === 'ABILITIES') {
    return {
      ...input,
      data: {
        ...data,
        abilities: Array.isArray(data.abilities)
          ? data.abilities.map((ability) => {
              if (!isRecord(ability)) return ability;
              return {
                ...restoreMissingNulls(ability, ['description']),
                action: restoreActionNulls(ability.action),
              };
            })
          : data.abilities,
        page: restorePageNulls(data.page),
      },
    };
  }
  return input;
}

export function parseAuthenticatedToolResult(input: unknown): AuthenticatedContext {
  const result = normalizeToolResultEvent(input);
  if (result.isError === true) throw new Error('A leitura autenticada não pôde ser concluída.');
  if (result.structuredContent === undefined) {
    throw new Error('O contexto autenticado estruturado não foi recebido.');
  }
  const parsed = authenticatedContextSchema.safeParse(
    restoreAuthenticatedContextNulls(result.structuredContent),
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
  const parsed = authenticatedCharacterViewSchema.safeParse(
    restoreAuthenticatedViewNulls(result.structuredContent),
  );
  if (!parsed.success) throw new Error('A seção autenticada não corresponde ao contrato seguro.');
  return parsed.data;
}

export function parseAuthenticatedSelectionResult(input: unknown): AuthenticatedSelectionResult {
  const result = normalizeToolResultEvent(input);
  if (result.structuredContent === undefined) {
    throw new Error('O resultado da seleção não foi recebido.');
  }
  const parsed = authenticatedSelectionResultSchema.safeParse(result.structuredContent);
  if (!parsed.success) throw new Error('O resultado da seleção não corresponde ao contrato seguro.');
  return parsed.data;
}

export function parseAuthenticatedObservationResult(input: unknown): AuthenticatedObservationResult {
  const result = normalizeToolResultEvent(input);
  if (result.structuredContent === undefined) {
    throw new Error('O resultado da observação não foi recebido.');
  }
  const parsed = authenticatedObservationResultSchema.safeParse(result.structuredContent);
  if (!parsed.success) throw new Error('O resultado da observação não corresponde ao contrato seguro.');
  return parsed.data;
}
