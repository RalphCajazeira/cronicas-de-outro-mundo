import { Buffer } from 'node:buffer';
import { EncounterOutcome } from '../../generated/prisma/client.js';
import {
  CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR,
  CORE_V1_MAX_ENCOUNTER_PARTICIPANTS,
} from '../rules/core-v1/index.js';
import { parseEncounterAdapterState, type EncounterAdapterStateV1 } from './encounter-adapter-state.js';

export const ENCOUNTER_CONSEQUENCE_SCHEMA_VERSION = 1 as const;
export const ENCOUNTER_CONSEQUENCE_MAX_UTF8_BYTES = 1_048_576;
export const ENCOUNTER_TERMINAL_EVENT_MAX_UTF8_BYTES = 32_768;
export const ENCOUNTER_MAX_PARTICIPANTS = CORE_V1_MAX_ENCOUNTER_PARTICIPANTS;
export const ENCOUNTER_MAX_EFFECTS_PER_ACTOR = CORE_V1_MAX_ACTIVE_EFFECTS_PER_ACTOR;

export type EncounterOutcomeValue = 'party_victory' | 'party_defeat' | 'stalemate' | 'cancelled';
export type EncounterActorStatusValue = 'active' | 'inactive' | 'defeated' | 'dead' | 'archived';
export type EncounterTerminalEventType =
  | 'encounter-completed' | 'encounter-defeated' | 'encounter-stalemate' | 'encounter-cancelled';

export interface EncounterConsequenceResourceState {
  readonly current: number;
  readonly maximum: number;
  readonly stateVersion: number;
}

export interface EncounterConsequenceActorState {
  readonly actorRef: string;
  readonly statusBefore: EncounterActorStatusValue;
  readonly statusAfter: EncounterActorStatusValue;
  readonly mechanicsStateVersion: { readonly before: number; readonly after: number };
  readonly inventoryStateVersion: { readonly before: number; readonly after: number };
  readonly effectsStateVersion: { readonly before: number; readonly after: number };
  readonly resources: Readonly<Record<'hp' | 'mana' | 'sp', {
    readonly before: EncounterConsequenceResourceState;
    readonly after: EncounterConsequenceResourceState;
  }>>;
}

export interface EncounterConsequenceSummaryV1 {
  readonly schemaVersion: 1;
  readonly outcome: EncounterOutcomeValue;
  readonly actors: readonly EncounterConsequenceActorState[];
  readonly removedEncounterEffects: readonly {
    readonly actorRef: string;
    readonly effectRefs: readonly string[];
  }[];
  readonly event: {
    readonly eventType: EncounterTerminalEventType;
    readonly actorRef: string | null;
  };
}

export interface EncounterTerminalEventPayloadV1 {
  readonly schemaVersion: 1;
  readonly encounterRef: string;
  readonly outcome: EncounterOutcomeValue;
  readonly affectedActorRefs: readonly string[];
  readonly defeatedActorRefs: readonly string[];
  readonly removedEncounterEffectCount: number;
}

export interface EncounterOperationResultSummary {
  readonly adapterState: EncounterAdapterStateV1;
  readonly consequencesSummary?: EncounterConsequenceSummaryV1;
}

export interface EncounterPublicConsequencesSummaryV1 {
  readonly schemaVersion: 1;
  readonly outcome: EncounterOutcomeValue;
  readonly actorChanges: readonly {
    readonly actorRef: string;
    readonly statusBefore: EncounterActorStatusValue;
    readonly statusAfter: EncounterActorStatusValue;
  }[];
  readonly removedEncounterEffects: readonly { readonly actorRef: string; readonly count: number }[];
  readonly persistentEvent: {
    readonly eventType: EncounterTerminalEventType;
    readonly actorRef?: string;
  };
}

const publicRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const effectRefPattern = /^fx_[a-z0-9]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outcomes = new Set<EncounterOutcomeValue>(['party_victory', 'party_defeat', 'stalemate', 'cancelled']);
const statuses = new Set<EncounterActorStatusValue>(['active', 'inactive', 'defeated', 'dead', 'archived']);
const eventTypes = new Set<EncounterTerminalEventType>([
  'encounter-completed', 'encounter-defeated', 'encounter-stalemate', 'encounter-cancelled',
]);

function jsonUtf8ByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Encounter JSON value is not serializable');
  return Buffer.byteLength(serialized, 'utf8');
}

function closedRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
    || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${path} must be a closed object`);
  }
  return value as Record<string, unknown>;
}

function closedOptionalRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    throw new TypeError(`${path} must be a closed object`);
  }
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError(`${path} must be a closed object`);
  }
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, maximum: number, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Object.keys(value).length !== value.length) {
    throw new TypeError(`${path} must be a dense capped array`);
  }
  return value;
}

function publicRef(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160
    || !publicRefPattern.test(value) || uuidPattern.test(value)) {
    throw new TypeError(`${path} must be a public reference`);
  }
  return value;
}

function effectRef(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length < 4 || value.length > 80 || !effectRefPattern.test(value)) {
    throw new TypeError(`${path} must be an effect reference`);
  }
  return value;
}

function safeNonNegative(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${path} must be a safe non-negative integer`);
  return value as number;
}

function positiveVersion(value: unknown, path: string): number {
  const parsed = safeNonNegative(value, path);
  if (parsed < 1) throw new TypeError(`${path} must be a positive version`);
  return parsed;
}

function orderedUniqueRefs(value: unknown, maximum: number, path: string): readonly string[] {
  const refs = denseArray(value, maximum, path).map((entry, index) => publicRef(entry, `${path}.${index}`));
  if (refs.some((ref, index) => index > 0 && (refs[index - 1] as string).localeCompare(ref) >= 0)) {
    throw new TypeError(`${path} must contain unique canonically ordered references`);
  }
  return refs;
}

function versionTransition(value: unknown, path: string) {
  const row = closedRecord(value, ['before', 'after'], path);
  const before = positiveVersion(row.before, `${path}.before`);
  const after = positiveVersion(row.after, `${path}.after`);
  if (after < before) throw new TypeError(`${path} cannot regress`);
  return { before, after };
}

function resourceState(value: unknown, path: string): EncounterConsequenceResourceState {
  const row = closedRecord(value, ['current', 'maximum', 'stateVersion'], path);
  const current = safeNonNegative(row.current, `${path}.current`);
  const maximum = safeNonNegative(row.maximum, `${path}.maximum`);
  if (current > maximum) throw new TypeError(`${path}.current exceeds maximum`);
  return { current, maximum, stateVersion: positiveVersion(row.stateVersion, `${path}.stateVersion`) };
}

function parseActor(value: unknown, path: string): EncounterConsequenceActorState {
  const row = closedRecord(value, [
    'actorRef', 'statusBefore', 'statusAfter', 'mechanicsStateVersion',
    'inventoryStateVersion', 'effectsStateVersion', 'resources',
  ], path);
  if (!statuses.has(row.statusBefore as EncounterActorStatusValue)
    || !statuses.has(row.statusAfter as EncounterActorStatusValue)) {
    throw new TypeError(`${path} has an invalid Actor status`);
  }
  if (row.statusBefore !== row.statusAfter
    && !(row.statusBefore === 'active' && row.statusAfter === 'defeated')) {
    throw new TypeError(`${path} has an invalid terminal Actor status transition`);
  }
  const resources = closedRecord(row.resources, ['hp', 'mana', 'sp'], `${path}.resources`);
  const parseResource = (key: 'hp' | 'mana' | 'sp') => {
    const transition = closedRecord(resources[key], ['before', 'after'], `${path}.resources.${key}`);
    const before = resourceState(transition.before, `${path}.resources.${key}.before`);
    const after = resourceState(transition.after, `${path}.resources.${key}.after`);
    const currentChanged = before.current !== after.current;
    if (after.current > before.current
      || after.stateVersion !== before.stateVersion + (currentChanged ? 1 : 0)) {
      throw new TypeError(`${path}.resources.${key} has an invalid terminal transition`);
    }
    return { before, after };
  };
  const inventoryStateVersion = versionTransition(row.inventoryStateVersion, `${path}.inventoryStateVersion`);
  if (inventoryStateVersion.after !== inventoryStateVersion.before) {
    throw new TypeError(`${path}.inventoryStateVersion cannot change during terminal consequences`);
  }
  return {
    actorRef: publicRef(row.actorRef, `${path}.actorRef`),
    statusBefore: row.statusBefore as EncounterActorStatusValue,
    statusAfter: row.statusAfter as EncounterActorStatusValue,
    mechanicsStateVersion: versionTransition(row.mechanicsStateVersion, `${path}.mechanicsStateVersion`),
    inventoryStateVersion,
    effectsStateVersion: versionTransition(row.effectsStateVersion, `${path}.effectsStateVersion`),
    resources: { hp: parseResource('hp'), mana: parseResource('mana'), sp: parseResource('sp') },
  };
}

export function parseEncounterConsequenceSummary(value: unknown): EncounterConsequenceSummaryV1 {
  if (jsonUtf8ByteLength(value) > ENCOUNTER_CONSEQUENCE_MAX_UTF8_BYTES) {
    throw new TypeError('Encounter consequence summary exceeds its UTF-8 byte limit');
  }
  const root = closedRecord(value, ['schemaVersion', 'outcome', 'actors', 'removedEncounterEffects', 'event'], '$');
  if (root.schemaVersion !== ENCOUNTER_CONSEQUENCE_SCHEMA_VERSION || !outcomes.has(root.outcome as EncounterOutcomeValue)) {
    throw new TypeError('Encounter consequence identity is invalid');
  }
  const actors = denseArray(root.actors, ENCOUNTER_MAX_PARTICIPANTS, '$.actors')
    .map((entry, index) => parseActor(entry, `$.actors.${index}`));
  if (actors.some((actor, index) => index > 0 && (actors[index - 1] as EncounterConsequenceActorState).actorRef.localeCompare(actor.actorRef) >= 0)) {
    throw new TypeError('Encounter consequence actors must be unique and ordered');
  }
  const actorRefs = new Set(actors.map((actor) => actor.actorRef));
  const removedEncounterEffects = denseArray(
    root.removedEncounterEffects, ENCOUNTER_MAX_PARTICIPANTS, '$.removedEncounterEffects',
  ).map((entry, index) => {
    const row = closedRecord(entry, ['actorRef', 'effectRefs'], `$.removedEncounterEffects.${index}`);
    const actorRef = publicRef(row.actorRef, `$.removedEncounterEffects.${index}.actorRef`);
    const refs = denseArray(
      row.effectRefs, ENCOUNTER_MAX_EFFECTS_PER_ACTOR, `$.removedEncounterEffects.${index}.effectRefs`,
    ).map((candidate, effectIndex) => effectRef(candidate, `$.removedEncounterEffects.${index}.effectRefs.${effectIndex}`));
    if (!actorRefs.has(actorRef) || refs.length < 1
      || refs.some((ref, refIndex) => refIndex > 0 && (refs[refIndex - 1] as string).localeCompare(ref) >= 0)) {
      throw new TypeError('Removed Encounter effects must be non-empty, unique and ordered');
    }
    return { actorRef, effectRefs: refs };
  });
  if (removedEncounterEffects.some((entry, index) => index > 0
    && (removedEncounterEffects[index - 1] as { actorRef: string }).actorRef.localeCompare(entry.actorRef) >= 0)) {
    throw new TypeError('Removed Encounter effects must be unique and ordered by Actor');
  }
  const removedActorRefs = new Set(removedEncounterEffects.map((entry) => entry.actorRef));
  for (const actor of actors) {
    const versionIncrement = removedActorRefs.has(actor.actorRef) ? 1 : 0;
    if (actor.effectsStateVersion.after !== actor.effectsStateVersion.before + versionIncrement
      || actor.mechanicsStateVersion.after !== actor.mechanicsStateVersion.before + versionIncrement) {
      throw new TypeError('Encounter consequence versions do not match effect cleanup');
    }
    if (versionIncrement === 0 && (['hp', 'mana', 'sp'] as const).some((resource) => {
      const transition = actor.resources[resource];
      return transition.before.current !== transition.after.current
        || transition.before.maximum !== transition.after.maximum;
    })) {
      throw new TypeError('Encounter consequence resources changed without effect cleanup');
    }
  }
  const event = closedRecord(root.event, ['eventType', 'actorRef'], '$.event');
  if (!eventTypes.has(event.eventType as EncounterTerminalEventType)
    || (event.actorRef !== null && !actorRefs.has(publicRef(event.actorRef, '$.event.actorRef')))) {
    throw new TypeError('Encounter consequence event is invalid');
  }
  const expectedEvent: Readonly<Record<EncounterOutcomeValue, EncounterTerminalEventType>> = {
    party_victory: 'encounter-completed', party_defeat: 'encounter-defeated',
    stalemate: 'encounter-stalemate', cancelled: 'encounter-cancelled',
  };
  if (event.eventType !== expectedEvent[root.outcome as EncounterOutcomeValue]) {
    throw new TypeError('Encounter consequence event does not match outcome');
  }
  return structuredClone(value) as EncounterConsequenceSummaryV1;
}

export function parseEncounterTerminalEventPayload(value: unknown): EncounterTerminalEventPayloadV1 {
  if (jsonUtf8ByteLength(value) > ENCOUNTER_TERMINAL_EVENT_MAX_UTF8_BYTES) {
    throw new TypeError('Encounter terminal event payload exceeds its UTF-8 byte limit');
  }
  const root = closedRecord(value, [
    'schemaVersion', 'encounterRef', 'outcome', 'affectedActorRefs',
    'defeatedActorRefs', 'removedEncounterEffectCount',
  ], '$');
  if (root.schemaVersion !== 1 || !outcomes.has(root.outcome as EncounterOutcomeValue)) {
    throw new TypeError('Encounter terminal event identity is invalid');
  }
  const affectedActorRefs = orderedUniqueRefs(root.affectedActorRefs, ENCOUNTER_MAX_PARTICIPANTS, '$.affectedActorRefs');
  const defeatedActorRefs = orderedUniqueRefs(root.defeatedActorRefs, ENCOUNTER_MAX_PARTICIPANTS, '$.defeatedActorRefs');
  if (defeatedActorRefs.some((ref) => !affectedActorRefs.includes(ref))) {
    throw new TypeError('Defeated Actors must belong to the affected Actor set');
  }
  const removedEncounterEffectCount = safeNonNegative(root.removedEncounterEffectCount, '$.removedEncounterEffectCount');
  if (removedEncounterEffectCount > ENCOUNTER_MAX_PARTICIPANTS * ENCOUNTER_MAX_EFFECTS_PER_ACTOR) {
    throw new TypeError('Removed Encounter effect count exceeds its cap');
  }
  return {
    schemaVersion: 1,
    encounterRef: publicRef(root.encounterRef, '$.encounterRef'),
    outcome: root.outcome as EncounterOutcomeValue,
    affectedActorRefs,
    defeatedActorRefs,
    removedEncounterEffectCount,
  };
}

export function parseEncounterOperationResultSummary(value: unknown): EncounterOperationResultSummary {
  const root = closedOptionalRecord(value, ['adapterState'], ['consequencesSummary'], '$');
  const adapterState = parseEncounterAdapterState(root.adapterState);
  return {
    adapterState,
    ...(root.consequencesSummary === undefined ? {} : {
      consequencesSummary: parseEncounterConsequenceSummary(root.consequencesSummary),
    }),
  };
}

export function databaseEncounterOutcome(outcome: EncounterOutcomeValue): EncounterOutcome {
  return {
    party_victory: EncounterOutcome.PARTY_VICTORY,
    party_defeat: EncounterOutcome.PARTY_DEFEAT,
    stalemate: EncounterOutcome.STALEMATE,
    cancelled: EncounterOutcome.CANCELLED,
  }[outcome];
}

export function encounterTerminalEventIdempotencyKey(encounterId: string): string {
  return `encounter-outcome:${encounterId}:v1`;
}

export function publicEncounterConsequencesSummary(
  summary: EncounterConsequenceSummaryV1,
): EncounterPublicConsequencesSummaryV1 {
  return {
    schemaVersion: 1,
    outcome: summary.outcome,
    actorChanges: summary.actors
      .filter((actor) => actor.statusBefore !== actor.statusAfter)
      .map((actor) => ({
        actorRef: actor.actorRef,
        statusBefore: actor.statusBefore,
        statusAfter: actor.statusAfter,
      })),
    removedEncounterEffects: summary.removedEncounterEffects.map((entry) => ({
      actorRef: entry.actorRef,
      count: entry.effectRefs.length,
    })),
    persistentEvent: {
      eventType: summary.event.eventType,
      ...(summary.event.actorRef === null ? {} : { actorRef: summary.event.actorRef }),
    },
  };
}

export function parseEncounterPublicConsequencesSummary(
  value: unknown,
  participantRefs: ReadonlySet<string>,
): EncounterPublicConsequencesSummaryV1 {
  const root = closedRecord(
    value, ['schemaVersion', 'outcome', 'actorChanges', 'removedEncounterEffects', 'persistentEvent'], '$.consequencesSummary',
  );
  if (root.schemaVersion !== 1 || !outcomes.has(root.outcome as EncounterOutcomeValue)) {
    throw new TypeError('Public Encounter consequence identity is invalid');
  }
  const actorChanges = denseArray(root.actorChanges, ENCOUNTER_MAX_PARTICIPANTS, '$.consequencesSummary.actorChanges')
    .map((entry, index) => {
      const row = closedRecord(
        entry, ['actorRef', 'statusBefore', 'statusAfter'], `$.consequencesSummary.actorChanges.${index}`,
      );
      const actorRef = publicRef(row.actorRef, `$.consequencesSummary.actorChanges.${index}.actorRef`);
      if (!participantRefs.has(actorRef) || row.statusBefore !== 'active' || row.statusAfter !== 'defeated') {
        throw new TypeError('Public Encounter Actor change is invalid');
      }
      return {
        actorRef,
        statusBefore: row.statusBefore,
        statusAfter: row.statusAfter,
      };
    });
  if (actorChanges.some((entry, index) => index > 0
    && (actorChanges[index - 1] as { actorRef: string }).actorRef.localeCompare(entry.actorRef) >= 0)) {
    throw new TypeError('Public Encounter Actor changes must be unique and ordered');
  }
  const removedEncounterEffects = denseArray(
    root.removedEncounterEffects, ENCOUNTER_MAX_PARTICIPANTS, '$.consequencesSummary.removedEncounterEffects',
  ).map((entry, index) => {
    const row = closedRecord(entry, ['actorRef', 'count'], `$.consequencesSummary.removedEncounterEffects.${index}`);
    const actorRef = publicRef(row.actorRef, `$.consequencesSummary.removedEncounterEffects.${index}.actorRef`);
    const count = safeNonNegative(row.count, `$.consequencesSummary.removedEncounterEffects.${index}.count`);
    if (!participantRefs.has(actorRef) || count < 1 || count > ENCOUNTER_MAX_EFFECTS_PER_ACTOR) {
      throw new TypeError('Public removed Encounter effect count is invalid');
    }
    return { actorRef, count };
  });
  if (removedEncounterEffects.some((entry, index) => index > 0
    && (removedEncounterEffects[index - 1] as { actorRef: string }).actorRef.localeCompare(entry.actorRef) >= 0)) {
    throw new TypeError('Public removed Encounter effects must be unique and ordered');
  }
  const persistentEvent = closedOptionalRecord(
    root.persistentEvent, ['eventType'], ['actorRef'], '$.consequencesSummary.persistentEvent',
  );
  if (!eventTypes.has(persistentEvent.eventType as EncounterTerminalEventType)
    || persistentEvent.eventType !== ({
      party_victory: 'encounter-completed', party_defeat: 'encounter-defeated',
      stalemate: 'encounter-stalemate', cancelled: 'encounter-cancelled',
    } as const)[root.outcome as EncounterOutcomeValue]
    || (persistentEvent.actorRef !== undefined
      && !participantRefs.has(publicRef(persistentEvent.actorRef, '$.consequencesSummary.persistentEvent.actorRef')))) {
    throw new TypeError('Public Encounter event is invalid');
  }
  return structuredClone(value) as EncounterPublicConsequencesSummaryV1;
}
