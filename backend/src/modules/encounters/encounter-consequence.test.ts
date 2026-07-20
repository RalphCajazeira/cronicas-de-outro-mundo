import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { ActorStatus, ActorType } from '../../generated/prisma/client.js';
import {
  ENCOUNTER_CONSEQUENCE_MAX_UTF8_BYTES,
  ENCOUNTER_MAX_EFFECTS_PER_ACTOR,
  ENCOUNTER_MAX_PARTICIPANTS,
  encounterTerminalEventIdempotencyKey,
  parseEncounterConsequenceSummary,
  parseEncounterOperationResultSummary,
  parseEncounterPublicConsequencesSummary,
  parseEncounterTerminalEventPayload,
  publicEncounterConsequencesSummary,
} from './encounter-consequence.js';
import { encounterOutcomeFromCandidate, encounterTerminalActorStatus } from './encounter-terminal-finalizer.js';

const adapterState = {
  schemaVersion: 1,
  participants: [{
    actorRef: 'hero', mechanicsStateVersion: 2, inventoryStateVersion: 1, effectsStateVersion: 2,
    resourceStateVersions: { hp: 2, mana: 1, sp: 1 },
  }],
};

function resource(current: number, maximum = 10, stateVersion = 1) {
  return { current, maximum, stateVersion };
}

function summary() {
  return {
    schemaVersion: 1,
    outcome: 'party_victory',
    actors: [{
      actorRef: 'hero', statusBefore: 'active', statusAfter: 'active',
      mechanicsStateVersion: { before: 1, after: 2 },
      inventoryStateVersion: { before: 1, after: 1 },
      effectsStateVersion: { before: 1, after: 2 },
      resources: {
        hp: { before: resource(8, 10, 1), after: resource(8, 9, 1) },
        mana: { before: resource(5), after: resource(5) },
        sp: { before: resource(4), after: resource(4) },
      },
    }, {
      actorRef: 'wolf', statusBefore: 'active', statusAfter: 'defeated',
      mechanicsStateVersion: { before: 1, after: 1 },
      inventoryStateVersion: { before: 1, after: 1 },
      effectsStateVersion: { before: 1, after: 1 },
      resources: {
        hp: { before: resource(0, 10, 2), after: resource(0, 10, 2) },
        mana: { before: resource(5), after: resource(5) },
        sp: { before: resource(4), after: resource(4) },
      },
    }],
    removedEncounterEffects: [{ actorRef: 'hero', effectRefs: ['fx_aaaaaaaa', 'fx_bbbbbbbb'] }],
    event: { eventType: 'encounter-completed', actorRef: 'hero' },
  } as const;
}

describe('Encounter consequence contracts', () => {
  it.each([
    ['party_victory_candidate', 'party_victory'],
    ['hostile_victory_candidate', 'party_defeat'],
    ['stalemate_candidate', 'stalemate'],
    ['cancelled', 'cancelled'],
  ] as const)('maps %s to the backend outcome %s', (candidate, outcome) => {
    expect(encounterOutcomeFromCandidate(candidate)).toBe(outcome);
  });

  it.each([
    [ActorStatus.ACTIVE, 0, true, ActorStatus.DEFEATED],
    [ActorStatus.ACTIVE, 1, true, ActorStatus.ACTIVE],
    [ActorStatus.ACTIVE, 0, false, ActorStatus.ACTIVE],
    [ActorStatus.INACTIVE, 0, true, ActorStatus.INACTIVE],
    [ActorStatus.DEFEATED, 0, true, ActorStatus.DEFEATED],
    [ActorStatus.DEAD, 0, true, ActorStatus.DEAD],
    [ActorStatus.ARCHIVED, 0, true, ActorStatus.ARCHIVED],
  ])('derives terminal status %s at HP %i persisted=%s as %s', (status, hp, persisted, expected) => {
    expect(encounterTerminalActorStatus(status, hp, persisted)).toBe(expected);
  });

  it.each(Object.values(ActorType))('uses the same HP/status rule for ActorType %s', () => {
    expect(encounterTerminalActorStatus(ActorStatus.ACTIVE, 0, true)).toBe(ActorStatus.DEFEATED);
  });

  it('parses the closed ordered ledger and projects only public fields', () => {
    const parsed = parseEncounterConsequenceSummary(summary());
    expect(publicEncounterConsequencesSummary(parsed)).toEqual({
      schemaVersion: 1,
      outcome: 'party_victory',
      actorChanges: [{ actorRef: 'wolf', statusBefore: 'active', statusAfter: 'defeated' }],
      removedEncounterEffects: [{ actorRef: 'hero', count: 2 }],
      persistentEvent: { eventType: 'encounter-completed', actorRef: 'hero' },
    });
  });

  it('accepts historical and terminal operation summaries but rejects extras', () => {
    expect(parseEncounterOperationResultSummary({ adapterState })).toEqual({ adapterState });
    expect(parseEncounterOperationResultSummary({ adapterState, consequencesSummary: summary() }))
      .toHaveProperty('consequencesSummary.outcome', 'party_victory');
    expect(() => parseEncounterOperationResultSummary({ adapterState, extra: true })).toThrow();
  });

  it('rejects unknown properties, exotic or sparse arrays, duplicate refs and noncanonical order', () => {
    expect(() => parseEncounterConsequenceSummary({ ...summary(), reward: 1 })).toThrow();
    const sparse = [summary().actors[0]];
    sparse.length = 2;
    expect(() => parseEncounterConsequenceSummary({ ...summary(), actors: sparse })).toThrow();
    class ArraySubclass<T> extends Array<T> {}
    const exoticActors = new ArraySubclass<unknown>();
    exoticActors.push(...summary().actors);
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), actors: exoticActors,
    })).toThrow();
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), actors: [summary().actors[1], summary().actors[0]],
    })).toThrow();
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), removedEncounterEffects: [{ actorRef: 'hero', effectRefs: ['fx_aaaaaaaa', 'fx_aaaaaaaa'] }],
    })).toThrow();
  });

  it('rejects version regression, unauthorized status changes and resource restoration in the terminal ledger', () => {
    const actor = summary().actors[0];
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), actors: [{
        ...actor, mechanicsStateVersion: { before: 2, after: 1 },
      }, summary().actors[1]],
    })).toThrow(/regress/);
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), actors: [{ ...actor, statusAfter: 'dead' }, summary().actors[1]],
    })).toThrow(/status transition/);
    expect(() => parseEncounterConsequenceSummary({
      ...summary(), actors: [{
        ...actor,
        resources: {
          ...actor.resources,
          hp: { before: resource(0, 10, 1), after: resource(1, 10, 2) },
        },
      }, summary().actors[1]],
    })).toThrow(/terminal transition/);
  });

  it('measures the ledger with UTF-8 bytes and enforces the explicit one MiB cap', () => {
    expect(ENCOUNTER_CONSEQUENCE_MAX_UTF8_BYTES).toBe(1_048_576);
    expect(() => parseEncounterConsequenceSummary({ ...summary(), padding: 'á'.repeat(600_000) })).toThrow(/UTF-8/);
  });

  it('keeps the actual maximum structural ledger below the one MiB application cap', () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const actorRefs = Array.from({ length: ENCOUNTER_MAX_PARTICIPANTS }, (_, index) => (
      `actor-${index.toString().padStart(2, '0')}-${'a'.repeat(151)}`
    ));
    const maximumSummary = {
      schemaVersion: 1,
      outcome: 'party_victory',
      actors: actorRefs.map((actorRef) => ({
        actorRef,
        statusBefore: 'archived', statusAfter: 'archived',
        mechanicsStateVersion: { before: maximum - 1, after: maximum },
        inventoryStateVersion: { before: maximum, after: maximum },
        effectsStateVersion: { before: maximum - 1, after: maximum },
        resources: Object.fromEntries((['hp', 'mana', 'sp'] as const).map((key) => [key, {
          before: { current: maximum, maximum, stateVersion: maximum - 1 },
          after: { current: maximum - 1, maximum, stateVersion: maximum },
        }])),
      })),
      removedEncounterEffects: actorRefs.map((actorRef, actorIndex) => ({
        actorRef,
        effectRefs: Array.from({ length: ENCOUNTER_MAX_EFFECTS_PER_ACTOR }, (_, effectIndex) => (
          `fx_${actorIndex.toString().padStart(2, '0')}${effectIndex.toString().padStart(2, '0')}${'a'.repeat(73)}`
        )),
      })),
      event: { eventType: 'encounter-completed', actorRef: actorRefs[0] },
    } as const;
    const parsed = parseEncounterConsequenceSummary(maximumSummary);
    const bytes = Buffer.byteLength(JSON.stringify(parsed), 'utf8');
    expect(bytes).toBe(421_102);
    expect(ENCOUNTER_CONSEQUENCE_MAX_UTF8_BYTES - bytes).toBe(627_474);
  });

  it('validates the bounded terminal event payload', () => {
    expect(parseEncounterTerminalEventPayload({
      schemaVersion: 1, encounterRef: 'battle', outcome: 'party_victory',
      affectedActorRefs: ['hero', 'wolf'], defeatedActorRefs: ['wolf'], removedEncounterEffectCount: 2,
    })).toHaveProperty('removedEncounterEffectCount', 2);
    expect(() => parseEncounterTerminalEventPayload({
      schemaVersion: 1, encounterRef: 'battle', outcome: 'party_victory',
      affectedActorRefs: ['hero'], defeatedActorRefs: ['wolf'], removedEncounterEffectCount: 0,
    })).toThrow();
  });

  it('uses the global Encounter id, so equal refs in different Campaigns cannot collide', () => {
    const first = encounterTerminalEventIdempotencyKey('10000000-0000-4000-8000-000000000001');
    const second = encounterTerminalEventIdempotencyKey('20000000-0000-4000-8000-000000000002');
    expect(first).not.toBe(second);
    expect(first).not.toContain('battle');
  });

  it('parses the public DTO as a closed reward-free projection', () => {
    const projected = publicEncounterConsequencesSummary(parseEncounterConsequenceSummary(summary()));
    expect(parseEncounterPublicConsequencesSummary(projected, new Set(['hero', 'wolf']))).toEqual(projected);
    expect(projected).not.toHaveProperty('xp');
    expect(projected).not.toHaveProperty('gold');
    expect(projected).not.toHaveProperty('loot');
    expect(() => parseEncounterPublicConsequencesSummary({ ...projected, xp: 0 }, new Set(['hero', 'wolf']))).toThrow();
    expect(() => parseEncounterPublicConsequencesSummary({
      ...projected,
      actorChanges: [{ actorRef: 'wolf', statusBefore: 'defeated', statusAfter: 'active' }],
    }, new Set(['hero', 'wolf']))).toThrow();
  });
});
