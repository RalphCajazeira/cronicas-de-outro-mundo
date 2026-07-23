import { EncounterLifecycleStatus } from '../../generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import {
  CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
  type CoreV1EncounterBatchResult,
  type CoreV1EncounterState,
} from '../rules/core-v1/index.js';
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
    expect(encounterTransitionSummary(oversized)).toMatchObject({
      processedEventCount: 33,
      visibleEventCount: CORE_V1_MAX_ENCOUNTER_BATCH_EVENTS,
      eventsTruncated: true,
      actorsActed: ['hero'],
    });
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

  it('keeps consolidated deltas and every acting actor when the 32-event public timeline is truncated', () => {
    const before = state({ participants: [
      participant({ actorRef: 'hero', activeEffects: [{ effectRef: 'old-hero-effect' }] }),
      participant({
        actorRef: 'enemy',
        resources: {
          hp: { current: 12, maximum: 12 }, mana: { current: 8, maximum: 8 }, sp: { current: 6, maximum: 6 },
        },
      }),
    ] });
    const after = state({ participants: [
      participant({
        actorRef: 'hero',
        resources: {
          hp: { current: 6, maximum: 10 }, mana: { current: 3, maximum: 5 }, sp: { current: 4, maximum: 4 },
        },
        activeEffects: [{ effectRef: 'new-hero-effect' }],
      }),
      participant({
        actorRef: 'enemy',
        resources: {
          hp: { current: 4, maximum: 12 }, mana: { current: 8, maximum: 8 }, sp: { current: 2, maximum: 6 },
        },
        combatState: 'recovering',
      }),
    ] });
    const batch = {
      encounterBefore: before,
      encounterAfter: after,
      processedEvents: Array.from({ length: 64 }, (_, index) => ({
        type: index % 2 === 0 ? 'action_effect' : 'action_end',
        timelineEvent: { actorRef: index % 2 === 0 ? 'hero' : 'enemy' },
        targetRef: index % 2 === 0 ? 'enemy' : 'hero',
      })),
    } as unknown as CoreV1EncounterBatchResult;
    const summary = encounterTransitionSummary(batch);
    expect(summary).toMatchObject({
      processedEventCount: 64,
      visibleEventCount: 32,
      eventsTruncated: true,
      actorsActed: ['enemy', 'hero'],
    });
    expect(summary?.events).toHaveLength(32);
    expect(summary?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorRef: 'hero',
        resources: {
          hp: { before: 10, after: 6, delta: -4 },
          mana: { before: 5, after: 3, delta: -2 },
        },
        activeEffects: { applied: 1, removed: 1 },
      }),
      expect.objectContaining({
        actorRef: 'enemy',
        resources: {
          hp: { before: 12, after: 4, delta: -8 },
          sp: { before: 6, after: 2, delta: -4 },
        },
        combatState: { before: 'ready', after: 'recovering' },
      }),
    ]));
  });
});
