import { describe, expect, it } from 'vitest';
import { EncounterLifecycleStatus, EncounterOperationKind } from '../../generated/prisma/client.js';
import type { CoreV1EncounterState, CoreV1MechanicalContentProfile } from '../rules/core-v1/index.js';
import { createAuthoritativeTargetingContext } from './encounter-action-loader.js';
import { assertEncounterMutationPreflight } from './encounter-mutation-applier.js';
import { EncounterError } from './encounter.errors.js';
import {
  assertEncounterOperationChainRows,
  deriveEncounterLifecycle,
  type LoadedEncounter,
} from './encounter-state-loader.js';
import { absentEncounterStateHash } from './encounter.repository.js';

function loaded(sourcePersisted: boolean, targetPersisted: boolean): LoadedEncounter {
  return {
    record: {
      participants: [
        { actorRef: 'source', actorId: sourcePersisted ? 'source-id' : null },
        { actorRef: 'target', actorId: targetPersisted ? 'target-id' : null },
      ],
    },
    state: {
      participants: [
        { actorRef: 'source', combatState: 'ready', resources: { hp: { current: 10, maximum: 10 } }, zone: 'near' },
        { actorRef: 'target', combatState: 'ready', resources: { hp: { current: 10, maximum: 10 } }, zone: 'near' },
      ],
      relations: [{ leftActorRef: 'source', rightActorRef: 'target', relation: 'hostile' }],
      activeActions: [{
        sourceActorRef: 'source',
        targets: [{ targetRef: 'target' }],
        executionPlan: { profile: { effects: [{ type: 'apply_status' }] } },
      }],
    },
    authorities: new Map(),
  } as unknown as LoadedEncounter;
}

describe('encounter adapter preflight', () => {
  it('rejects ephemeral source to persisted target before runtime execution', () => {
    expect(() => assertEncounterMutationPreflight(loaded(false, true)))
      .toThrow(expect.objectContaining<Partial<EncounterError>>({ code: 'ENCOUNTER_EPHEMERAL_MUTATION_UNSUPPORTED' }));
  });

  it('allows persisted effects to remain local on an ephemeral target', () => {
    expect(() => assertEncounterMutationPreflight(loaded(true, false))).not.toThrow();
  });

  it('rejects spatial targeting when authoritative geometry is absent', () => {
    const fixture = loaded(true, true);
    const profile = {
      targeting: { type: 'area', rangeBand: 'near', maxTargets: 2 },
    } as CoreV1MechanicalContentProfile;
    expect(() => createAuthoritativeTargetingContext(fixture, {
      intentRef: 'intent', sourceActorRef: 'source', slotRef: 'primary', actionSource: 'content',
      targetSelector: 'explicit', requestedTargetRefs: ['target'],
    }, profile)).toThrow(expect.objectContaining<Partial<EncounterError>>({
      code: 'ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE',
    }));
  });

  it('derives strict lifecycle boundaries from core state and stop reason', () => {
    const state = {
      status: 'active', completionCandidate: null, scheduledEvents: [{}],
    } as unknown as CoreV1EncounterState;
    expect(deriveEncounterLifecycle(state, 'reaction_required')).toBe(EncounterLifecycleStatus.AWAITING_REACTION);
    expect(deriveEncounterLifecycle({ ...state, scheduledEvents: [] }, null)).toBe(EncounterLifecycleStatus.AWAITING_INTENT);
    expect(deriveEncounterLifecycle({ ...state, completionCandidate: 'party_victory_candidate' }, null))
      .toBe(EncounterLifecycleStatus.COMPLETION_PENDING);
    expect(deriveEncounterLifecycle({ ...state, status: 'completed' }, 'encounter_completed'))
      .toBe(EncounterLifecycleStatus.COMPLETED);
  });

  it('rejects an incoherent append-only operation predecessor', () => {
    const firstHash = '1'.repeat(64);
    const secondHash = '2'.repeat(64);
    const rows = [{
      id: 'create', operation: EncounterOperationKind.CREATE,
      previousStateVersion: 0, nextStateVersion: 1,
      inputHash: 'a'.repeat(64), beforeStateHash: absentEncounterStateHash(), afterStateHash: firstHash,
      idempotencyRecord: { operation: 'encounter.create', requestHash: 'a'.repeat(64) },
    }, {
      id: 'continue', operation: EncounterOperationKind.CONTINUE,
      previousStateVersion: 1, nextStateVersion: 3,
      inputHash: 'b'.repeat(64), beforeStateHash: firstHash, afterStateHash: secondHash,
      idempotencyRecord: { operation: 'encounter.continue', requestHash: 'b'.repeat(64) },
    }];
    expect(() => assertEncounterOperationChainRows(rows, 3, secondHash, 'continue')).not.toThrow();
    expect(() => assertEncounterOperationChainRows([
      rows[0]!, { ...rows[1]!, beforeStateHash: 'f'.repeat(64) },
    ], 3, secondHash, 'continue')).toThrow(expect.objectContaining<Partial<EncounterError>>({
      code: 'ENCOUNTER_DENORMALIZED_DRIFT',
    }));
    expect(() => assertEncounterOperationChainRows([
      rows[0]!, { ...rows[1]!, idempotencyRecord: { ...rows[1]!.idempotencyRecord, requestHash: 'c'.repeat(64) } },
    ], 3, secondHash, 'continue')).toThrow();
  });
});
