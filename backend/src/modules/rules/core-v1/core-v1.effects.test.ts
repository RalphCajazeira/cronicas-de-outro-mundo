import { describe, expect, it } from 'vitest';
import {
  advanceActorActionDurations,
  applyCoreV1Status,
  calculateSecondaryAttributes,
  closeEffectScope,
  collectActiveEffectModifiers,
  createCoreV1RuntimeDurationState,
  expireEffectsAtTick,
  getCoreV1EffectRulesIdentity,
  getCoreV1EffectRulesLimits,
  getHybridCost,
  isCoreV1ActorEffectContext,
  removeCoreV1Status,
  resolveCoreV1ConsumableUse,
  resolveCoreV1Cost,
  resolveCoreV1DamageApplication,
  resolveCoreV1EffectSequence,
  resolveCoreV1ResourceRestoration,
  validateCoreV1ResourceState,
} from './index.js';
import type {
  CoreV1ActorEffectContext,
  CoreV1ApplyStatusInput,
  CoreV1ContentVersionReference,
  CoreV1Cost,
  CoreV1EffectContentVersionReference,
  CoreV1EffectResolutionResult,
  CoreV1InventorySpec,
  CoreV1MechanicalContentProfile,
  CoreV1ResourceState,
  CoreV1StatusStacking,
  PrimaryAttributes,
} from './index.js';

const attributes: PrimaryAttributes = {
  strength: 10,
  vitality: 10,
  agility: 10,
  dexterity: 10,
  intelligence: 10,
  wisdom: 10,
  perception: 10,
  willpower: 10,
  luck: 10,
};

function resources(overrides: Partial<Record<'hp' | 'mana' | 'sp', { current: number; maximum: number }>> = {}): CoreV1ResourceState {
  return {
    hp: overrides.hp ?? { current: 100, maximum: 100 },
    mana: overrides.mana ?? { current: 100, maximum: 100 },
    sp: overrides.sp ?? { current: 100, maximum: 100 },
    customResources: [{ resourceRef: { type: 'custom_resource', code: 'rage' }, pool: { current: 5, maximum: 10 } }],
  };
}

function actor(actorRef: string, resourceState = resources()): CoreV1ActorEffectContext {
  return {
    actorRef,
    primaryAttributes: attributes,
    resources: resourceState,
    secondaryAttributes: calculateSecondaryAttributes({
      attributes,
      weaponFamilyRank: 0,
      magicSchoolRank: 0,
      accuracyRank: 0,
      evasionRank: 0,
      encumbrancePenalty: 0,
    }),
    activeEffects: [],
    stateVersion: 1,
  };
}

function expectOk<T>(result: CoreV1EffectResolutionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function expectError<T>(result: CoreV1EffectResolutionResult<T>, code = 'INVALID_CORE_V1_EFFECT_RESOLUTION'): void {
  expect(result).toMatchObject({ ok: false, code, retryable: true });
}

const modifier = (value: number) => [{ source: { type: 'status' as const, ref: 'cost-aura' }, value }];

describe('core-v1 effect identity, resource state and costs', () => {
  it('publishes defensive internal identity and operational limits', () => {
    expect(getCoreV1EffectRulesIdentity()).toEqual({
      rulesetCode: 'core-v1', effectRulesCode: 'core-v1-effects-v1', schemaVersion: 1,
    });
    const limits = getCoreV1EffectRulesLimits();
    expect(limits).toMatchObject({
      maxActors: 16, maxEffectsPerSequence: 16, maxChanges: 64,
      maxActiveEffectsPerActor: 64, maxActiveModifiersPerActor: 32,
      maxStacksPerState: 10, rollBps: { minimum: 1, maximum: 10_000 },
      multiplierBps: { minimum: 0, maximum: 20_000 },
    });
    (limits.rollBps as { minimum: number }).minimum = 999;
    expect(getCoreV1EffectRulesLimits().rollBps.minimum).toBe(1);
  });

  it('validates pools, custom typed references, uniqueness and defensive copies', () => {
    const input = resources();
    const value = expectOk(validateCoreV1ResourceState(input));
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
    expectError(validateCoreV1ResourceState({ ...input, hp: { current: 101, maximum: 100 } }));
    expectError(validateCoreV1ResourceState({
      ...input,
      customResources: [...(input.customResources ?? []), ...(input.customResources ?? [])],
    }));
  });

  it.each([
    [{ type: 'mana', amount: 4 }, 'mana', 4],
    [{ type: 'sp', amount: 3 }, 'sp', 3],
    [{ type: 'active_defense', sp: 2 }, 'sp', 2],
    [{ type: 'special_dodge', sp: 3 }, 'sp', 3],
    [{ type: 'maintenance', resource: 'mana', activationCost: 8, amount: 2 }, 'mana', 8],
    [{ type: 'hp', percentBps: 300 }, 'hp', 3],
    [{ type: 'custom', resourceRef: 'rage', amount: 2 }, 'custom', 2],
  ] as const)('plans $0 without mutating resources', (cost, expectedResource, expected) => {
    const state = resources();
    const before = structuredClone(state);
    const result = expectOk(resolveCoreV1Cost({ tier: 1, cost, resources: state }));
    expect(result.affordable).toBe(true);
    expect(result.amounts[0]).toMatchObject({ resource: expectedResource, adjusted: expected });
    expect(state).toEqual(before);
  });

  it('plans hybrid, none and maintenance upkeep separately', () => {
    const hybrid = getHybridCost(1);
    const result = expectOk(resolveCoreV1Cost({ tier: 1, cost: { type: 'hybrid', ...hybrid }, resources: resources() }));
    expect(result.amounts.map((amount) => [amount.resource, amount.adjusted])).toEqual([
      ['mana', hybrid.mana], ['sp', hybrid.sp],
    ]);
    expect(expectOk(resolveCoreV1Cost({ tier: 1, cost: { type: 'none' }, resources: resources() })).amounts).toEqual([]);
    expect(expectOk(resolveCoreV1Cost({
      tier: 1,
      cost: { type: 'maintenance', resource: 'mana', activationCost: 8, amount: 2 },
      resources: resources(),
    })).maintenancePlan).toEqual({ activationCost: 8, upkeepCost: 2, upkeepResource: 'mana' });
  });

  it('applies additive BPS, zero multiplier and both clamps', () => {
    const base: CoreV1Cost = { type: 'mana', amount: 10 };
    expect(expectOk(resolveCoreV1Cost({ tier: 3, cost: base, resources: resources(), modifiers: { manaCostBps: modifier(-1000) } })).amounts[0]?.adjusted).toBe(9);
    expect(expectOk(resolveCoreV1Cost({ tier: 3, cost: base, resources: resources(), modifiers: { manaCostBps: modifier(1000) } })).amounts[0]?.adjusted).toBe(11);
    expect(expectOk(resolveCoreV1Cost({ tier: 3, cost: base, resources: resources(), modifiers: { manaCostBps: modifier(-10_000) } })).amounts[0]).toMatchObject({ effectiveMultiplierBps: 0, adjusted: 0 });
    expect(expectOk(resolveCoreV1Cost({ tier: 3, cost: base, resources: resources(), modifiers: { manaCostBps: modifier(-30_000) } })).amounts[0]?.effectiveMultiplierBps).toBe(0);
    expect(expectOk(resolveCoreV1Cost({ tier: 3, cost: base, resources: resources(), modifiers: { manaCostBps: modifier(30_000) } })).amounts[0]?.effectiveMultiplierBps).toBe(20_000);
  });

  it('reports insufficient resources, preserves one HP and rejects overflow', () => {
    expect(expectOk(resolveCoreV1Cost({
      tier: 1, cost: { type: 'mana', amount: 4 }, resources: resources({ mana: { current: 3, maximum: 100 } }),
    })).affordable).toBe(false);
    expect(expectOk(resolveCoreV1Cost({
      tier: 1, cost: { type: 'hp', percentBps: 300 }, resources: resources({ hp: { current: 3, maximum: 100 } }),
    })).affordable).toBe(false);
    expectError(resolveCoreV1Cost({
      tier: 1,
      cost: { type: 'hp', percentBps: 300 },
      resources: resources({ hp: { current: Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } }),
    }));
    expectError(resolveCoreV1Cost({ tier: 1, cost: { type: 'custom', resourceRef: 'missing', amount: 1 }, resources: resources() }));
  });
});

const fire = [{ id: 'fire', channel: 'magical' as const, element: 'fire', baseDamage: 8, scaling: 'full' as const, canCrit: true }];

describe('core-v1 rolls, damage, defense and restoration', () => {
  it('resolves hit, miss, critical, HP zero and overkill deterministically', () => {
    const base = {
      attacker: actor('mage'),
      target: actor('target', resources({ hp: { current: 5, maximum: 100 } })),
      damageComponents: fire,
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
      defense: { blockValue: 0, completeBlock: false },
    } as const;
    const critical = expectOk(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 1, criticalRollBps: 1 } }));
    expect(critical).toMatchObject({ hit: true, critical: true, hpAfter: 0, defeatedCandidate: true });
    expect(critical.overkill).toBeGreaterThan(0);
    const miss = expectOk(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 10_000, criticalRollBps: 1 } }));
    expect(miss).toMatchObject({ hit: false, critical: false, damageApplied: 0, hpAfter: 5 });
    expect(expectOk(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 1, criticalRollBps: 1 } }))).toEqual(critical);
  });

  it('validates roll edges and rejects zero/10001', () => {
    const base = {
      attacker: actor('mage'), target: actor('target'), damageComponents: fire,
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
      defense: { blockValue: 0, completeBlock: false },
    } as const;
    expectOk(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 1, criticalRollBps: 10_000 } }));
    expectError(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 0, criticalRollBps: 1 } }));
    expectError(resolveCoreV1DamageApplication({ ...base, rolls: { hitRollBps: 1, criticalRollBps: 10_001 } }));
  });

  it('reuses mitigation for defense, resistance, immunity, partial and complete block', () => {
    const base = {
      attacker: actor('mage'), target: actor('target'), damageComponents: fire,
      rolls: { hitRollBps: 1, criticalRollBps: 10_000 },
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    } as const;
    const plain = expectOk(resolveCoreV1DamageApplication({ ...base, defense: { blockValue: 0, completeBlock: false } }));
    const partial = expectOk(resolveCoreV1DamageApplication({ ...base, defense: { blockValue: 3, completeBlock: false } }));
    const resisted = expectOk(resolveCoreV1DamageApplication({ ...base, defense: {
      blockValue: 0, completeBlock: false,
      temporaryResistances: { physicalResistanceBps: 0, magicalResistanceBps: 4000, elementalResistanceBps: { fire: 7500 } },
    } }));
    const immune = expectOk(resolveCoreV1DamageApplication({ ...base, defense: { blockValue: 0, completeBlock: false, temporaryImmunities: { elements: ['fire'] } } }));
    const blocked = expectOk(resolveCoreV1DamageApplication({ ...base, defense: { blockValue: 0, completeBlock: true } }));
    expect(partial.damageApplied).toBeLessThan(plain.damageApplied);
    expect(resisted.damageApplied).toBeLessThan(plain.damageApplied);
    expect(immune.damageApplied).toBe(0);
    expect(blocked.damageApplied).toBe(0);
  });

  it('requires weapon base for add_damage and preserves six-component limit', () => {
    const common = {
      attacker: actor('fighter'), target: actor('target'), damageComponents: fire,
      rolls: { hitRollBps: 1, criticalRollBps: 10_000 },
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
      defense: { blockValue: 0, completeBlock: false }, addDamage: true,
    } as const;
    expectError(resolveCoreV1DamageApplication(common));
    expectOk(resolveCoreV1DamageApplication({
      ...common,
      weaponDamageComponents: [{ id: 'blade', channel: 'physical', element: null, baseDamage: 4, scaling: 'full', canCrit: true }],
    }));
  });

  it.each(['hp', 'mana', 'sp'] as const)('restores %s with cap and wasted amount', (resource) => {
    const result = expectOk(resolveCoreV1ResourceRestoration({
      resources: resources({ [resource]: { current: 95, maximum: 100 } }), resource, amount: 10,
    }));
    expect(result).toMatchObject({ before: 95, after: 100, applied: 5, wasted: 5 });
  });

  it('restores explicit custom resources and rejects zero', () => {
    expect(expectOk(resolveCoreV1ResourceRestoration({
      resources: resources(), resource: 'custom', resourceRef: { type: 'custom_resource', code: 'rage' }, amount: 3,
    })).after).toBe(8);
    expectError(resolveCoreV1ResourceRestoration({ resources: resources(), resource: 'mana', amount: 0 }));
  });
});

function statusProfile(
  duration: CoreV1MechanicalContentProfile['duration'] = { type: 'actions', value: 2 },
  stacking: CoreV1StatusStacking = { type: 'refresh' },
): CoreV1MechanicalContentProfile {
  return {
    schemaVersion: 1,
    rulesetCode: 'core-v1',
    profileMode: 'mechanical',
    contentKind: 'status_effect',
    code: 'burning',
    name: 'Burning',
    tier: 1,
    rarity: 'common',
    activation: { type: 'passive' },
    cost: { type: 'none' },
    duration: duration ?? { type: 'actions', value: 2 },
    stacking,
    passiveModifiers: [{ target: 'physicalDefense', amount: -2, sourceRule: 'status_effect' }],
  };
}

const actionVersion: CoreV1EffectContentVersionReference = {
  scope: 'world', contentType: 'spell', code: 'ignite', versionNumber: 1,
};
const statusVersion: CoreV1EffectContentVersionReference = {
  scope: 'world', contentType: 'status_effect', code: 'burning', versionNumber: 1,
};

function statusInput(
  target: CoreV1ActorEffectContext,
  stacking: CoreV1StatusStacking,
  duration: NonNullable<CoreV1MechanicalContentProfile['duration']>,
  effectRef = 'burning-effect',
): CoreV1ApplyStatusInput {
  return {
    actor: target,
    sourceActorRef: 'mage',
    sourceContent: actionVersion,
    effectIndex: 0,
    effectRef,
    contentVersion: statusVersion,
    profile: statusProfile(duration, stacking),
    duration,
    stacking,
    currentTick: 100n,
  };
}

describe('core-v1 duration, active states and stacking', () => {
  it('converts every duration and rejects tick overflow', () => {
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'instant' }, 0n))).toBeNull();
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'ticks', value: 10 }, 5n))).toEqual({ type: 'ticks', expiresAtTick: 15n });
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'actions', value: 2 }, 0n))).toEqual({ type: 'actions', remainingActions: 2 });
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'scene' }, 0n))).toEqual({ type: 'scene', scope: 'scene' });
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'encounter' }, 0n))).toEqual({ type: 'encounter', scope: 'encounter' });
    expect(expectOk(createCoreV1RuntimeDurationState({ type: 'permanent' }, 0n))).toEqual({ type: 'permanent', scope: 'permanent' });
    expectError(createCoreV1RuntimeDurationState({ type: 'ticks', value: 10 }, 9_000_000_000_000_000n));
  });

  it('implements none, refresh, intensity cap and replace', () => {
    const fresh = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'none' }, { type: 'actions', value: 2 })));
    const duplicate = expectOk(applyCoreV1Status(statusInput(fresh.actor, { type: 'none' }, { type: 'actions', value: 2 }, 'new-ref')));
    expect(duplicate.change.ignoredDuplicate).toBe(true);

    const refreshFirst = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'refresh' }, { type: 'actions', value: 2 })));
    const refresh = expectOk(applyCoreV1Status(statusInput(refreshFirst.actor, { type: 'refresh' }, { type: 'actions', value: 2 })));
    expect(refresh.change.change).toBe('refreshed');

    let intense = actor('target');
    for (let count = 0; count < 5; count += 1) {
      intense = expectOk(applyCoreV1Status(statusInput(intense, { type: 'stack_intensity', maxStacks: 3 }, { type: 'actions', value: 2 }))).actor;
    }
    expect(intense.activeEffects[0]?.stacks).toBe(3);

    const replaced = expectOk(applyCoreV1Status(statusInput(refresh.actor, { type: 'replace' }, { type: 'actions', value: 2 }, 'replacement-ref')));
    expect(replaced.actor.activeEffects[0]?.effectRef).toBe('replacement-ref');
    expect(replaced.actor.activeEffects[0]?.stacks).toBe(1);
  });

  it('stacks duration for ticks/actions and rejects incompatible scope', () => {
    const ticksStacking = { type: 'stack_duration', maxStacks: 3 } as const;
    const once = expectOk(applyCoreV1Status(statusInput(actor('target'), ticksStacking, { type: 'ticks', value: 10 })));
    const twice = expectOk(applyCoreV1Status(statusInput(once.actor, ticksStacking, { type: 'ticks', value: 10 })));
    expect(twice.actor.activeEffects[0]).toMatchObject({ stacks: 2, durationState: { type: 'ticks', expiresAtTick: 120n } });
    const actions = expectOk(applyCoreV1Status(statusInput(actor('target'), ticksStacking, { type: 'actions', value: 2 })));
    expect(expectOk(applyCoreV1Status(statusInput(actions.actor, ticksStacking, { type: 'actions', value: 2 }))).actor.activeEffects[0])
      .toMatchObject({ stacks: 2, durationState: { type: 'actions', remainingActions: 4 } });
    expectError(applyCoreV1Status(statusInput(actor('target'), ticksStacking, { type: 'scene' })), 'INVALID_ACTIVE_EFFECT_STATE');
  });

  it('keeps different status versions independent', () => {
    const v1 = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'none' }, { type: 'actions', value: 2 })));
    const v2 = expectOk(applyCoreV1Status({
      ...statusInput(v1.actor, { type: 'none' }, { type: 'actions', value: 2 }, 'burning-v2'),
      contentVersion: { ...statusVersion, versionNumber: 2 },
    }));
    expect(v2.actor.activeEffects).toHaveLength(2);
  });

  it('never shortens a permanent instance during refresh and removes only an exact version', () => {
    const permanent = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'none' }, { type: 'permanent' })));
    const refreshed = expectOk(applyCoreV1Status(statusInput(
      permanent.actor,
      { type: 'refresh' },
      { type: 'actions', value: 2 },
    )));
    expect(refreshed.actor.activeEffects[0]?.durationState).toEqual({ type: 'permanent', scope: 'permanent' });
    expect(expectOk(removeCoreV1Status({
      actor: refreshed.actor,
      contentVersion: { ...statusVersion, versionNumber: 2 },
    })).changes).toEqual([]);
    expect(expectOk(removeCoreV1Status({ actor: refreshed.actor, contentVersion: statusVersion })).actor.activeEffects).toEqual([]);
  });

  it('expires exact ticks, advances one action, closes scopes and preserves permanent', () => {
    const ticked = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'refresh' }, { type: 'ticks', value: 10 })));
    expect(expectOk(expireEffectsAtTick(ticked.actor, 109n)).actor.activeEffects).toHaveLength(1);
    expect(expectOk(expireEffectsAtTick(ticked.actor, 110n)).actor.activeEffects).toHaveLength(0);

    const oneAction = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'refresh' }, { type: 'actions', value: 1 })));
    expect(expectOk(advanceActorActionDurations(oneAction.actor, 'target')).actor.activeEffects).toHaveLength(0);

    const scene = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'refresh' }, { type: 'scene' })));
    expect(expectOk(closeEffectScope(scene.actor, 'scene')).actor.activeEffects).toHaveLength(0);
    const encounter = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'refresh' }, { type: 'encounter' })));
    expect(expectOk(closeEffectScope(encounter.actor, 'encounter')).actor.activeEffects).toHaveLength(0);
    const permanent = expectOk(applyCoreV1Status(statusInput(actor('target'), { type: 'none' }, { type: 'permanent' })));
    expect(expectOk(closeEffectScope(permanent.actor, 'scene')).actor.activeEffects).toHaveLength(1);
  });

  it('collects typed modifiers in effectRef order and scales intensity only', () => {
    let target = actor('target');
    target = expectOk(applyCoreV1Status(statusInput(target, { type: 'stack_intensity', maxStacks: 3 }, { type: 'actions', value: 2 }, 'z-effect'))).actor;
    target = expectOk(applyCoreV1Status(statusInput(target, { type: 'stack_intensity', maxStacks: 3 }, { type: 'actions', value: 2 }, 'z-effect'))).actor;
    const collected = expectOk(collectActiveEffectModifiers(target, 100n));
    expect(collected).toEqual([{
      target: 'physicalDefense', value: -4, source: { type: 'status', ref: 'z-effect' },
    }]);

    let durationTarget = actor('target');
    durationTarget = expectOk(applyCoreV1Status(statusInput(durationTarget, { type: 'stack_duration', maxStacks: 3 }, { type: 'actions', value: 2 }, 'duration-effect'))).actor;
    durationTarget = expectOk(applyCoreV1Status(statusInput(durationTarget, { type: 'stack_duration', maxStacks: 3 }, { type: 'actions', value: 2 }, 'duration-effect'))).actor;
    expect(expectOk(collectActiveEffectModifiers(durationTarget, 100n))[0]?.value).toBe(-2);
  });

  it('rejects malformed active state and detects modifier overflow', () => {
    expect(isCoreV1ActorEffectContext({ ...actor('target'), activeEffects: new Array(1) })).toBe(false);
    const overflowProfile = {
      ...statusProfile({ type: 'actions', value: 2 }, { type: 'stack_intensity', maxStacks: 2 }),
      passiveModifiers: [{
        target: 'physicalDefense' as const,
        amount: Number.MAX_SAFE_INTEGER,
        sourceRule: 'status_effect' as const,
      }],
    };
    let target = expectOk(applyCoreV1Status({
      ...statusInput(actor('target'), { type: 'stack_intensity', maxStacks: 2 }, { type: 'actions', value: 2 }),
      profile: overflowProfile,
    })).actor;
    target = expectOk(applyCoreV1Status({
      ...statusInput(target, { type: 'stack_intensity', maxStacks: 2 }, { type: 'actions', value: 2 }),
      profile: overflowProfile,
    })).actor;
    expectError(collectActiveEffectModifiers(target, 100n));
  });
});

const fireballProfile: CoreV1MechanicalContentProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'spell',
  code: 'fireball',
  name: 'Fireball',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'mana', amount: 8 },
  actionProfile: 'fireball',
  effects: [{ type: 'damage', targeting: { type: 'single_target', rangeBand: 'medium', maxTargets: 1 }, damageComponents: fire }],
};

describe('core-v1 atomic effect sequence', () => {
  it('pays cost then applies damage without mutating inputs', () => {
    const source = actor('mage');
    const target = actor('target');
    const before = structuredClone({ source, target });
    const result = expectOk(resolveCoreV1EffectSequence({
      profile: fireballProfile,
      sourceContent: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 },
      sourceActor: source,
      targetActor: target,
      currentTick: 0n,
      effectRefs: ['fireball-damage'],
      rolls: { hitRollBps: 1, criticalRollBps: 10_000 },
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }));
    expect(result.sourceAfter.resources.mana.current).toBe(92);
    expect(result.targetAfter.resources.hp.current).toBeLessThan(100);
    expect({ source, target }).toEqual(before);
  });

  it('pays Mana on miss and skips a following target status', () => {
    const profile: CoreV1MechanicalContentProfile = {
      ...fireballProfile,
      rarity: 'uncommon',
      effects: [
        ...(fireballProfile.effects ?? []),
        { type: 'apply_status', statusRef: 'burning', duration: { type: 'actions', value: 2 }, stacking: { type: 'refresh' } },
      ],
    };
    const result = expectOk(resolveCoreV1EffectSequence({
      profile,
      sourceContent: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 },
      sourceActor: actor('mage'), targetActor: actor('target'), currentTick: 0n,
      effectRefs: ['fireball-damage', 'burning-effect'],
      statusDefinitions: [{ effectIndex: 1, effectRef: 'burning-effect', contentVersion: statusVersion, profile: statusProfile() }],
      rolls: { hitRollBps: 10_000, criticalRollBps: 1 },
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }));
    expect(result.sourceAfter.resources.mana.current).toBe(92);
    expect(result.targetAfter.resources.hp.current).toBe(100);
    expect(result.targetAfter.activeEffects).toHaveLength(0);
  });

  it('fails atomically before cost on invalid effect or insufficient resource', () => {
    const source = actor('mage', resources({ mana: { current: 7, maximum: 100 } }));
    expectError(resolveCoreV1EffectSequence({
      profile: fireballProfile,
      sourceContent: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 },
      sourceActor: source, targetActor: actor('target'), currentTick: 0n,
      effectRefs: ['fireball-damage'], rolls: { hitRollBps: 1, criticalRollBps: 1 },
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }), 'INSUFFICIENT_RESOURCE');
    expect(source.resources.mana.current).toBe(7);
    expectError(resolveCoreV1EffectSequence({
      profile: { ...fireballProfile, effects: [{ type: 'movement', from: 'near', to: 'far', maximumTransitions: 1 }] },
      sourceContent: { scope: 'world', contentType: 'spell', code: 'fireball', versionNumber: 1 },
      sourceActor: actor('mage'), targetActor: actor('target'), currentTick: 0n,
      effectRefs: ['bad-movement'],
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }));
  });

  it('creates temporary primary/secondary modifiers in declared order', () => {
    const profile: CoreV1MechanicalContentProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'skill', code: 'battle-cry', name: 'Battle Cry', tier: 1, rarity: 'uncommon',
      activation: { type: 'active' }, cost: { type: 'sp', amount: 3 }, actionProfile: 'normal',
      effects: [
        { type: 'modify_primary_attribute', attributeCode: 'strength', amount: 2, duration: { type: 'actions', value: 2 } },
        { type: 'modify_secondary_attribute', secondaryCode: 'evasion', amount: -1, duration: { type: 'scene' } },
      ],
    };
    const result = expectOk(resolveCoreV1EffectSequence({
      profile,
      sourceContent: { scope: 'world', contentType: 'skill', code: 'battle-cry', versionNumber: 1 },
      sourceActor: actor('hero'), targetActor: actor('target'), currentTick: 0n,
      effectRefs: ['strength-buff', 'evasion-debuff'],
      targeting: { targetRef: 'target', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }));
    expect(result.targetAfter.activeEffects.map((effect) => effect.kind)).toEqual(['primary_modifier', 'secondary_modifier']);
    expect(expectOk(collectActiveEffectModifiers(result.targetAfter, 0n)).map((entry) => [entry.target, entry.value]))
      .toEqual([['evasion', -1], ['strength', 2]]);
  });

  it('returns validated movement commands and duration-bound reaction grants', () => {
    const movementProfile: CoreV1MechanicalContentProfile = {
      schemaVersion: 1, rulesetCode: 'core-v1', profileMode: 'mechanical',
      contentKind: 'skill', code: 'step', name: 'Step', tier: 1, rarity: 'common',
      activation: { type: 'active' }, cost: { type: 'sp', amount: 3 }, actionProfile: 'quick',
      effects: [{ type: 'movement', from: 'near', to: 'engaged', maximumTransitions: 1 }],
    };
    const hero = actor('hero');
    const move = expectOk(resolveCoreV1EffectSequence({
      profile: movementProfile,
      sourceContent: { scope: 'world', contentType: 'skill', code: 'step', versionNumber: 1 },
      sourceActor: hero, targetActor: hero, currentTick: 0n,
      effectRefs: ['step-command'], targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }));
    expect(move.movementCommands).toEqual([{ from: 'near', to: 'engaged', maximumTransitions: 1 }]);

    const reactionProfile: CoreV1MechanicalContentProfile = {
      ...movementProfile,
      code: 'guard', name: 'Guard',
      effects: [{ type: 'grant_reaction', reactionKind: 'block', reactionDepth: 1 }],
    };
    const common = {
      profile: reactionProfile,
      sourceContent: { scope: 'world' as const, contentType: 'skill' as const, code: 'guard', versionNumber: 1 },
      sourceActor: hero, targetActor: hero, currentTick: 0n,
      effectRefs: ['guard-grant'], targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    };
    expectError(resolveCoreV1EffectSequence(common));
    const grant = expectOk(resolveCoreV1EffectSequence({
      ...common,
      runtimeDurations: [{ effectIndex: 0, duration: { type: 'actions', value: 1 } }],
    }));
    expect(grant.targetAfter.activeEffects[0]).toMatchObject({
      kind: 'reaction_grant', payload: { reactionKind: 'block', reactionDepth: 1 },
    });
  });
});

const potionProfile: CoreV1MechanicalContentProfile = {
  schemaVersion: 1,
  rulesetCode: 'core-v1',
  profileMode: 'mechanical',
  contentKind: 'consumable',
  code: 'healing_potion',
  name: 'Healing Potion',
  tier: 1,
  rarity: 'common',
  activation: { type: 'active' },
  cost: { type: 'none' },
  actionProfile: 'potion',
  consumable: true,
  effects: [{ type: 'restore_resource', resource: 'hp', amount: 10, targeting: { type: 'self', rangeBand: 'self' } }],
};

const stackSpec: CoreV1InventorySpec = {
  schemaVersion: 1, rulesetCode: 'core-v1', inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight: 1, stacking: { mode: 'stackable', maxStack: 20 },
};
const uniqueSpec: CoreV1InventorySpec = {
  schemaVersion: 1, rulesetCode: 'core-v1', inventoryRulesCode: 'core-v1-inventory-v1',
  unitWeight: 1, stacking: { mode: 'unique' },
};
const potionVersion: CoreV1ContentVersionReference = {
  scope: 'world', contentType: 'consumable', code: 'healing_potion', versionNumber: 1,
};

describe('core-v1 pure consumable planning', () => {
  function use(quantity: number) {
    const user = actor('hero', resources({ hp: { current: 90, maximum: 100 } }));
    return resolveCoreV1ConsumableUse({
      inventory: { entries: [{
        entryKind: 'stack', entryRef: 'potion-stack', contentVersion: potionVersion,
        inventorySpec: stackSpec, profile: potionProfile, quantity,
      }] },
      entryRef: 'potion-stack', contentVersionRef: potionVersion, profile: potionProfile,
      sourceActor: user, targetActor: user, currentTick: 0n, effectRefs: ['potion-heal'],
      targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    });
  }

  it('heals, changes stack 2 to 1 and removes stack 1 without mutation', () => {
    const two = expectOk(use(2));
    expect(two.inventoryAfter.entries[0]).toMatchObject({ quantity: 1 });
    expect(two.sequence.sourceAfter.resources.hp.current).toBe(100);
    expect(two.sequence.resourceChanges.at(-1)).toMatchObject({ delta: 10 });
    expect(expectOk(use(1)).inventoryAfter.entries).toEqual([]);
  });

  it('marks an available unique consumable consumed and rejects other states/version', () => {
    const user = actor('hero', resources({ hp: { current: 90, maximum: 100 } }));
    const input = {
      inventory: { entries: [{
        entryKind: 'instance' as const, entryRef: 'unique-potion', contentVersion: potionVersion,
        inventorySpec: uniqueSpec, profile: potionProfile, state: 'available' as const,
      }] },
      entryRef: 'unique-potion', contentVersionRef: potionVersion, profile: potionProfile,
      sourceActor: user, targetActor: user, currentTick: 0n, effectRefs: ['unique-heal'],
      targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    } as const;
    expect(expectOk(resolveCoreV1ConsumableUse(input)).inventoryAfter.entries[0]).toMatchObject({ state: 'consumed' });
    for (const state of ['reserved', 'equipped', 'destroyed', 'consumed'] as const) {
      expectError(resolveCoreV1ConsumableUse({
        ...input,
        inventory: { entries: [{ ...input.inventory.entries[0], state }] },
      }));
    }
    expectError(resolveCoreV1ConsumableUse({ ...input, contentVersionRef: { ...potionVersion, versionNumber: 2 } }));
  });

  it('does not consume after an effect failure and requires an orchestrator for area', () => {
    const invalid = expectError(resolveCoreV1ConsumableUse({
      ...(() => {
        const user = actor('hero');
        return {
          inventory: { entries: [{
            entryKind: 'stack' as const, entryRef: 'potion-stack', contentVersion: potionVersion,
            inventorySpec: stackSpec, profile: potionProfile, quantity: 1,
          }] },
          entryRef: 'potion-stack', contentVersionRef: potionVersion,
          profile: { ...potionProfile, effects: [{ type: 'restore_resource' as const, resource: 'hp' as const, amount: 0, targeting: { type: 'self' as const, rangeBand: 'self' as const } }] },
          sourceActor: user, targetActor: user, currentTick: 0n, effectRefs: ['bad-heal'],
          targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
        };
      })(),
    }));
    expect(invalid).toBeUndefined();

    const areaProfile: CoreV1MechanicalContentProfile = {
      ...potionProfile,
      targeting: {
        type: 'area', rangeBand: 'near', maxTargets: 2, areaShape: 'burst',
        damageMultiplierPerTargetBps: [6000, 6000],
      },
      effects: [{
        type: 'restore_resource', resource: 'hp', amount: 10,
        targeting: {
          type: 'area', rangeBand: 'near', maxTargets: 2, areaShape: 'burst',
          damageMultiplierPerTargetBps: [6000, 6000],
        },
      }],
    };
    const user = actor('hero');
    expectError(resolveCoreV1ConsumableUse({
      inventory: { entries: [{ entryKind: 'stack', entryRef: 'potion-stack', contentVersion: potionVersion, inventorySpec: stackSpec, profile: areaProfile, quantity: 1 }] },
      entryRef: 'potion-stack', contentVersionRef: potionVersion, profile: areaProfile,
      sourceActor: user, targetActor: user, currentTick: 0n, effectRefs: ['area-heal'],
      targeting: { targetRef: 'hero', targetOrdinal: 0, damageMultiplierBps: 10_000 },
    }), 'REQUIRES_ACTION_ORCHESTRATOR');
  });
});
