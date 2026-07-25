import { CORE_V1_3_SECONDARY_SCORE_STORAGE_MAXIMUM } from './core-v1.attributes.js';
import type {
  CoreV13AwarenessState,
  CoreV13EncounterStealthState,
  CoreV13ObserverAwareness,
  CoreV13StealthMarginTier,
  CoreV1EncounterParticipant,
  CoreV1EncounterState,
} from './core-v1.encounter.types.js';

export const CORE_V1_3_STEALTH_REVISION = 'RC1.3' as const;

export type CoreV13Lighting = 'bright' | 'normal' | 'dim' | 'dark' | 'magical_darkness';
export type CoreV13Cover = 'none' | 'partial' | 'substantial' | 'full';
export type CoreV13Noise = 'silent' | 'low' | 'normal' | 'loud';
export type CoreV13StealthPace = 'stationary' | 'careful' | 'normal' | 'fast';

export interface CoreV13StealthContext {
  readonly lighting: CoreV13Lighting;
  readonly cover: CoreV13Cover;
  readonly noise: CoreV13Noise;
  readonly pace: CoreV13StealthPace;
}

export interface CoreV13StealthContestInput {
  readonly agentStealth: number;
  readonly observerDetection: number;
  readonly agentRollBps: number;
  readonly observerRollBps: number;
  readonly context: CoreV13StealthContext;
}

export interface CoreV13StealthContestResult {
  readonly awareness: CoreV13AwarenessState;
  readonly visibility: 'exposed' | 'obscured' | 'hidden';
  readonly margin: number;
  readonly marginTier: CoreV13StealthMarginTier;
  readonly surpriseEligible: boolean;
}

const lightingModifier: Readonly<Record<CoreV13Lighting, number>> = {
  bright: -8,
  normal: 0,
  dim: 5,
  dark: 10,
  magical_darkness: 15,
};
const coverModifier: Readonly<Record<CoreV13Cover, number>> = {
  none: -8,
  partial: 3,
  substantial: 8,
  full: 12,
};
const noiseModifier: Readonly<Record<CoreV13Noise, number>> = {
  silent: 5,
  low: 2,
  normal: 0,
  loud: -8,
};
const paceModifier: Readonly<Record<CoreV13StealthPace, number>> = {
  stationary: 5,
  careful: 2,
  normal: 0,
  fast: -10,
};

function assertScore(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > CORE_V1_3_SECONDARY_SCORE_STORAGE_MAXIMUM) {
    throw new RangeError(`${name} must be a non-negative PostgreSQL INTEGER score`);
  }
}

function assertRoll(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError(`${name} must be an integer between 1 and 10000`);
  }
}

function rollContribution(rollBps: number): number {
  return Math.floor((10_001 - rollBps) / 250);
}

export function coreV13StealthContextModifier(context: CoreV13StealthContext): number {
  return lightingModifier[context.lighting]
    + coverModifier[context.cover]
    + noiseModifier[context.noise]
    + paceModifier[context.pace];
}

export function resolveCoreV13StealthContest(
  input: CoreV13StealthContestInput,
): CoreV13StealthContestResult {
  assertScore(input.agentStealth, 'agentStealth');
  assertScore(input.observerDetection, 'observerDetection');
  assertRoll(input.agentRollBps, 'agentRollBps');
  assertRoll(input.observerRollBps, 'observerRollBps');
  const agentTotal = input.agentStealth
    + coreV13StealthContextModifier(input.context)
    + rollContribution(input.agentRollBps);
  const observerTotal = input.observerDetection + rollContribution(input.observerRollBps);
  // Scores are deliberately not normalised to a 0..100 gameplay band. The
  // opposing total and its exact signed difference retain high-level growth;
  // only rolls and downstream chances use their own BPS envelopes.
  const margin = agentTotal - observerTotal;
  const marginTier: CoreV13StealthMarginTier = margin >= 20
    ? 'high_success'
    : margin >= 0
      ? 'success'
      : margin > -20
        ? 'failure'
        : 'critical_failure';
  const awareness: CoreV13AwarenessState = margin >= 0
    ? 'unaware'
    : margin > -20
      ? 'suspicious'
      : 'detected';
  return {
    awareness,
    visibility: margin >= 0 ? 'hidden' : margin > -20 ? 'obscured' : 'exposed',
    margin,
    marginTier,
    surpriseEligible: marginTier === 'high_success',
  };
}

export function coreV13VisibilityFromObservers(
  observerAwareness: readonly CoreV13ObserverAwareness[],
): CoreV13EncounterStealthState['visibility'] {
  if (observerAwareness.length === 0) return 'hidden';
  if (observerAwareness.some((entry) => (
    entry.awareness === 'detected' || entry.awareness === 'tracking'
  ))) return 'exposed';
  return observerAwareness.some((entry) => entry.awareness === 'suspicious') ? 'obscured' : 'hidden';
}

/**
 * RC1.3 snapshots always carry an explicit observer projection. Before any
 * stealth contest, hostile observers are deliberately recorded as detecting
 * the target, so an ordinary encounter has no implicit surprise window.
 */
export function initializeCoreV13EncounterStealthState(
  state: CoreV1EncounterState,
): CoreV1EncounterState {
  return {
    ...state,
    participants: state.participants.map((participant) => {
      const observerAwareness = state.participants
        .filter((observer) => observer.actorRef !== participant.actorRef && state.relations.some((relation) => (
          relation.relation === 'hostile'
          && ((relation.leftActorRef === participant.actorRef && relation.rightActorRef === observer.actorRef)
            || (relation.rightActorRef === participant.actorRef && relation.leftActorRef === observer.actorRef))
        )))
        .map((observer) => ({
          observerActorRef: observer.actorRef,
          awareness: 'detected' as const,
          margin: -20,
          marginTier: 'critical_failure' as const,
        }))
        .sort((left, right) => left.observerActorRef.localeCompare(right.observerActorRef));
      return {
        ...participant,
        stealthState: { visibility: coreV13VisibilityFromObservers(observerAwareness), observerAwareness },
      };
    }),
  };
}

export function applyCoreV13ObserverAwareness(
  state: CoreV1EncounterState,
  targetActorRef: string,
  entries: readonly CoreV13ObserverAwareness[],
  options: { readonly eligibleObserverActorRefs?: readonly string[] } = {},
): CoreV1EncounterState {
  const participant = state.participants.find((candidate) => candidate.actorRef === targetActorRef);
  if (participant === undefined) throw new RangeError('stealth target must be an encounter participant');
  const eligible = options.eligibleObserverActorRefs === undefined
    ? undefined
    : new Set(options.eligibleObserverActorRefs);
  const nextByObserver = new Map(
    (participant.stealthState?.observerAwareness ?? [])
      .filter((entry) => eligible === undefined || eligible.has(entry.observerActorRef))
      .map((entry) => [entry.observerActorRef, entry]),
  );
  for (const entry of entries) nextByObserver.set(entry.observerActorRef, entry);
  const observerAwareness = [...nextByObserver.values()]
    .sort((left, right) => left.observerActorRef.localeCompare(right.observerActorRef));
  const stealthState: CoreV13EncounterStealthState = {
    visibility: coreV13VisibilityFromObservers(observerAwareness),
    observerAwareness,
  };
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    participants: state.participants.map((candidate) => (
      candidate.actorRef === targetActorRef ? { ...candidate, stealthState } : candidate
    )),
  };
}

export function revealCoreV13ActorToObservers(
  state: CoreV1EncounterState,
  actorRef: string,
  observerActorRefs: readonly string[],
): CoreV1EncounterState {
  const actor = state.participants.find((candidate) => candidate.actorRef === actorRef);
  if (actor?.stealthState === undefined || observerActorRefs.length === 0) return state;
  const participantRefs = new Set(state.participants.map((candidate) => candidate.actorRef));
  const revealedObserverRefs = new Set(observerActorRefs.filter((observerActorRef) => (
    observerActorRef !== actorRef && participantRefs.has(observerActorRef)
  )));
  if (revealedObserverRefs.size === 0) return state;
  const awarenessByObserver = new Map(
    actor.stealthState.observerAwareness.map((entry) => [entry.observerActorRef, entry]),
  );
  let changed = false;
  for (const observerActorRef of revealedObserverRefs) {
    const current = awarenessByObserver.get(observerActorRef);
    if (current?.awareness === 'tracking') continue;
    awarenessByObserver.set(observerActorRef, {
      ...(current ?? { observerActorRef, margin: -20, marginTier: 'critical_failure' as const }),
      awareness: 'tracking',
      margin: current === undefined ? -20 : Math.min(current.margin, -20),
      marginTier: 'critical_failure',
    });
    changed = true;
  }
  if (!changed) return state;
  const observerAwareness = [...awarenessByObserver.values()]
    .sort((left, right) => left.observerActorRef.localeCompare(right.observerActorRef));
  return {
    ...state,
    stateVersion: state.stateVersion + 1,
    participants: state.participants.map((candidate) => candidate.actorRef === actorRef
      ? {
        ...candidate,
        stealthState: {
          visibility: coreV13VisibilityFromObservers(observerAwareness),
          observerAwareness,
        },
      }
      : candidate),
  };
}

export interface CoreV13SurpriseAttackProfile {
  readonly applies: boolean;
  readonly accuracyModifierBps: number;
  readonly criticalChanceModifierBps: number;
  readonly guaranteedCritical: boolean;
  readonly reactionPolicy: 'normal';
}

export function coreV13SurpriseAttackProfile(
  attacker: CoreV1EncounterParticipant,
  targetActorRef: string,
  actionTags: readonly string[] = [],
): CoreV13SurpriseAttackProfile {
  const awareness = attacker.stealthState?.observerAwareness
    .find((entry) => entry.observerActorRef === targetActorRef);
  const applies = awareness?.awareness === 'unaware';
  return {
    applies,
    accuracyModifierBps: applies ? 1_500 : 0,
    criticalChanceModifierBps: applies ? 1_000 : 0,
    guaranteedCritical: applies
      && (awareness.marginTier === 'high_success' || actionTags.includes('guaranteed_surprise_critical')),
    reactionPolicy: 'normal',
  };
}
