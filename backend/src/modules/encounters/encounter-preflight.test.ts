import { describe, expect, it, vi } from 'vitest';
import { EncounterLifecycleStatus, EncounterOperationKind } from '../../generated/prisma/client.js';
import type { CoreV1EncounterState, CoreV1MechanicalContentProfile } from '../rules/core-v1/index.js';
import { createAuthoritativeTargetingContext } from './encounter-action-loader.js';
import {
  applyEncounterMutations,
  assertEncounterMutationPreflight,
} from './encounter-mutation-applier.js';
import { EncounterError } from './encounter.errors.js';
import {
  assertEncounterOperationChainRows,
  deriveEncounterLifecycle,
  loadPersistedEncounterAuthorities,
  type LoadedEncounter,
  type PersistedEncounterAuthority,
} from './encounter-state-loader.js';
import { absentEncounterStateHash, type EncounterTransaction } from './encounter.repository.js';

vi.mock('./encounter-state-loader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./encounter-state-loader.js')>(),
  loadPersistedEncounterAuthorities: vi.fn(),
}));

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

  it('does not reload four unchanged authorities after processing initial actor_ready events', async () => {
    const actorRefs = ['ally-mage', 'crystal-fawn', 'crystal-hunter', 'hero'];
    const participant = (actorRef: string) => ({
      actorRef,
      actorStateVersion: 1,
      mechanicsStateVersion: 1,
      inventoryStateVersion: 1,
      effectsStateVersion: 1,
      combatState: 'ready',
      primaryAttributes: {},
      secondaryAttributes: {},
      resources: {
        hp: { current: 40, maximum: 40 },
        mana: { current: 30, maximum: 30 },
        sp: { current: 30, maximum: 30 },
      },
      activeEffects: [],
      equipmentContext: { inventory: { entries: [] }, loadout: { slots: [] } },
    });
    const before = {
      currentTick: 2301n,
      stateVersion: 1,
      participants: actorRefs.map(participant),
      activeActions: [],
    } as unknown as CoreV1EncounterState;
    const after = {
      ...before,
      currentTick: 3751n,
      stateVersion: 5,
      scheduledEvents: [],
    };
    const authorities = new Map(actorRefs.map((actorRef) => [actorRef, {
      actor: {
        id: `${actorRef}-id`, code: actorRef, campaignId: 'campaign-id', level: 1, status: 'ACTIVE',
        mechanicsStateVersion: 1, inventoryStateVersion: 1, effectsStateVersion: 1,
      },
      sheet: {
        mechanicsStateVersion: 1, inventoryStateVersion: 1, effectsStateVersion: 1,
        primaryAttributes: {}, secondaryAttributes: { elementalResistanceBps: {} },
        resources: {
          hp: { current: 40, max: 40, stateVersion: 1 },
          mana: { current: 30, max: 30, stateVersion: 1 },
          sp: { current: 30, max: 30, stateVersion: 1 },
        },
      },
      inventory: { inventory: { entries: [] }, loadout: { slots: [] } },
      effects: { activeEffects: [] },
    } as unknown as PersistedEncounterAuthority]));
    const fixture = {
      record: {
        id: 'encounter-id', campaignId: 'campaign-id', rulesetVersionId: 'ruleset-id',
        campaign: { worldId: 'world-id', engineTick: 2301n, engineStateVersion: 1 },
        participants: actorRefs.map((actorRef) => ({ actorRef, actorId: `${actorRef}-id` })),
      },
      state: before,
      authorities,
    } as unknown as LoadedEncounter;
    const updateCampaignTick = vi.fn().mockResolvedValue({ count: 1 });
    const transaction = {
      campaign: { updateMany: updateCampaignTick },
      actorResource: { updateMany: vi.fn() },
    } as unknown as EncounterTransaction;
    const expiredReload = vi.mocked(loadPersistedEncounterAuthorities);
    expiredReload.mockRejectedValueOnce(new Error(
      'Transaction API error: query cannot run after the 30000 ms interactive transaction timeout',
    ));

    const result = await applyEncounterMutations(transaction, fixture, after, {
      processedEvents: actorRefs.map((actorRef) => ({
        type: 'actor_ready', timelineEvent: { actorRef },
      })),
      resolvedActions: [],
    } as never);

    expect(result.authorities).toBe(authorities);
    expect(expiredReload).not.toHaveBeenCalled();
    expect(updateCampaignTick).toHaveBeenCalledOnce();
  });

  it('reloads only the actors changed by a spell resolution before rebuilding adapter state', async () => {
    const actorRefs = ['cacador-cristalino', 'cervo-cristalino-jovem', 'kael', 'lysandra-vale'];
    const participant = (
      actorRef: string,
      hp = 40,
      mana = 30,
    ): CoreV1EncounterState['participants'][number] => ({
      actorRef,
      actorStateVersion: 1,
      mechanicsStateVersion: 1,
      inventoryStateVersion: 1,
      effectsStateVersion: 1,
      combatState: actorRef === 'kael' ? 'casting' : 'ready',
      primaryAttributes: {},
      secondaryAttributes: {},
      resources: {
        hp: { current: hp, maximum: 40 },
        mana: { current: mana, maximum: 30 },
        sp: { current: 30, maximum: 30 },
      },
      activeEffects: [],
      equipmentContext: { inventory: { entries: [] }, loadout: { slots: [] } },
    } as unknown as CoreV1EncounterState['participants'][number]);
    const authority = (actorRef: string, hp = 40, mana = 30) => ({
      actor: {
        id: `${actorRef}-id`, code: actorRef, campaignId: 'campaign-id', level: 1, status: 'ACTIVE',
        mechanicsStateVersion: 1, inventoryStateVersion: 1, effectsStateVersion: 1,
      },
      sheet: {
        mechanicsStateVersion: 1, inventoryStateVersion: 1, effectsStateVersion: 1,
        primaryAttributes: {}, secondaryAttributes: { elementalResistanceBps: {} },
        resources: {
          hp: { current: hp, max: 40, stateVersion: hp === 40 ? 1 : 2 },
          mana: { current: mana, max: 30, stateVersion: mana === 30 ? 1 : 2 },
          sp: { current: 30, max: 30, stateVersion: 1 },
        },
      },
      inventory: { inventory: { entries: [] }, loadout: { slots: [] } },
      effects: { activeEffects: [] },
    } as unknown as PersistedEncounterAuthority);
    const before = {
      currentTick: 3751n,
      stateVersion: 6,
      participants: actorRefs.map((actorRef) => participant(actorRef)),
      activeActions: [],
    } as unknown as CoreV1EncounterState;
    const after = {
      ...before,
      currentTick: 4082n,
      stateVersion: 8,
      participants: actorRefs.map((actorRef) => {
        if (actorRef === 'kael') return participant(actorRef, 40, 26);
        if (actorRef === 'cacador-cristalino') return participant(actorRef, 34, 30);
        return participant(actorRef);
      }),
    };
    const authorities = new Map(actorRefs.map((actorRef) => [actorRef, authority(actorRef)]));
    const fixture = {
      record: {
        id: 'encounter-id', campaignId: 'campaign-id', rulesetVersionId: 'ruleset-id',
        campaign: { worldId: 'world-id', engineTick: 3751n, engineStateVersion: 6 },
        participants: actorRefs.map((actorRef) => ({ actorRef, actorId: `${actorRef}-id` })),
      },
      state: before,
      authorities,
    } as unknown as LoadedEncounter;
    const transaction = {
      actorResource: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      campaign: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    } as unknown as EncounterTransaction;
    const selectiveReload = vi.mocked(loadPersistedEncounterAuthorities);
    selectiveReload.mockReset();
    selectiveReload.mockResolvedValueOnce(new Map([
      ['cacador-cristalino', authority('cacador-cristalino', 34, 30)],
      ['kael', authority('kael', 40, 26)],
    ]));

    const result = await applyEncounterMutations(transaction, fixture, after, {
      processedEvents: [{ type: 'action_started' }, { type: 'action_effect' }],
      resolvedActions: [],
    } as never);

    const reloadedActorIds = selectiveReload.mock.calls[0]?.[1] ?? [];
    expect([...reloadedActorIds].sort()).toEqual([
      'cacador-cristalino-id',
      'kael-id',
    ]);
    expect(result.authorities.size).toBe(4);
    expect(result.authorities.get('kael')?.sheet.resources.mana.current).toBe(26);
    expect(result.authorities.get('cacador-cristalino')?.sheet.resources.hp.current).toBe(34);
  });
});
