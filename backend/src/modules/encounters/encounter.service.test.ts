import { describe, expect, it, vi } from 'vitest';
import type {
  CoreV1EncounterBatchResult,
  CoreV1EncounterEvent,
  CoreV1EncounterState,
} from '../rules/core-v1/index.js';

vi.mock('../../shared/database/prisma.js', () => ({ prisma: {} }));

import { applyResolvedEncounterStealthTransitions } from './encounter.service.js';

function stealthState(): CoreV1EncounterState {
  const resources = {
    hp: { current: 40, maximum: 40 },
    mana: { current: 20, maximum: 20 },
    sp: { current: 20, maximum: 20 },
    customResources: [],
  };
  return {
    stateVersion: 30,
    participants: [{
      actorRef: 'rogue',
      combatState: 'ready',
      zone: 'engaged',
      resources,
      stealthState: {
        visibility: 'hidden',
        observerAwareness: [
          { observerActorRef: 'guard-a', awareness: 'unaware', margin: 25, marginTier: 'high_success' },
          { observerActorRef: 'guard-b', awareness: 'unaware', margin: 8, marginTier: 'success' },
          { observerActorRef: 'guard-c', awareness: 'unaware', margin: 4, marginTier: 'success' },
        ],
      },
    }, ...['guard-a', 'guard-b', 'guard-c'].map((actorRef) => ({
      actorRef, combatState: 'ready', zone: 'engaged', resources,
    }))],
    relations: ['guard-a', 'guard-b', 'guard-c'].map((actorRef) => ({
      leftActorRef: 'rogue', rightActorRef: actorRef, relation: 'hostile',
    })),
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
  encounterAfter: CoreV1EncounterState = state,
): CoreV1EncounterBatchResult {
  return {
    encounterBefore: state,
    encounterAfter,
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

describe('encounter service post-resolution stealth transitions', () => {
  it('reveals a missed resolved attack only to its authoritative target', () => {
    const state = stealthState();
    const event = effectEvent('player-attack', 'rogue', 'guard-a');
    const next = applyResolvedEncounterStealthTransitions(
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
    const first = applyResolvedEncounterStealthTransitions(report(state, events, resolutions));
    expect(first.encounterAfter.stateVersion).toBe(31);
    expect(first.encounterAfter.participants[0]?.stealthState?.observerAwareness).toMatchObject([
      { observerActorRef: 'guard-a', awareness: 'tracking' },
      { observerActorRef: 'guard-b', awareness: 'tracking' },
      { observerActorRef: 'guard-c', awareness: 'unaware' },
    ]);
    const replayReport = report(first.encounterAfter, events, resolutions);
    expect(applyResolvedEncounterStealthTransitions(replayReport)).toBe(replayReport);
  });

  it('reveals only successful effect resolutions in partial, rejected, and skipped reports', () => {
    const state = stealthState();
    const resolved = effectEvent('partial-attack', 'rogue', 'guard-a');
    const invalidated = effectEvent('rejected-attack', 'rogue', 'guard-b');
    const partial = applyResolvedEncounterStealthTransitions(report(
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
    expect(applyResolvedEncounterStealthTransitions(rejected)).toBe(rejected);
  });

  it('uses the resolved source and target for NPC and triggered-plan attacks', () => {
    const npcState = {
      ...stealthState(),
      participants: stealthState().participants.map((participant) => participant.actorRef === 'rogue'
        ? {
          ...participant,
          stealthState: {
            visibility: 'hidden',
            observerAwareness: [
              { observerActorRef: 'guard-a', awareness: 'unaware', margin: 5, marginTier: 'success' },
              { observerActorRef: 'guard-b', awareness: 'unaware', margin: 5, marginTier: 'success' },
            ],
          },
        }
        : participant),
    } as unknown as CoreV1EncounterState;
    const npc = applyResolvedEncounterStealthTransitions(report(
      npcState,
      [effectEvent('npc-attack', 'rogue', 'guard-a')],
      [attackResolution('rogue', 'guard-a', true)],
    )).encounterAfter;
    const triggered = applyResolvedEncounterStealthTransitions(report(
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

  it('prunes a lethally attacked observer after targeted reveal using the final state once', () => {
    const initial = stealthState();
    const before = {
      ...initial,
      participants: initial.participants.map((participant) => participant.actorRef === 'rogue'
        ? {
          ...participant,
          stealthState: {
            visibility: 'exposed' as const,
            observerAwareness: participant.stealthState?.observerAwareness.map((entry) => (
              entry.observerActorRef === 'guard-a' ? { ...entry, awareness: 'tracking' as const } : entry
            )) ?? [],
          },
        }
        : participant),
    };
    const afterDamage = {
      ...before,
      stateVersion: 40,
      participants: before.participants.map((participant) => participant.actorRef === 'guard-a'
        ? {
          ...participant,
          combatState: 'incapacitated_candidate' as const,
          resources: {
            ...participant.resources,
            hp: { ...participant.resources.hp, current: 0 },
          },
        }
        : participant),
    };
    const event = effectEvent('lethal-player-attack', 'rogue', 'guard-a');
    const normalized = applyResolvedEncounterStealthTransitions(report(
      before,
      [event],
      [attackResolution('rogue', 'guard-a', true)],
      [],
      afterDamage,
    ));
    expect(normalized.encounterAfter.stateVersion).toBe(41);
    expect(normalized.encounterAfter.participants[0]?.stealthState).toEqual({
      visibility: 'hidden',
      observerAwareness: [
        { observerActorRef: 'guard-b', awareness: 'unaware', margin: 8, marginTier: 'success' },
        { observerActorRef: 'guard-c', awareness: 'unaware', margin: 4, marginTier: 'success' },
      ],
    });
    expect(afterDamage.participants[0]?.stealthState?.observerAwareness).toHaveLength(3);
    const replay = report(normalized.encounterAfter, [event], [attackResolution('rogue', 'guard-a', true)]);
    expect(applyResolvedEncounterStealthTransitions(replay)).toBe(replay);
  });

  it.each([
    ['movement to out_of_range', { zone: 'out_of_range' as const }],
    ['official removal', { combatState: 'removed' as const }],
  ])('prunes awareness after %s without changing other observers', (_label, participantPatch) => {
    const initial = stealthState();
    const tracking = {
      ...initial,
      participants: initial.participants.map((participant) => participant.actorRef === 'rogue'
        ? {
          ...participant,
          stealthState: {
            visibility: 'exposed' as const,
            observerAwareness: participant.stealthState?.observerAwareness.map((entry) => (
              entry.observerActorRef === 'guard-a' ? { ...entry, awareness: 'tracking' as const } : entry
            )) ?? [],
          },
        }
        : participant),
    };
    const transitioned = {
      ...tracking,
      stateVersion: 50,
      participants: tracking.participants.map((participant) => participant.actorRef === 'guard-a'
        ? { ...participant, ...participantPatch }
        : participant),
    };
    const normalized = applyResolvedEncounterStealthTransitions(report(
      tracking, [], [], [], transitioned,
    )).encounterAfter;
    expect(normalized.stateVersion).toBe(51);
    expect(normalized.participants[0]?.stealthState).toEqual({
      visibility: 'hidden',
      observerAwareness: [
        { observerActorRef: 'guard-b', awareness: 'unaware', margin: 8, marginTier: 'success' },
        { observerActorRef: 'guard-c', awareness: 'unaware', margin: 4, marginTier: 'success' },
      ],
    });
  });

  it('normalizes a hidden actor when another participant defeats its observer', () => {
    const initial = stealthState();
    const tracking = {
      ...initial,
      participants: initial.participants.map((participant) => participant.actorRef === 'rogue'
        ? {
          ...participant,
          stealthState: {
            visibility: 'exposed' as const,
            observerAwareness: participant.stealthState?.observerAwareness.map((entry) => (
              entry.observerActorRef === 'guard-a' ? { ...entry, awareness: 'tracking' as const } : entry
            )) ?? [],
          },
        }
        : participant),
    };
    const afterDamage = {
      ...tracking,
      stateVersion: 60,
      participants: tracking.participants.map((participant) => participant.actorRef === 'guard-a'
        ? {
          ...participant,
          resources: { ...participant.resources, hp: { ...participant.resources.hp, current: 0 } },
        }
        : participant),
    };
    const event = effectEvent('ally-lethal-attack', 'guard-c', 'guard-a');
    const normalized = applyResolvedEncounterStealthTransitions(report(
      tracking,
      [event],
      [attackResolution('guard-c', 'guard-a', true)],
      [],
      afterDamage,
    )).encounterAfter;
    expect(normalized.participants[0]?.stealthState?.observerAwareness.map((entry) => entry.observerActorRef))
      .toEqual(['guard-b', 'guard-c']);
  });

  it('does not resurrect residual tracking when an ineligible observer is healed', () => {
    const initial = stealthState();
    const residual = {
      ...initial,
      participants: initial.participants.map((participant) => participant.actorRef === 'rogue'
        ? {
          ...participant,
          stealthState: {
            visibility: 'exposed' as const,
            observerAwareness: participant.stealthState?.observerAwareness.map((entry) => (
              entry.observerActorRef === 'guard-a' ? { ...entry, awareness: 'tracking' as const } : entry
            )) ?? [],
          },
        }
        : participant.actorRef === 'guard-a'
          ? {
            ...participant,
            combatState: 'incapacitated_candidate' as const,
            resources: { ...participant.resources, hp: { ...participant.resources.hp, current: 0 } },
          }
          : participant),
    };
    const healed = {
      ...residual,
      stateVersion: 70,
      participants: residual.participants.map((participant) => participant.actorRef === 'guard-a'
        ? {
          ...participant,
          combatState: 'ready' as const,
          resources: { ...participant.resources, hp: { ...participant.resources.hp, current: 10 } },
        }
        : participant),
    };
    const normalized = applyResolvedEncounterStealthTransitions(report(
      residual, [], [], [], healed,
    )).encounterAfter;
    expect(normalized.stateVersion).toBe(71);
    expect(normalized.participants[0]?.stealthState).toEqual({
      visibility: 'hidden',
      observerAwareness: [
        { observerActorRef: 'guard-b', awareness: 'unaware', margin: 8, marginTier: 'success' },
        { observerActorRef: 'guard-c', awareness: 'unaware', margin: 4, marginTier: 'success' },
      ],
    });
    const replay = report(normalized, [], []);
    expect(applyResolvedEncounterStealthTransitions(replay)).toBe(replay);
  });
});
