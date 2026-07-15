export const ENCOUNTER_ADAPTER_STATE_SCHEMA_VERSION = 1 as const;
const MAX_PARTICIPANTS = 64;
const stableRefPattern = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EncounterAdapterParticipantStateV1 {
  readonly actorRef: string;
  readonly mechanicsStateVersion: number;
  readonly inventoryStateVersion: number;
  readonly effectsStateVersion: number;
  readonly resourceStateVersions: {
    readonly hp: number;
    readonly mana: number;
    readonly sp: number;
  };
}

export interface EncounterAdapterStateV1 {
  readonly schemaVersion: typeof ENCOUNTER_ADAPTER_STATE_SCHEMA_VERSION;
  readonly participants: readonly EncounterAdapterParticipantStateV1[];
}

type PlainRecord = Record<string, unknown>;

function record(value: unknown, path: string): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as PlainRecord;
}

function exact(value: unknown, keys: readonly string[], path: string): PlainRecord {
  const parsed = record(value, path);
  if (Object.keys(parsed).length !== keys.length
    || keys.some((key) => !Object.hasOwn(parsed, key))) {
    throw new TypeError(`${path} must be a closed adapterState object`);
  }
  return parsed;
}

function version(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${path} must be a positive state version`);
  return value as number;
}

export function parseEncounterAdapterState(value: unknown): EncounterAdapterStateV1 {
  const root = exact(value, ['schemaVersion', 'participants'], '$.adapterState');
  if (root.schemaVersion !== ENCOUNTER_ADAPTER_STATE_SCHEMA_VERSION || !Array.isArray(root.participants)) {
    throw new TypeError('adapterState schema is invalid');
  }
  if (root.participants.length > MAX_PARTICIPANTS
    || Object.keys(root.participants).length !== root.participants.length) {
    throw new TypeError('adapterState participants must be a bounded dense array');
  }
  const refs = new Set<string>();
  const participants = root.participants.map((entry, index) => {
    const path = `$.adapterState.participants.${index}`;
    const participant = exact(entry, [
      'actorRef', 'mechanicsStateVersion', 'inventoryStateVersion', 'effectsStateVersion',
      'resourceStateVersions',
    ], path);
    if (typeof participant.actorRef !== 'string' || participant.actorRef.length < 1 || participant.actorRef.length > 160
      || !stableRefPattern.test(participant.actorRef) || uuidPattern.test(participant.actorRef)
      || refs.has(participant.actorRef)) {
      throw new TypeError(`${path}.actorRef is invalid or duplicated`);
    }
    refs.add(participant.actorRef);
    const resources = exact(participant.resourceStateVersions, ['hp', 'mana', 'sp'], `${path}.resourceStateVersions`);
    return {
      actorRef: participant.actorRef,
      mechanicsStateVersion: version(participant.mechanicsStateVersion, `${path}.mechanicsStateVersion`),
      inventoryStateVersion: version(participant.inventoryStateVersion, `${path}.inventoryStateVersion`),
      effectsStateVersion: version(participant.effectsStateVersion, `${path}.effectsStateVersion`),
      resourceStateVersions: {
        hp: version(resources.hp, `${path}.resourceStateVersions.hp`),
        mana: version(resources.mana, `${path}.resourceStateVersions.mana`),
        sp: version(resources.sp, `${path}.resourceStateVersions.sp`),
      },
    };
  });
  const sorted = [...participants].sort((left, right) => left.actorRef.localeCompare(right.actorRef));
  if (participants.some((participant, index) => participant.actorRef !== sorted[index]?.actorRef)) {
    throw new TypeError('adapterState participants must be ordered by actorRef');
  }
  return { schemaVersion: ENCOUNTER_ADAPTER_STATE_SCHEMA_VERSION, participants };
}

export function createEncounterAdapterState(
  participants: readonly EncounterAdapterParticipantStateV1[],
): EncounterAdapterStateV1 {
  return parseEncounterAdapterState({
    schemaVersion: ENCOUNTER_ADAPTER_STATE_SCHEMA_VERSION,
    participants: [...participants]
      .map((participant) => ({
        actorRef: participant.actorRef,
        mechanicsStateVersion: participant.mechanicsStateVersion,
        inventoryStateVersion: participant.inventoryStateVersion,
        effectsStateVersion: participant.effectsStateVersion,
        resourceStateVersions: { ...participant.resourceStateVersions },
      }))
      .sort((left, right) => left.actorRef.localeCompare(right.actorRef)),
  });
}
