import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from '../../shared/errors/app-error.js';
import type { EncounterDto } from './encounter.types.js';
import { manageEncounterSchema } from './encounter-http.schemas.js';
import {
  buildEncounterRelations,
  buildAssistedEncounterCreateInput,
  createEncounterHttpService,
  deriveEncounterIntentRef,
  type EncounterApplicationService,
} from './encounter-http.service.js';

const scope = { playerRef: 'player', worldRef: 'world', campaignRef: 'campaign', encounterRef: 'encounter' };

function internalDto(operation: EncounterDto['operation']): EncounterDto {
  return {
    operation, encounterRef: 'encounter', lifecycleStatus: 'awaiting_intent', stateVersion: 1,
    currentTick: '0', stopReason: null, completionCandidate: null,
    participants: [{ actorRef: 'hero', bindingKind: 'persisted_actor', sideRef: 'party', combatState: 'ready', zone: 'near', resources: { hp: { current: 10, maximum: 10 }, mana: { current: 5, maximum: 5 }, sp: { current: 4, maximum: 4 } } }],
    nextRequiredAction: { type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['primary'] }] },
  };
}

function fakeInternal() {
  return {
    create: vi.fn<EncounterApplicationService['create']>().mockResolvedValue(internalDto('create')),
    load: vi.fn<EncounterApplicationService['load']>().mockResolvedValue(internalDto('load')),
    submitIntent: vi.fn<EncounterApplicationService['submitIntent']>().mockResolvedValue({ ...internalDto('submit_intent'), lifecycleStatus: 'processing_paused', nextRequiredAction: { type: 'continue' as const } }),
    resolveReaction: vi.fn<EncounterApplicationService['resolveReaction']>().mockResolvedValue(internalDto('resolve_reaction')),
    continue: vi.fn<EncounterApplicationService['continue']>().mockResolvedValue({
      ...internalDto('continue'), lifecycleStatus: 'processing_paused', nextRequiredAction: { type: 'continue' as const },
      transitionSummary: {
        processedEventCount: 1, visibleEventCount: 1, eventsTruncated: false, actorsActed: ['hero'],
        events: [{ category: 'action_resolved' as const, actorRef: 'hero' }], changes: [],
      },
    }),
    confirmCompletion: vi.fn<EncounterApplicationService['confirmCompletion']>().mockResolvedValue({ ...internalDto('confirm_completion'), lifecycleStatus: 'completed', nextRequiredAction: { type: 'none' as const } }),
    cancel: vi.fn<EncounterApplicationService['cancel']>().mockResolvedValue({ ...internalDto('cancel'), lifecycleStatus: 'cancelled', nextRequiredAction: { type: 'none' as const } }),
    abandon: vi.fn<EncounterApplicationService['abandon']>().mockResolvedValue({
      ...internalDto('abandon'), lifecycleStatus: 'failed', stopReason: 'encounter_failed', nextRequiredAction: { type: 'none' as const },
      recoverySummary: {
        reason: 'authority_drift', authority: 'inventory', actionResolved: false,
        damageApplied: false, costApplied: false, rewardsGranted: false, campaignReleased: true,
      },
    }),
    resolveBeat: vi.fn<EncounterApplicationService['resolveBeat']>().mockResolvedValue({
      ...internalDto('resolve_beat'),
      beatSummary: {
        externalTransitions: 1, resolutionPolicy: 'atomic', partialResolutionApplied: false, actorsActed: ['hero'],
        componentResults: [{ index: 0, type: 'defend', status: 'accepted' }],
        npcActions: [], npcResults: [], requiresPlayerDecision: true,
      },
    }),
  } satisfies EncounterApplicationService;
}

describe('encounter HTTP facade', () => {
  it('builds a dense, canonical and deterministic complete relation matrix', () => {
    const input = manageEncounterSchema.parse({
      operation: 'create', ...scope, idempotencyKey: 'create-encounter-001', partySideRef: 'party',
      participants: [
        { actorRef: 'villain', sideRef: 'hostiles', zone: 'far' },
        { actorRef: 'ally', sideRef: 'party', zone: 'near' },
        { actorRef: 'hero', sideRef: 'party', zone: 'engaged' },
      ],
      relationOverrides: [{ leftActorRef: 'villain', rightActorRef: 'ally', relation: 'neutral' }],
    });
    if (input.operation !== 'create') throw new Error('fixture');
    expect(buildEncounterRelations(input)).toEqual([
      { leftActorRef: 'ally', rightActorRef: 'ally', relation: 'self' },
      { leftActorRef: 'ally', rightActorRef: 'hero', relation: 'ally' },
      { leftActorRef: 'ally', rightActorRef: 'villain', relation: 'neutral' },
      { leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' },
      { leftActorRef: 'hero', rightActorRef: 'villain', relation: 'hostile' },
      { leftActorRef: 'villain', rightActorRef: 'villain', relation: 'self' },
    ]);
  });

  it('orients punctuation-bearing refs canonically and covers every unordered pair at the public cap', () => {
    const input = manageEncounterSchema.parse({
      operation: 'create', ...scope, idempotencyKey: 'create-encounter-cap-001',
      participants: Array.from({ length: 64 }, (_, index) => ({
        actorRef: index === 0 ? 'actor-a' : index === 1 ? 'actor_a' : `actor-${String(index).padStart(2, '0')}`,
        sideRef: index % 2 === 0 ? 'party' : 'hostile', zone: 'near' as const,
      })),
      relationOverrides: [{ leftActorRef: 'actor_a', rightActorRef: 'actor-a', relation: 'neutral' }],
    });
    if (input.operation !== 'create') throw new Error('fixture');
    const relations = buildEncounterRelations(input);
    expect(relations).toHaveLength(64 * 65 / 2);
    expect(relations.find((entry) => entry.leftActorRef === 'actor-a' && entry.rightActorRef === 'actor_a'))
      .toEqual({ leftActorRef: 'actor-a', rightActorRef: 'actor_a', relation: 'neutral' });
    expect(new Set(relations.map((entry) => `${entry.leftActorRef}\u0000${entry.rightActorRef}`)).size)
      .toBe(relations.length);
  });

  it('derives stable namespaced intent refs without revealing the idempotency key', () => {
    const input = manageEncounterSchema.parse({
      operation: 'submit_intent', ...scope, idempotencyKey: 'private-idempotency-key', expectedStateVersion: 1,
      intent: { actorRef: 'hero', slotRef: 'primary', actionSource: 'basic_weapon_attack', targetSelector: 'explicit', targetRefs: ['enemy'], inventoryEntryRef: 'sword' },
    });
    if (input.operation !== 'submit_intent') throw new Error('fixture');
    const first = deriveEncounterIntentRef(input);
    expect(first).toBe(deriveEncounterIntentRef(input));
    expect(first).toMatch(/^intent-[0-9a-f]{64}$/);
    expect(first).not.toContain(input.idempotencyKey);
    expect(deriveEncounterIntentRef({ ...input, idempotencyKey: 'another-private-key' })).not.toBe(first);
    expect(deriveEncounterIntentRef({ ...input, encounterRef: 'other-encounter' })).not.toBe(first);
    expect(deriveEncounterIntentRef({ ...input, campaignRef: 'other-campaign' })).not.toBe(first);
    expect(deriveEncounterIntentRef({ ...input, intent: { ...input.intent, targetRefs: ['other-enemy'] } })).not.toBe(first);
  });

  it('translates public create participants and calls exactly one internal operation', async () => {
    const internal = fakeInternal();
    const service = createEncounterHttpService(internal);
    const input = manageEncounterSchema.parse({
      operation: 'create', ...scope, idempotencyKey: 'create-encounter-001',
      participants: [{ actorRef: 'hero', sideRef: 'party', zone: 'near' }],
    });
    const result = await service.manage(input);
    expect(result.result).toBe('encounter_created');
    expect(internal.create).toHaveBeenCalledOnce();
    expect(internal.create).toHaveBeenCalledWith(expect.objectContaining({
      participants: [{ bindingKind: 'persisted_actor', actorRef: 'hero', sideRef: 'party', zone: 'near' }],
      relations: [{ leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' }],
    }));
    expect(internal.load).not.toHaveBeenCalled();
    expect(internal.submitIntent).not.toHaveBeenCalled();
  });

  it('reproduces the explicit side/zone hazard and fixes it through deterministic assisted setup', () => {
    const explicit = manageEncounterSchema.parse({
      operation: 'create', ...scope, idempotencyKey: 'explicit-hazard-001',
      participants: [
        { actorRef: 'hero', sideRef: 'same-side', zone: 'far' },
        { actorRef: 'enemy', sideRef: 'same-side', zone: 'far' },
      ],
    });
    if (explicit.operation !== 'create' || !('participants' in explicit)) throw new Error('fixture');
    expect(buildEncounterRelations(explicit)).toContainEqual({
      leftActorRef: 'enemy', rightActorRef: 'hero', relation: 'ally',
    });

    const assisted = manageEncounterSchema.parse({
      operation: 'create', ...scope, idempotencyKey: 'assisted-fixed-001',
      setupMode: 'assisted', encounterKind: 'combat',
      partyActorRefs: ['hero', 'ally'], hostileActorRefs: ['enemy'], neutralActorRefs: ['witness'],
      objective: 'Stop the enemy.', engagementPreference: 'immediate',
    });
    if (assisted.operation !== 'create' || assisted.setupMode !== 'assisted') throw new Error('fixture');
    const derived = buildAssistedEncounterCreateInput(assisted);
    expect(derived.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorRef: 'hero', sideRef: 'party', zone: 'engaged' }),
      expect.objectContaining({ actorRef: 'enemy', sideRef: 'hostile', zone: 'engaged' }),
      expect.objectContaining({ actorRef: 'witness', sideRef: 'neutral', zone: 'far' }),
    ]));
    expect(derived.relations).toEqual(expect.arrayContaining([
      { leftActorRef: 'hero', rightActorRef: 'hero', relation: 'self' },
      { leftActorRef: 'ally', rightActorRef: 'hero', relation: 'ally' },
      { leftActorRef: 'enemy', rightActorRef: 'hero', relation: 'hostile' },
      { leftActorRef: 'hero', rightActorRef: 'witness', relation: 'neutral' },
    ]));
  });

  it('forwards an automatic policy with conservative defaults and no mechanical outcome fields', async () => {
    const internal = fakeInternal();
    const input = manageEncounterSchema.parse({
      operation: 'resolve_beat', ...scope,
      idempotencyKey: 'automatic-policy-001', expectedStateVersion: 7,
      policy: {
        actorRef: 'hero', mode: 'until_terminal', strategy: 'balanced',
        objective: 'Finish safely.', targetPriority: 'nearest_hostile', maximumBeats: 6,
      },
    });
    await createEncounterHttpService(internal).manage(input);
    const forwarded = internal.resolveBeat.mock.calls[0]?.[0];
    expect(forwarded?.policy).toMatchObject({
      actorRef: 'hero', mode: 'until_terminal', maximumBeats: 6,
      resourcePolicy: {
        allowCommonConsumables: false, allowRareConsumables: false,
        preserveManaPercent: 50, preserveSpPercent: 50, allowFlee: false,
      },
    });
    expect(JSON.stringify(forwarded)).not.toMatch(/"damage"|"hit"|"rolls"|"outcome"/);
  });

  it('translates safe intent fields and never forwards public mechanics', async () => {
    const internal = fakeInternal();
    const input = manageEncounterSchema.parse({
      operation: 'submit_intent', ...scope, idempotencyKey: 'submit-intent-001', expectedStateVersion: 7,
      intent: { actorRef: 'hero', slotRef: 'custom-slot', actionSource: 'basic_weapon_attack', targetSelector: 'explicit', targetRefs: ['enemy'], inventoryEntryRef: 'sword', versatileMode: 'two_handed' },
    });
    await createEncounterHttpService(internal).manage(input);
    const forwarded = internal.submitIntent.mock.calls[0]?.[0];
    expect(forwarded?.expectedStateVersion).toBe(7);
    expect(forwarded?.intent).toMatchObject({ sourceActorRef: 'hero', slotRef: 'custom-slot', actionSource: 'basic_weapon_attack', targetSelector: 'explicit', requestedTargetRefs: ['enemy'], weaponEntryRef: 'sword', versatileMode: 'two_handed' });
    expect(JSON.stringify(forwarded)).not.toMatch(/hit|critical|damage|roll|outcome/);
  });

  it('forwards one high-level beat to the central use case without micro-orchestrating legacy methods', async () => {
    const internal = fakeInternal();
    const input = manageEncounterSchema.parse({
      operation: 'resolve_beat', ...scope, idempotencyKey: 'resolve-beat-001', expectedStateVersion: 7,
      intent: {
        actorRef: 'hero', objective: 'protect_and_prepare', narrative: 'Hero recua e protege Ally.',
        resolutionPolicy: 'atomic',
        components: [{ type: 'move', destination: 'far' }, { type: 'protect', targetRef: 'ally' }],
      },
      npcDirectives: [{ actorRef: 'enemy', strategy: 'aggressive', targetRef: 'hero' }],
    });
    const result = await createEncounterHttpService(internal).manage(input);
    expect(result.result).toBe('beat_resolved');
    expect(internal.resolveBeat).toHaveBeenCalledOnce();
    const forwarded = internal.resolveBeat.mock.calls[0]?.[0];
    expect(forwarded?.expectedStateVersion).toBe(7);
    expect(forwarded?.intent).toMatchObject({ actorRef: 'hero', resolutionPolicy: 'atomic', components: [
      { type: 'move', destination: 'far' }, { type: 'protect', targetRef: 'ally' },
    ] });
    expect(forwarded?.npcDirectives).toEqual([
      { actorRef: 'enemy', strategy: 'aggressive', targetRef: 'hero' },
    ]);
    expect(internal.submitIntent).not.toHaveBeenCalled();
    expect(internal.continue).not.toHaveBeenCalled();
    expect(internal.resolveReaction).not.toHaveBeenCalled();
  });

  it('reduces the equivalent granular experience from seven external calls to one plan or one automatic call', async () => {
    const granularExternalCalls = [
      'load',
      'movement',
      'attack',
      'defense',
      'second_attack',
      'npc_actions',
      'completion_or_pause',
    ];
    const planInternal = fakeInternal();
    await createEncounterHttpService(planInternal).manage(manageEncounterSchema.parse({
      operation: 'resolve_beat',
      ...scope,
      idempotencyKey: 'external-call-plan-001',
      expectedStateVersion: 7,
      intent: {
        actorRef: 'hero',
        objective: 'Advance, attack and defend.',
        narrative: 'Hero advances, attacks and takes a defensive stance.',
        resolutionPolicy: 'allow_partial',
        components: [
          { type: 'move', destination: 'engaged' },
          { type: 'attack', inventoryEntryRef: 'sword', targetRefs: ['enemy'] },
          { type: 'defend' },
        ],
      },
    }));
    const automaticInternal = fakeInternal();
    await createEncounterHttpService(automaticInternal).manage(manageEncounterSchema.parse({
      operation: 'resolve_beat',
      ...scope,
      idempotencyKey: 'external-call-automatic-001',
      expectedStateVersion: 7,
      policy: {
        actorRef: 'hero',
        mode: 'bounded',
        strategy: 'balanced',
        objective: 'Resolve four safe beats.',
        targetPriority: 'nearest_hostile',
        maximumBeats: 4,
      },
    }));

    expect({
      granular: granularExternalCalls.length,
      plan: planInternal.resolveBeat.mock.calls.length,
      automatic: automaticInternal.resolveBeat.mock.calls.length,
    }).toEqual({ granular: 7, plan: 1, automatic: 1 });
    expect(planInternal.submitIntent).not.toHaveBeenCalled();
    expect(planInternal.continue).not.toHaveBeenCalled();
    expect(automaticInternal.submitIntent).not.toHaveBeenCalled();
    expect(automaticInternal.continue).not.toHaveBeenCalled();
  });

  it.each(['load', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel', 'abandon'] as const)('dispatches %s only to its matching method', async (operation) => {
    const internal = fakeInternal();
    const values = {
      load: { operation, ...scope },
      resolve_reaction: { operation, ...scope, idempotencyKey: 'reaction-key-001', expectedStateVersion: 1, reactorRef: 'hero', reactionKind: 'block' },
      continue: { operation, ...scope, idempotencyKey: 'continue-key-001', expectedStateVersion: 1 },
      confirm_completion: { operation, ...scope, idempotencyKey: 'complete-key-001', expectedStateVersion: 1 },
      cancel: { operation, ...scope, idempotencyKey: 'cancel-key-001', expectedStateVersion: 1 },
      abandon: { operation, ...scope, idempotencyKey: 'abandon-key-001', expectedStateVersion: 1, confirmAuthorityDrift: true },
    };
    await createEncounterHttpService(internal).manage(manageEncounterSchema.parse(values[operation]));
    const method = { load: 'load', resolve_reaction: 'resolveReaction', continue: 'continue', confirm_completion: 'confirmCompletion', cancel: 'cancel', abandon: 'abandon' }[operation] as keyof EncounterApplicationService;
    expect(internal[method]).toHaveBeenCalledOnce();
    expect(internal[method]).toHaveBeenCalledWith(expect.objectContaining(scope));
    expect(Object.values(internal).filter((fn) => fn.mock.calls.length > 0)).toHaveLength(1);
  });

  it('returns the exact public abandon contract through the HTTP facade', async () => {
    const internal = fakeInternal();
    const result = await createEncounterHttpService(internal).manage(manageEncounterSchema.parse({
      operation: 'abandon', ...scope, idempotencyKey: 'abandon-public-contract-001',
      expectedStateVersion: 1, confirmAuthorityDrift: true,
    }));
    expect(result).toMatchObject({
      result: 'encounter_abandoned', operation: 'abandon', encounterRef: 'encounter',
      lifecycleStatus: 'failed', stopReason: 'encounter_failed', nextRequiredAction: { type: 'none' },
      recoverySummary: {
        reason: 'authority_drift', authority: 'inventory', actionResolved: false,
        damageApplied: false, costApplied: false, rewardsGranted: false, campaignReleased: true,
      },
    });
    expect(result).not.toHaveProperty('consequencesSummary');
  });

  it('collapses scope-resolution failures without revealing the missing hierarchy level', async () => {
    const internal = fakeInternal();
    internal.load.mockRejectedValue(new NotFoundError('Campaign'));
    await expect(createEncounterHttpService(internal).manage(manageEncounterSchema.parse(validLoad())))
      .rejects.toMatchObject({ statusCode: 404, code: 'SCOPE_NOT_FOUND', retryable: false });
  });
});

function validLoad() {
  return { operation: 'load' as const, ...scope };
}
