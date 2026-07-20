import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseEncounterDto } from './encounter.types.js';
import {
  absentEncounterStateHash,
  calculateEncounterRequestHash,
  ENCOUNTER_TRANSACTION_OPTIONS,
  encounterPostgresCode,
  isRetryableEncounterTransactionError,
} from './encounter.repository.js';

const response = {
  operation: 'continue',
  encounterRef: 'encounter',
  lifecycleStatus: 'awaiting_intent',
  stateVersion: 2,
  currentTick: '125',
  stopReason: 'new_intent_required',
  completionCandidate: null,
  participants: [{
    actorRef: 'hero', bindingKind: 'persisted_actor', sideRef: 'party',
    combatState: 'ready', zone: 'near',
    resources: {
      hp: { current: 10, maximum: 10 },
      mana: { current: 5, maximum: 5 },
      sp: { current: 4, maximum: 4 },
    },
  }],
  nextRequiredAction: { type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['primary'] }] },
};

describe('encounter repository primitives', () => {
  it('bounds encounter read and mutation transactions explicitly', () => {
    expect(ENCOUNTER_TRANSACTION_OPTIONS).toEqual({ maxWait: 5_000, timeout: 30_000 });
  });

  it('recognizes PostgreSQL deadlock and serialization codes without text matching', () => {
    expect(isRetryableEncounterTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableEncounterTransactionError({ meta: { driverAdapterError: { cause: { originalCode: '40001' } } } })).toBe(true);
    expect(isRetryableEncounterTransactionError(new Error('40P01'))).toBe(false);
    expect(encounterPostgresCode({ meta: { driverAdapterError: { cause: { originalCode: 'P0001' } } } }))
      .toBe('P0001');
  });

  it('uses a stable canonical absent-state hash', () => {
    expect(absentEncounterStateHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(absentEncounterStateHash()).toBe(absentEncounterStateHash());
  });

  it('hashes encounter bigint input canonically without losing precision', () => {
    expect(calculateEncounterRequestHash({ tick: 9_007_199_254_740_993n }))
      .toBe(calculateEncounterRequestHash({ tick: '9007199254740993' }));
    expect(calculateEncounterRequestHash({ tick: 1n, optional: undefined }))
      .toBe(calculateEncounterRequestHash({ tick: 1n }));
    const sparse = [1];
    sparse.length = 2;
    expect(() => calculateEncounterRequestHash({ sparse })).toThrow();
  });

  it('validates persisted replay responses as closed JSON-safe DTOs', () => {
    expect(parseEncounterDto(response)).toEqual(response);
    expect(() => parseEncounterDto({ ...response, stateHash: 'a'.repeat(64) })).toThrow();
    expect(() => parseEncounterDto({ ...response, lifecycleStatus: 'unknown' })).toThrow();
    expect(() => parseEncounterDto({ ...response, encounterRef: randomUUID() })).toThrow();
    expect(() => parseEncounterDto({ ...response, participants: [{ ...response.participants[0], actorId: randomUUID() }] })).toThrow();
    expect(() => parseEncounterDto({
      ...response,
      participants: [{
        ...response.participants[0],
        resources: { ...response.participants[0]!.resources, hp: { current: 11, maximum: 10 } },
      }],
    })).toThrow();
    expect(() => parseEncounterDto({})).toThrow();
    const sparseParticipants = [...response.participants];
    sparseParticipants.length = 2;
    expect(() => parseEncounterDto({ ...response, participants: sparseParticipants })).toThrow();
    expect(() => parseEncounterDto({ ...response, participants: Array.from(
      { length: 65 }, (_, index) => ({ ...response.participants[0], actorRef: `actor-${index}` }),
    ) })).toThrow();
    const inherited = Object.create({ operation: 'continue' }) as Record<string, unknown>;
    Object.assign(inherited, response);
    expect(() => parseEncounterDto(inherited)).toThrow();
  });

  it('rejects contradictory next actions and malformed persisted transition summaries', () => {
    const transitionSummary = {
      processedEventCount: 1,
      events: [{ category: 'damage_applied', actorRef: 'hero', targetRef: 'hero' }],
      changes: [{
        actorRef: 'hero', categories: ['damage_applied', 'resource_changed'],
        resources: { hp: { before: 10, after: 7, delta: -3 } },
      }],
    };
    expect(parseEncounterDto({ ...response, transitionSummary })).toMatchObject({ transitionSummary });
    expect(() => parseEncounterDto({ ...response, nextRequiredAction: { type: 'continue' } })).toThrow();
    expect(() => parseEncounterDto({
      ...response,
      nextRequiredAction: { type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['slot', 'slot'] }] },
    })).toThrow();
    expect(() => parseEncounterDto({
      ...response,
      transitionSummary: {
        ...transitionSummary,
        changes: [{ ...transitionSummary.changes[0], resources: { hp: { before: 10, after: -1, delta: -11 } } }],
      },
    })).toThrow();
    expect(() => parseEncounterDto({
      ...response,
      transitionSummary: {
        ...transitionSummary,
        changes: [{ ...transitionSummary.changes[0], resources: { hp: { before: 10, after: 7, delta: -2 } } }],
      },
    })).toThrow();
    expect(() => parseEncounterDto({
      ...response,
      transitionSummary: { ...transitionSummary, events: [{ category: 'damage_applied', actorRef: 'unknown' }] },
    })).toThrow();
    expect(() => parseEncounterDto({ ...response, operation: 'load', transitionSummary })).toThrow();
  });
});
