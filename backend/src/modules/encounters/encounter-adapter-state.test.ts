import { describe, expect, it } from 'vitest';
import {
  createEncounterAdapterState,
  parseEncounterAdapterState,
} from './encounter-adapter-state.js';

const participant = (actorRef: string, version = 1) => ({
  actorRef,
  mechanicsStateVersion: version,
  inventoryStateVersion: version + 1,
  effectsStateVersion: version + 2,
  resourceStateVersions: { hp: version + 3, mana: version + 4, sp: version + 5 },
});

describe('Encounter adapterState v1', () => {
  it('creates a closed vector ordered by actorRef', () => {
    expect(createEncounterAdapterState([participant('zeta'), participant('alpha')])).toEqual({
      schemaVersion: 1,
      participants: [participant('alpha'), participant('zeta')],
    });
  });

  it.each([
    undefined,
    {},
    { schemaVersion: 2, participants: [] },
    { schemaVersion: 1, participants: [], extra: true },
    { schemaVersion: 1, participants: [participant('actor', 0)] },
    { schemaVersion: 1, participants: [participant('zeta'), participant('alpha')] },
    { schemaVersion: 1, participants: [participant('actor'), participant('actor')] },
    { schemaVersion: 1, participants: Array.from({ length: 65 }, (_, index) => participant(`actor-${index}`)) },
    { schemaVersion: 1, participants: [participant('c2bd21c8-c131-4e40-9667-62ef403718c6')] },
  ])('rejects absent, malformed, open, invalid, unordered or duplicated vectors', (value) => {
    expect(() => parseEncounterAdapterState(value)).toThrow();
  });

  it('rejects sparse vectors', () => {
    const participants = [participant('actor')];
    participants.length = 2;
    expect(() => parseEncounterAdapterState({ schemaVersion: 1, participants })).toThrow();
  });
});
