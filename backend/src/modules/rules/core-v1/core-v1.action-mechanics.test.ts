import { describe, expect, it } from 'vitest';
import {
  calculateConcentration,
  calculateMobileCastTime,
  calculateMovement,
  comboXpCreditCount,
  completeCasting,
  concentrationSucceeds,
  getInitialAttributePreset,
  getReactionDefinition,
  interruptCasting,
  isValidZoneTransition,
  resolveReaction,
  scheduleChannelPulseEvents,
  scheduleChannelPulses,
  startCasting,
  validateMultiTargetAction,
  zoneDistance,
} from './index.js';
import type { MultiTargetActionDefinition, ReactionKind } from './index.js';
import { CORE_V1_REACTION_DEFINITIONS } from './core-v1.action-economy.config.js';

describe('core-v1 movement by abstract zones', () => {
  it('calculates all zone distances and validates adjacent/two-step transitions', () => {
    const zones = ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const;
    zones.forEach((from, left) => zones.forEach((to, right) => {
      expect(zoneDistance(from, to)).toBe(Math.abs(left - right));
    }));
    expect(isValidZoneTransition('engaged', 'near')).toBe(true);
    expect(isValidZoneTransition('engaged', 'medium')).toBe(false);
    expect(isValidZoneTransition('engaged', 'medium', 2)).toBe(true);
  });

  it('supports approach, retreat, running and disengage with conceptual costs', () => {
    expect(calculateMovement('medium', 'near', 'approach', 'normal')).toMatchObject({ transitions: 1, movementTime: 1000n, conceptualSpCost: 0 });
    expect(calculateMovement('near', 'medium', 'retreat', 'normal').movementTime).toBe(1000n);
    expect(calculateMovement('engaged', 'medium', 'run', 'normal')).toMatchObject({ movementTime: 1400n, conceptualSpCost: 3 });
    expect(calculateMovement('engaged', 'near', 'disengage', 'normal').movementTime).toBe(1100n);
  });

  it.each([
    ['normal', 1000n], ['difficult', 1500n], ['severe', 2000n],
  ] as const)('applies %s terrain', (terrain, expected) => {
    expect(calculateMovement('near', 'medium', 'retreat', terrain).movementTime).toBe(expected);
  });

  it('rejects impeded/overloaded movement and gates combined movement plus action', () => {
    expect(() => calculateMovement('near', 'medium', 'retreat', 'normal', { impeded: true })).toThrow('impeded');
    expect(() => calculateMovement('near', 'medium', 'retreat', 'normal', { overloaded: true })).toThrow('overloaded');
    expect(() => calculateMovement('near', 'medium', 'retreat', 'normal', { combinedActionTime: 500n })).toThrow('explicitly allowed');
    expect(calculateMovement('near', 'medium', 'retreat', 'normal', {
      combinedActionAllowed: true, combinedActionTime: 500n, startTick: 100n,
    }).combinedActionAtTick).toBe(1600n);
  });
});

describe('core-v1 casting and conceptual Mana deltas', () => {
  it('reserves and consumes Mana for fast Fireball and long magic', () => {
    const fireball = startCasting({ startTick: 100n, castTime: 350n, reservedMana: 8 });
    expect(fireball).toMatchObject({ state: { completionTick: 450n, phase: 'casting' }, manaDelta: { reserved: 8, consumed: 0 } });
    expect(completeCasting(fireball.state)).toMatchObject({ state: { phase: 'completed' }, manaDelta: { reserved: -8, consumed: 8, released: 0 } });
    expect(startCasting({ startTick: 0n, castTime: 1400n, reservedMana: 12 }).state.completionTick).toBe(1400n);
  });

  it('consumes zero before half progress and 25% from half onward', () => {
    const casting = startCasting({ startTick: 0n, castTime: 1000n, reservedMana: 10 }).state;
    expect(interruptCasting(casting, 499n).manaDelta).toEqual({ reserved: -10, consumed: 0, released: 10 });
    expect(interruptCasting(casting, 500n).manaDelta).toEqual({ reserved: -10, consumed: 3, released: 7 });
    expect(interruptCasting(casting, 999n).progressBps).toBe(9990);
  });

  it('calculates concentration and accepts an injected roll', () => {
    const attributes = getInitialAttributePreset('balanced');
    const result = calculateConcentration(attributes, 5, 2, 10, 50, 3);
    expect(result).toEqual({ concentrationScore: 37, concentrationDifficulty: 43 });
    expect(concentrationSucceeds(result.concentrationScore, result.concentrationDifficulty, 6)).toBe(true);
    expect(concentrationSucceeds(result.concentrationScore, result.concentrationDifficulty, 5)).toBe(false);
  });

  it('requires explicit mobile casting slowdown and schedules bounded channel pulses', () => {
    expect(() => calculateMobileCastTime(1000n, false, 12500)).toThrow('not allowed');
    expect(() => calculateMobileCastTime(1000n, true, 12499)).toThrow('between 12500');
    expect(calculateMobileCastTime(1000n, true, 12500)).toBe(1250n);
    expect(scheduleChannelPulses(1000n, 2000n, 250n)).toEqual([1000n, 1250n, 1500n, 1750n, 2000n]);
    expect(() => scheduleChannelPulses(1000n, 2000n, 249n)).toThrow('at least 250');
    expect(startCasting({ startTick: 0n, castTime: 500n, reservedMana: 4, channelInterval: 250n }).state.channelNextPulseTick).toBe(750n);
    expect(scheduleChannelPulseEvents(1000n, 1500n, 250n, {
      eventIdPrefix: 'channel', firstSequence: 10, actorRef: 'mage', actionRef: 'beam',
      initiativeScore: 30, agility: 10, perception: 10, luck: 10, rngTieBreak: 0,
      stableRef: 'mage', reactionDepth: 0,
    })).toMatchObject([
      { eventId: 'channel-1', sequence: 10, type: 'channel_pulse', tick: 1000n },
      { eventId: 'channel-2', sequence: 11, type: 'channel_pulse', tick: 1250n },
      { eventId: 'channel-3', sequence: 12, type: 'channel_pulse', tick: 1500n },
    ]);
  });
});

describe('core-v1 bounded reactions', () => {
  it.each([
    ['block', 100n, 150n, 1000n],
    ['active_dodge', 150n, 250n, 1200n],
    ['interrupt', 150n, 200n, 1500n],
    ['counter_attack', 300n, 400n, 1600n],
  ] as const)('returns immutable %s costs/cooldown', (kind, time, penalty, cooldown) => {
    expect(getReactionDefinition(kind)).toEqual({ time, nextActionPenalty: penalty, cooldown });
    expect(Object.isFrozen(CORE_V1_REACTION_DEFINITIONS[kind])).toBe(true);
  });

  it.each(['block', 'active_dodge', 'interrupt'] as ReactionKind[])('resolves %s at depth 1', (kind) => {
    expect(resolveReaction({
      kind, originActionRef: 'attack', sourceEventIsReaction: false, currentDepth: 0,
      startTick: 100n, originEffectTick: 500n, defensiveReactionAlreadyUsed: false, counterAttackAlreadyUsed: false,
      surprised: false, actorFirstReadyTick: null,
    }).reactionDepth).toBe(1);
  });

  it('allows one terminal counter-attack at depth 2', () => {
    expect(resolveReaction({
      kind: 'counter_attack', originActionRef: 'attack', sourceEventIsReaction: true, currentDepth: 1,
      startTick: 100n, originEffectTick: 500n, defensiveReactionAlreadyUsed: true, counterAttackAlreadyUsed: false,
      surprised: false, actorFirstReadyTick: null,
    })).toMatchObject({ reactionDepth: 2, completionTick: 400n, nextActionPenalty: 400n });
  });

  it('rejects late, repeated, reaction-to-reaction and depth 2/3 chains', () => {
    const base = {
      kind: 'block' as const, originActionRef: 'attack', sourceEventIsReaction: false,
      currentDepth: 0 as const, startTick: 450n, originEffectTick: 500n,
      defensiveReactionAlreadyUsed: false, counterAttackAlreadyUsed: false,
      surprised: false, actorFirstReadyTick: null,
    };
    expect(() => resolveReaction(base)).toThrow('complete before');
    expect(() => resolveReaction({ ...base, startTick: 100n, defensiveReactionAlreadyUsed: true })).toThrow('only one');
    expect(() => resolveReaction({ ...base, startTick: 100n, sourceEventIsReaction: true })).toThrow('cannot react');
    expect(() => resolveReaction({ ...base, startTick: 100n, currentDepth: 2 })).toThrow('terminal');
    expect(() => resolveReaction({ ...base, startTick: 100n, currentDepth: 3 as never })).toThrow('between 0 and 2');
  });

  it('prevents surprised actors from reacting before their first ready tick', () => {
    const request = {
      kind: 'block' as const, originActionRef: 'attack', sourceEventIsReaction: false, currentDepth: 0 as const,
      startTick: 100n, originEffectTick: 1000n, defensiveReactionAlreadyUsed: false,
      counterAttackAlreadyUsed: false, surprised: true, actorFirstReadyTick: 500n,
    };
    expect(() => resolveReaction(request)).toThrow('surprised actor');
    expect(resolveReaction({ ...request, startTick: 500n }).reactionDepth).toBe(1);
  });
});

describe('core-v1 multi-target and atomic combos', () => {
  const combo: MultiTargetActionDefinition = {
    actionKind: 'combo', maxTargets: 1, chainCount: 0, chainInterval: 0n, targetFalloffBps: 0,
    damageMultiplierPerTargetBps: [10000],
    comboSteps: [{ stepRef: 'one', offset: 100n }, { stepRef: 'two', offset: 150n }],
    stopOnMiss: true, maxComboEvents: 2,
  };

  it('validates Whirlwind, a three-target chain and a combo with one XP credit', () => {
    expect(validateMultiTargetAction({ ...combo, actionKind: 'area', maxTargets: 5, comboSteps: [], maxComboEvents: 0 }).maxTargets).toBe(5);
    expect(validateMultiTargetAction({ ...combo, actionKind: 'chain', maxTargets: 3, chainCount: 3, chainInterval: 50n, comboSteps: [], maxComboEvents: 0 }).chainCount).toBe(3);
    expect(validateMultiTargetAction(combo).comboSteps).toHaveLength(2);
    expect(comboXpCreditCount(combo)).toBe(1);
  });

  it('rejects overlong combos, too many events and impacts closer than 50 ticks', () => {
    expect(() => validateMultiTargetAction({
      ...combo, comboSteps: Array.from({ length: 6 }, (_, index) => ({ stepRef: `${index}`, offset: BigInt(index * 50) })), maxComboEvents: 6,
    })).toThrow('at most 5');
    expect(() => validateMultiTargetAction({ ...combo, maxComboEvents: 9 })).toThrow('between 0 and 8');
    expect(() => validateMultiTargetAction({
      ...combo, comboSteps: [{ stepRef: 'one', offset: 100n }, { stepRef: 'two', offset: 149n }],
    })).toThrow('at least 50');
  });
});
