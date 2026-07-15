import { describe, expect, it } from 'vitest';
import { createSequenceRollProvider } from '../effects/roll-provider.js';
import { RecordingEncounterRollProvider } from './encounter-roll-provider.js';

describe('RecordingEncounterRollProvider', () => {
  it('is lazy, deterministic and records each accessed roll exactly once', () => {
    const provider = new RecordingEncounterRollProvider(createSequenceRollProvider([11, 22]));
    const rolls = provider.effectRolls({
      encounterRef: 'encounter', actionRef: 'action', sourceActorRef: 'source',
      targetActorRef: 'target', targetOrdinal: 0,
    });
    expect(provider.consumed).toEqual([]);
    if (rolls.forcedMiss === true) throw new Error('Expected generated rolls');
    expect(rolls.hitRollBps).toBe(11);
    expect(rolls.hitRollBps).toBe(11);
    expect(provider.consumed.map((roll) => roll.kind)).toEqual(['hit']);
    expect(rolls.criticalRollBps).toBe(22);
    expect(provider.consumed.map((roll) => roll.kind)).toEqual(['hit', 'critical']);
    expect(provider.consumed.every((roll) => /^[0-9a-f]{64}$/.test(roll.inputHash)
      && /^[0-9a-f]{64}$/.test(roll.resultHash))).toBe(true);
  });

  it('records backend tie breaks only when requested', () => {
    const provider = new RecordingEncounterRollProvider(createSequenceRollProvider([77]));
    expect(provider.consumed).toEqual([]);
    expect(provider.tieBreak({ encounterRef: 'encounter', actorRef: 'actor' })).toBe(77);
    expect(provider.consumed).toHaveLength(1);
    expect(provider.consumed[0]).toMatchObject({ kind: 'tie_break', sourceActorRef: 'actor' });
  });

  it('binds a roll input hash to its encounter', () => {
    const first = new RecordingEncounterRollProvider(createSequenceRollProvider([77]));
    const second = new RecordingEncounterRollProvider(createSequenceRollProvider([77]));
    first.tieBreak({ encounterRef: 'encounter-a', actorRef: 'actor' });
    second.tieBreak({ encounterRef: 'encounter-b', actorRef: 'actor' });
    expect(first.consumed[0]?.inputHash).not.toBe(second.consumed[0]?.inputHash);
  });

  it('names rolls uniquely per idempotent execution even when action and ordinal repeat', () => {
    const first = new RecordingEncounterRollProvider(createSequenceRollProvider([77]), 'request-a');
    const second = new RecordingEncounterRollProvider(createSequenceRollProvider([77]), 'request-b');
    first.tieBreak({ encounterRef: 'encounter', actorRef: 'actor' });
    second.tieBreak({ encounterRef: 'encounter', actorRef: 'actor' });
    expect(first.consumed[0]?.rollRef).not.toBe(second.consumed[0]?.rollRef);
    expect(first.consumed[0]?.rollRef.length).toBeLessThanOrEqual(512);
  });

  it('keeps roll refs bounded when the core action ref is at its maximum size', () => {
    const provider = new RecordingEncounterRollProvider(createSequenceRollProvider([77]), 'request');
    const rolls = provider.effectRolls({
      encounterRef: 'encounter', actionRef: 'a'.repeat(512), sourceActorRef: 'source',
      targetActorRef: 'target', targetOrdinal: 0,
    });
    if (rolls.forcedMiss === true) throw new Error('Expected generated rolls');
    void rolls.hitRollBps;
    expect(provider.consumed[0]?.rollRef.length).toBeLessThanOrEqual(512);
  });

  it('distinguishes repeated mechanical requests by their consumed ordinal', () => {
    const provider = new RecordingEncounterRollProvider(createSequenceRollProvider([10, 20]), 'request');
    const request = {
      encounterRef: 'encounter', actionRef: 'action', sourceActorRef: 'source',
      targetActorRef: 'target', targetOrdinal: 0,
    };
    const first = provider.effectRolls(request);
    const second = provider.effectRolls(request);
    if (first.forcedMiss === true || second.forcedMiss === true) throw new Error('Expected generated rolls');
    expect(first.hitRollBps).toBe(10);
    expect(second.hitRollBps).toBe(20);
    expect(provider.consumed[0]?.inputHash).not.toBe(provider.consumed[1]?.inputHash);
  });
});
