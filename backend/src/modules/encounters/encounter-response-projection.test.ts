import { EncounterLifecycleStatus } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import type { CoreV1EncounterBatchResult, CoreV1EncounterState } from '../rules/core-v1/index.js';
import { encounterNextRequiredAction, encounterTransitionSummary } from './encounter-response-projection.js';

function participant(overrides: Record<string, unknown> = {}) {
  return {
    actorRef: 'hero', combatState: 'ready', resources: { hp: { current: 10, maximum: 10 }, mana: { current: 5, maximum: 5 }, sp: { current: 4, maximum: 4 } },
    actionSlots: [{ slotRef: 'late', nextActionAtTick: 11n }, { slotRef: 'ready', nextActionAtTick: 10n }],
    activeEffects: [], zone: 'near', ...overrides,
  };
}

function state(overrides: Record<string, unknown> = {}): CoreV1EncounterState {
  return {
    currentTick: 10n, participants: [participant()], scheduledEvents: [], completionCandidate: null,
    ...overrides,
  } as unknown as CoreV1EncounterState;
}

describe('persisted encounter response projection', () => {
  it('returns only apt actors and actually ready stable slots', () => {
    expect(encounterNextRequiredAction(state({ participants: [
      participant(), participant({ actorRef: 'down', resources: { hp: { current: 0, maximum: 10 } } }),
      participant({ actorRef: 'busy', combatState: 'recovering' }),
    ] }), EncounterLifecycleStatus.AWAITING_INTENT)).toEqual({
      type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['ready'] }],
    });
  });

  it('returns the exact closed action for paused, completion and terminal lifecycles', () => {
    expect(encounterNextRequiredAction(state(), EncounterLifecycleStatus.PROCESSING_PAUSED)).toEqual({ type: 'continue' });
    expect(encounterNextRequiredAction(state({ completionCandidate: 'party_victory_candidate' }), EncounterLifecycleStatus.COMPLETION_PENDING))
      .toEqual({ type: 'confirm_completion', completionCandidate: 'party_victory_candidate' });
    for (const lifecycle of [
      EncounterLifecycleStatus.COMPLETED, EncounterLifecycleStatus.FAILED, EncounterLifecycleStatus.CANCELLED,
    ]) expect(encounterNextRequiredAction(state(), lifecycle)).toEqual({ type: 'none' });
    expect(() => encounterNextRequiredAction(state(), 'UNKNOWN' as EncounterLifecycleStatus))
      .toThrowError(expect.objectContaining({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' }));
  });

  it('rejects lifecycle projections with no ready actor or duplicate ready slots', () => {
    expect(() => encounterNextRequiredAction(state({ participants: [participant({ combatState: 'recovering' })] }), EncounterLifecycleStatus.AWAITING_INTENT))
      .toThrowError(expect.objectContaining({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' }));
    expect(() => encounterNextRequiredAction(state({ participants: [participant({
      actionSlots: [{ slotRef: 'ready', nextActionAtTick: 10n }, { slotRef: 'ready', nextActionAtTick: 9n }],
    })] }), EncounterLifecycleStatus.AWAITING_INTENT))
      .toThrowError(expect.objectContaining({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' }));
  });

  it('exposes exactly the pending reactor and reaction kind without the queue', () => {
    const next = encounterNextRequiredAction(state({ scheduledEvents: [{
      type: 'reaction_resolved', targetRef: 'hero', reactionKind: 'block', timelineEvent: { actorRef: 'enemy' },
    }] }), EncounterLifecycleStatus.AWAITING_REACTION);
    expect(next).toEqual({ type: 'resolve_reaction', reactorRef: 'hero', reactionKind: 'block' });
    expect(JSON.stringify(next)).not.toMatch(/scheduled|event|queue|roll|outcome/);
  });

  it('projects only confirmed allowlisted transition categories and participant deltas', () => {
    const before = state();
    const after = state({ participants: [participant({
      resources: { hp: { current: 7, maximum: 10 }, mana: { current: 5, maximum: 5 }, sp: { current: 4, maximum: 4 } },
      zone: 'engaged', combatState: 'recovering', activeEffects: [{ effectRef: 'effect-secret' }],
    })] });
    const batch = {
      encounterBefore: before, encounterAfter: after,
      processedEvents: [{ type: 'action_effect', timelineEvent: { actorRef: 'enemy' }, targetRef: 'hero' }],
    } as unknown as CoreV1EncounterBatchResult;
    const summary = encounterTransitionSummary(batch);
    expect(summary).toMatchObject({
      processedEventCount: 1,
      events: [{ category: 'action_resolved', actorRef: 'enemy', targetRef: 'hero' }],
      changes: [{
        actorRef: 'hero',
        resources: { hp: { before: 10, after: 7, delta: -3 } }, zone: { before: 'near', after: 'engaged' },
      }],
    });
    expect(summary?.changes[0]?.categories).toEqual(expect.arrayContaining([
      'damage_applied', 'resource_changed', 'movement_resolved', 'participant_state_changed', 'effect_applied',
    ]));
    expect(JSON.stringify(summary)).not.toMatch(/effect-secret|eventRef|actionRef|roll|queue/);
  });

  it('omits eventless batches and bounds complete batches to the core cap', () => {
    const empty = { encounterBefore: state(), encounterAfter: state(), processedEvents: [] } as unknown as CoreV1EncounterBatchResult;
    expect(encounterTransitionSummary(empty)).toBeUndefined();
    const complete = {
      encounterBefore: state(), encounterAfter: state(),
      processedEvents: Array.from({ length: 32 }, () => ({ type: 'action_end', timelineEvent: { actorRef: 'hero' } })),
    } as unknown as CoreV1EncounterBatchResult;
    expect(encounterTransitionSummary(complete)?.processedEventCount).toBe(32);
    const oversized = { ...complete, processedEvents: [...complete.processedEvents, complete.processedEvents[0]!] };
    expect(() => encounterTransitionSummary(oversized)).toThrowError(expect.objectContaining({ code: 'ENCOUNTER_DENORMALIZED_DRIFT' }));
  });

  it('counts removed effects without exposing their definitions', () => {
    const before = state({ participants: [participant({ activeEffects: [{ effectRef: 'removed-effect-secret' }] })] });
    const after = state();
    const batch = {
      encounterBefore: before, encounterAfter: after,
      processedEvents: [{ type: 'action_end', timelineEvent: { actorRef: 'hero' } }],
    } as unknown as CoreV1EncounterBatchResult;
    const summary = encounterTransitionSummary(batch);
    expect(summary?.changes).toEqual([{
      actorRef: 'hero', categories: ['effect_removed'], activeEffects: { applied: 0, removed: 1 },
    }]);
    expect(JSON.stringify(summary)).not.toContain('removed-effect-secret');
  });
});
