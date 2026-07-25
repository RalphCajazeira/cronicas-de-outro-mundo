import { describe, expect, it } from 'vitest';
import {
  applyCoreV13ObserverAwareness,
  coreV13StealthContextModifier,
  coreV13SurpriseAttackProfile,
  revealCoreV13ActorToObservers,
  resolveCoreV13StealthContest,
} from './core-v1.stealth.js';
import type {
  CoreV1EncounterParticipant,
  CoreV1EncounterState,
} from './core-v1.encounter.types.js';

const normal = {
  lighting: 'normal',
  cover: 'none',
  noise: 'normal',
  pace: 'stationary',
} as const;

describe('core RC1.3 stealth, detection and surprise', () => {
  it('uses closed context modifiers for lighting, cover, noise and pace', () => {
    expect(coreV13StealthContextModifier(normal)).toBe(-3);
    expect(coreV13StealthContextModifier({
      lighting: 'dark', cover: 'substantial', noise: 'silent', pace: 'careful',
    })).toBe(25);
    expect(coreV13StealthContextModifier({
      lighting: 'bright', cover: 'none', noise: 'loud', pace: 'fast',
    })).toBe(-34);
  });

  it('uses an exact, untruncated margin with a deterministic tie and threshold bands', () => {
    const contest = (agentStealth: number, observerDetection = 20) => resolveCoreV13StealthContest({
      agentStealth, observerDetection, agentRollBps: 5_000, observerRollBps: 5_000, context: normal,
    });
    expect(contest(22)).toMatchObject({ margin: -1, marginTier: 'failure', awareness: 'suspicious' });
    expect(contest(23)).toMatchObject({ margin: 0, marginTier: 'success', awareness: 'unaware' });
    expect(contest(43)).toMatchObject({ margin: 20, marginTier: 'high_success', surpriseEligible: true });
    expect(contest(44)).toMatchObject({ margin: 21, marginTier: 'high_success', surpriseEligible: true });
    expect(resolveCoreV13StealthContest({
      agentStealth: 20, observerDetection: 40,
      agentRollBps: 9_000, observerRollBps: 1_000, context: normal,
    })).toMatchObject({
      awareness: 'detected', visibility: 'exposed', marginTier: 'critical_failure', surpriseEligible: false,
    });
  });

  it('retains high-level score differences instead of clipping the opposed margin', () => {
    const result = resolveCoreV13StealthContest({
      agentStealth: 10_004, observerDetection: 10_000,
      agentRollBps: 5_000, observerRollBps: 5_000, context: normal,
    });
    expect(result.margin).toBe(1);
    expect(resolveCoreV13StealthContest({
      agentStealth: 10_008, observerDetection: 10_000,
      agentRollBps: 5_000, observerRollBps: 5_000, context: normal,
    }).margin).toBe(5);
  });

  it('keeps awareness observer-specific and derives mixed visibility', () => {
    const state = {
      stateVersion: 3,
      participants: [{ actorRef: 'rogue' }, { actorRef: 'guard-a' }, { actorRef: 'guard-b' }],
    } as unknown as CoreV1EncounterState;
    const next = applyCoreV13ObserverAwareness(state, 'rogue', [
      { observerActorRef: 'guard-a', awareness: 'unaware', margin: 8, marginTier: 'success' },
      { observerActorRef: 'guard-b', awareness: 'detected', margin: -21, marginTier: 'critical_failure' },
    ]);
    expect(next.stateVersion).toBe(4);
    expect(next.participants[0]?.stealthState).toEqual({
      visibility: 'exposed',
      observerAwareness: [
        { observerActorRef: 'guard-a', awareness: 'unaware', margin: 8, marginTier: 'success' },
        { observerActorRef: 'guard-b', awareness: 'detected', margin: -21, marginTier: 'critical_failure' },
      ],
    });
  });

  it('drops awareness for observers no longer eligible on the next authoritative check', () => {
    const state = {
      stateVersion: 3,
      participants: [{
        actorRef: 'rogue',
        stealthState: {
          visibility: 'obscured',
          observerAwareness: [
            { observerActorRef: 'active-guard', awareness: 'unaware', margin: 2, marginTier: 'success' },
            { observerActorRef: 'removed-guard', awareness: 'detected', margin: -20, marginTier: 'critical_failure' },
          ],
        },
      }],
    } as unknown as CoreV1EncounterState;
    const next = applyCoreV13ObserverAwareness(state, 'rogue', [{
      observerActorRef: 'active-guard', awareness: 'unaware', margin: 3, marginTier: 'success',
    }], { eligibleObserverActorRefs: ['active-guard'] });
    expect(next.participants[0]?.stealthState).toEqual({
      visibility: 'hidden',
      observerAwareness: [{
        observerActorRef: 'active-guard', awareness: 'unaware', margin: 3, marginTier: 'success',
      }],
    });
  });

  it('grants surprise only against an unaware target and only guarantees critical at high margin or by tag', () => {
    const attacker = {
      stealthState: {
        visibility: 'hidden',
        observerAwareness: [{
          observerActorRef: 'guard',
          awareness: 'unaware',
          margin: 5,
          marginTier: 'success',
        }],
      },
    } as unknown as CoreV1EncounterParticipant;
    expect(coreV13SurpriseAttackProfile(attacker, 'guard')).toEqual({
      applies: true,
      accuracyModifierBps: 1_500,
      criticalChanceModifierBps: 1_000,
      guaranteedCritical: false,
      reactionPolicy: 'normal',
    });
    expect(coreV13SurpriseAttackProfile(attacker, 'guard', ['guaranteed_surprise_critical']).guaranteedCritical)
      .toBe(true);
    const highMarginAttacker = {
      ...attacker,
      stealthState: {
        ...attacker.stealthState,
        observerAwareness: [{
          observerActorRef: 'guard',
          awareness: 'unaware',
          margin: 25,
          marginTier: 'high_success',
        }],
      },
    } as unknown as CoreV1EncounterParticipant;
    expect(coreV13SurpriseAttackProfile(highMarginAttacker, 'guard').guaranteedCritical).toBe(true);
    expect(coreV13SurpriseAttackProfile(attacker, 'other').applies).toBe(false);
  });

  it('applies surprise independently per target awareness state', () => {
    const attacker = {
      stealthState: {
        visibility: 'obscured',
        observerAwareness: [
          { observerActorRef: 'unaware', awareness: 'unaware', margin: 1, marginTier: 'success' },
          { observerActorRef: 'suspicious', awareness: 'suspicious', margin: -1, marginTier: 'failure' },
          { observerActorRef: 'detected', awareness: 'detected', margin: -20, marginTier: 'critical_failure' },
          { observerActorRef: 'tracking', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        ],
      },
    } as unknown as CoreV1EncounterParticipant;
    expect(coreV13SurpriseAttackProfile(attacker, 'unaware').applies).toBe(true);
    for (const targetRef of ['suspicious', 'detected', 'tracking']) {
      expect(coreV13SurpriseAttackProfile(attacker, targetRef).applies).toBe(false);
    }
  });

  it('reveals the attacker only to attacked observers without mutating the original state', () => {
    const state = {
      stateVersion: 7,
      participants: [{
        actorRef: 'rogue',
        stealthState: {
          visibility: 'hidden',
          observerAwareness: [
            { observerActorRef: 'guard-b', awareness: 'unaware', margin: 25, marginTier: 'high_success' },
            { observerActorRef: 'guard-a', awareness: 'unaware', margin: 5, marginTier: 'success' },
          ],
        },
      }, { actorRef: 'guard-a' }, { actorRef: 'guard-b' }],
    } as unknown as CoreV1EncounterState;
    const before = structuredClone(state);
    const revealed = revealCoreV13ActorToObservers(state, 'rogue', ['guard-a']);
    expect(revealed.stateVersion).toBe(8);
    expect(revealed.participants[0]?.stealthState).toMatchObject({
      visibility: 'exposed',
      observerAwareness: [
        { observerActorRef: 'guard-a', awareness: 'tracking' },
        { observerActorRef: 'guard-b', awareness: 'unaware' },
      ],
    });
    const attacker = revealed.participants[0] as CoreV1EncounterParticipant;
    expect(coreV13SurpriseAttackProfile(attacker, 'guard-a')).toMatchObject({
      applies: false,
      accuracyModifierBps: 0,
      criticalChanceModifierBps: 0,
      guaranteedCritical: false,
    });
    expect(coreV13SurpriseAttackProfile(attacker, 'guard-b')).toMatchObject({
      applies: true,
      accuracyModifierBps: 1_500,
      criticalChanceModifierBps: 1_000,
      guaranteedCritical: true,
    });
    expect(state).toEqual(before);
  });

  it('reveals later targets once, preserves mixed non-target awareness, and ignores invalid refs', () => {
    const state = {
      stateVersion: 11,
      participants: [{
        actorRef: 'rogue',
        stealthState: {
          visibility: 'obscured',
          observerAwareness: [
            { observerActorRef: 'unaware', awareness: 'unaware', margin: 4, marginTier: 'success' },
            { observerActorRef: 'suspicious', awareness: 'suspicious', margin: -2, marginTier: 'failure' },
            { observerActorRef: 'detected', awareness: 'detected', margin: -20, marginTier: 'critical_failure' },
            { observerActorRef: 'tracking', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
          ],
        },
      }, { actorRef: 'unaware' }, { actorRef: 'suspicious' }, { actorRef: 'detected' }, { actorRef: 'tracking' }],
    } as unknown as CoreV1EncounterState;
    const revealed = revealCoreV13ActorToObservers(state, 'rogue', ['suspicious', 'detected', 'tracking']);
    expect(revealed.stateVersion).toBe(12);
    expect(revealed.participants[0]?.stealthState).toEqual({
      visibility: 'exposed',
      observerAwareness: [
        { observerActorRef: 'detected', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        { observerActorRef: 'suspicious', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        { observerActorRef: 'tracking', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        { observerActorRef: 'unaware', awareness: 'unaware', margin: 4, marginTier: 'success' },
      ],
    });
    const invalid = revealCoreV13ActorToObservers(revealed, 'rogue', ['missing', 'rogue']);
    expect(invalid).toBe(revealed);
    const duplicate = revealCoreV13ActorToObservers(revealed, 'rogue', ['tracking', 'tracking']);
    expect(duplicate).toBe(revealed);
  });

  it('reveals multiple attacked observers in one version transition and creates no duplicates', () => {
    const state = {
      stateVersion: 20,
      participants: [{
        actorRef: 'rogue',
        stealthState: {
          visibility: 'hidden',
          observerAwareness: [{
            observerActorRef: 'guard-c', awareness: 'unaware', margin: 8, marginTier: 'success',
          }],
        },
      }, { actorRef: 'guard-a' }, { actorRef: 'guard-b' }, { actorRef: 'guard-c' }],
    } as unknown as CoreV1EncounterState;
    const revealed = revealCoreV13ActorToObservers(state, 'rogue', ['guard-b', 'guard-a', 'guard-b']);
    expect(revealed.stateVersion).toBe(21);
    expect(revealed.participants[0]?.stealthState).toEqual({
      visibility: 'exposed',
      observerAwareness: [
        { observerActorRef: 'guard-a', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        { observerActorRef: 'guard-b', awareness: 'tracking', margin: -20, marginTier: 'critical_failure' },
        { observerActorRef: 'guard-c', awareness: 'unaware', margin: 8, marginTier: 'success' },
      ],
    });
  });

  it('keeps an actor without stealth state unchanged', () => {
    const state = {
      stateVersion: 2,
      participants: [{ actorRef: 'rogue' }, { actorRef: 'guard' }],
    } as unknown as CoreV1EncounterState;
    expect(revealCoreV13ActorToObservers(state, 'rogue', ['guard'])).toBe(state);
  });

  it('preserves Veil-derived effects and modifiers while removing hidden visibility only for the target', () => {
    const state = {
      stateVersion: 9,
      participants: [{
        actorRef: 'rogue',
        secondaryAttributes: { stealth: 29, evasion: 22, movementSpeed: 11 },
        activeEffects: [{
          effectRef: 'shadow-wrapped',
          tags: ['shadow_wrapped', 'stealth'],
          modifiers: [
            { target: 'stealth', amount: 4 },
            { target: 'evasion', amount: 2 },
            { target: 'movementSpeed', amount: 1 },
          ],
        }],
        stealthState: {
          visibility: 'hidden',
          observerAwareness: [
            { observerActorRef: 'guard-a', awareness: 'unaware', margin: 22, marginTier: 'high_success' },
            { observerActorRef: 'guard-b', awareness: 'unaware', margin: 18, marginTier: 'success' },
          ],
        },
      }, { actorRef: 'guard-a' }, { actorRef: 'guard-b' }],
    } as unknown as CoreV1EncounterState;
    const revealed = revealCoreV13ActorToObservers(state, 'rogue', ['guard-a']);
    expect(revealed.participants[0]).toMatchObject({
      secondaryAttributes: { stealth: 29, evasion: 22, movementSpeed: 11 },
      activeEffects: [{
        effectRef: 'shadow-wrapped',
        tags: ['shadow_wrapped', 'stealth'],
        modifiers: [
          { target: 'stealth', amount: 4 },
          { target: 'evasion', amount: 2 },
          { target: 'movementSpeed', amount: 1 },
        ],
      }],
      stealthState: {
        visibility: 'exposed',
        observerAwareness: [
          { observerActorRef: 'guard-a', awareness: 'tracking' },
          { observerActorRef: 'guard-b', awareness: 'unaware' },
        ],
      },
    });
  });
});
