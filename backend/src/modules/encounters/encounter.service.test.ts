import { describe, expect, it, vi } from 'vitest';
import type {
  CoreV1EncounterBatchResult,
  CoreV1EncounterEvent,
  CoreV1EncounterState,
} from '../rules/core-v1/index.js';

vi.mock('../../shared/database/prisma.js', () => ({ prisma: {} }));

import { applyResolvedAttackStealthReveals } from './encounter.service.js';

function stealthState(): CoreV1EncounterState {
  return {
    stateVersion: 30,
    participants: [{
      actorRef: 'rogue',
      stealthState: {
        visibility: 'hidden',
        observerAwareness: [
          { observerActorRef: 'guard-a', awareness: 'unaware', margin: 25, marginTier: 'high_success' },
          { observerActorRef: 'guard-b', awareness: 'unaware', margin: 8, marginTier: 'success' },
          { observerActorRef: 'guard-c', awareness: 'unaware', margin: 4, marginTier: 'success' },
        ],
      },
    }, { actorRef: 'guard-a' }, { actorRef: 'guard-b' }, { actorRef: 'guard-c' }],
  } as unknown as CoreV1EncounterState;
}

function effectEvent(actionRef: string, sourceActorRef: string, targetRef: string): CoreV1EncounterEvent {
  return {
    eventRef: `${actionRef}-${targetRef}`,
    type: 'action_effect',
    actionRef,
    targetRef,
    targetOrdinal: 0,
    timelineEvent: { actorRef: sourceActorRef },
  } as unknown as CoreV1EncounterEvent;
}

function attackResolution(sourceActorRef: string, targetActorRef: string, hit: boolean) {
  return {
    sourceBefore: { actorRef: sourceActorRef },
    sourceAfter: { actorRef: sourceActorRef },
    targetBefore: { actorRef: targetActorRef },
    targetAfter: { actorRef: targetActorRef },
    damageResults: [{ hit }],
  } as unknown as CoreV1EncounterBatchResult['effectResolutions'][number];
}

function report(
  state: CoreV1EncounterState,
  events: readonly CoreV1EncounterEvent[],
  resolutions: CoreV1EncounterBatchResult['effectResolutions'],
  invalidatedEvents: CoreV1EncounterBatchResult['invalidatedEvents'] = [],
): CoreV1EncounterBatchResult {
  return {
    encounterBefore: state,
    encounterAfter: state,
    processedEvents: events,
    resolvedActions: [],
    effectResolutions: resolutions,
    reactionResolutions: [],
    movementChanges: [],
    cooldownChanges: [],
    invalidatedEvents,
    readyActors: [],
    stopReason: null,
    continuationRequired: false,
  };
}

describe('encounter service target-scoped stealth reveal', () => {
  it('reveals a missed resolved attack only to its authoritative target', () => {
    const state = stealthState();
    const event = effectEvent('player-attack', 'rogue', 'guard-a');
    const next = applyResolvedAttackStealthReveals(
      report(state, [event], [attackResolution('rogue', 'guard-a', false)]),
    ).encounterAfter;
    expect(next.stateVersion).toBe(31);
    expect(next.participants[0]?.stealthState).toMatchObject({
      visibility: 'exposed',
      observerAwareness: [
        { observerActorRef: 'guard-a', awareness: 'tracking' },
        { observerActorRef: 'guard-b', awareness: 'unaware' },
        { observerActorRef: 'guard-c', awareness: 'unaware' },
      ],
    });
    expect(state.participants[0]?.stealthState?.visibility).toBe('hidden');
  });

  it('groups a multi-target attack into one state transition and does not duplicate replayed awareness', () => {
    const state = stealthState();
    const events = [
      effectEvent('area-attack', 'rogue', 'guard-a'),
      effectEvent('area-attack', 'rogue', 'guard-b'),
    ];
    const resolutions = [
      attackResolution('rogue', 'guard-a', true),
      attackResolution('rogue', 'guard-b', false),
    ];
    const first = applyResolvedAttackStealthReveals(report(state, events, resolutions));
    expect(first.encounterAfter.stateVersion).toBe(31);
    expect(first.encounterAfter.participants[0]?.stealthState?.observerAwareness).toMatchObject([
      { observerActorRef: 'guard-a', awareness: 'tracking' },
      { observerActorRef: 'guard-b', awareness: 'tracking' },
      { observerActorRef: 'guard-c', awareness: 'unaware' },
    ]);
    const replayReport = report(first.encounterAfter, events, resolutions);
    expect(applyResolvedAttackStealthReveals(replayReport)).toBe(replayReport);
  });

  it('reveals only successful effect resolutions in partial, rejected, and skipped reports', () => {
    const state = stealthState();
    const resolved = effectEvent('partial-attack', 'rogue', 'guard-a');
    const invalidated = effectEvent('rejected-attack', 'rogue', 'guard-b');
    const partial = applyResolvedAttackStealthReveals(report(
      state,
      [resolved, invalidated],
      [attackResolution('rogue', 'guard-a', true)],
      [{ event: invalidated, reason: 'NO_VALID_TARGET' }],
    )).encounterAfter;
    expect(partial.participants[0]?.stealthState?.observerAwareness).toMatchObject([
      { observerActorRef: 'guard-a', awareness: 'tracking' },
      { observerActorRef: 'guard-b', awareness: 'unaware' },
      { observerActorRef: 'guard-c', awareness: 'unaware' },
    ]);
    const rejected = report(state, [], []);
    expect(applyResolvedAttackStealthReveals(rejected)).toBe(rejected);
  });

  it('uses the resolved source and target for NPC and triggered-plan attacks', () => {
    const npcState = {
      ...stealthState(),
      participants: [
        { actorRef: 'guard-a' },
        {
          actorRef: 'rogue',
          stealthState: {
            visibility: 'hidden',
            observerAwareness: [
              { observerActorRef: 'guard-a', awareness: 'unaware', margin: 5, marginTier: 'success' },
              { observerActorRef: 'guard-b', awareness: 'unaware', margin: 5, marginTier: 'success' },
            ],
          },
        },
        { actorRef: 'guard-b' },
      ],
    } as unknown as CoreV1EncounterState;
    const npc = applyResolvedAttackStealthReveals(report(
      npcState,
      [effectEvent('npc-attack', 'rogue', 'guard-a')],
      [attackResolution('rogue', 'guard-a', true)],
    )).encounterAfter;
    const triggered = applyResolvedAttackStealthReveals(report(
      npc,
      [effectEvent('prepared-attack', 'rogue', 'guard-b')],
      [attackResolution('rogue', 'guard-b', true)],
    )).encounterAfter;
    expect(triggered.stateVersion).toBe(32);
    expect(triggered.participants.find((entry) => entry.actorRef === 'rogue')?.stealthState?.observerAwareness)
      .toMatchObject([
        { observerActorRef: 'guard-a', awareness: 'tracking' },
        { observerActorRef: 'guard-b', awareness: 'tracking' },
      ]);
  });
});
