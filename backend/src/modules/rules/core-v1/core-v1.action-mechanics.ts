import {
  CORE_V1_MAX_COMBO_EVENTS, CORE_V1_MAX_COMBO_STEPS, CORE_V1_MIN_IMPACT_INTERVAL,
  CORE_V1_REACTION_DEFINITIONS, CORE_V1_TERRAIN_MULTIPLIER_BPS,
} from './core-v1.action-economy.config.js';
import type {
  CastingState, CombatZone, ComboStep, ManaDelta, MovementKind, MovementResult,
  MultiTargetActionDefinition, ReactionDefinition, ReactionKind, ReactionRequest,
  ReactionResolution, TerrainType, TimelineEvent,
} from './core-v1.action-economy.types.js';
import type { PrimaryAttributes } from './core-v1.types.js';
import {
  assertInteger, assertIntegerInRange, roundHalfUp, safeIntegerAdd, safeIntegerMultiply, safeIntegerSum,
} from './core-v1.math.js';
import { applyTickMultiplier } from './core-v1.temporal.js';
import { addTicks, assertCombatTick, assertTick, validateCooldown } from './core-v1.ticks.js';

const zones = Object.freeze(['engaged', 'near', 'medium', 'far', 'out_of_range'] as const);
const multiTargetKinds = new Set<MultiTargetActionDefinition['actionKind']>([
  'single', 'multi_target', 'area', 'chain', 'cleave', 'combo',
]);

function assertNonNegativeInteger(value: number, name: string): void {
  assertInteger(value, name);
  if (value < 0) throw new RangeError(`${name} must not be negative`);
}

export function zoneDistance(from: CombatZone, to: CombatZone): number {
  const fromIndex = zones.indexOf(from);
  const toIndex = zones.indexOf(to);
  if (fromIndex < 0 || toIndex < 0) throw new TypeError('combat zone is invalid');
  return Math.abs(toIndex - fromIndex);
}

export function isValidZoneTransition(from: CombatZone, to: CombatZone, maximumTransitions = 1): boolean {
  assertIntegerInRange(maximumTransitions, 1, 2, 'maximumTransitions');
  const distance = zoneDistance(from, to);
  return distance >= 1 && distance <= maximumTransitions;
}

export function calculateMovement(
  from: CombatZone,
  to: CombatZone,
  kind: MovementKind,
  terrain: TerrainType,
  options: {
    readonly impeded?: boolean;
    readonly overloaded?: boolean;
    readonly combinedActionAllowed?: boolean;
    readonly combinedActionTime?: bigint;
    readonly startTick?: bigint;
  } = {},
): MovementResult {
  const transitions = zoneDistance(from, to);
  if (transitions === 0) throw new RangeError('movement must change zones');
  if (options.impeded === true) throw new RangeError('movement is impeded');
  if (options.overloaded === true) throw new RangeError('overloaded actors cannot start movement');
  let basePerTransition: bigint;
  let conceptualSpCost = 0;
  if (kind === 'run') {
    if (transitions > 2) throw new RangeError('running supports at most two zone transitions');
    basePerTransition = 700n;
    conceptualSpCost = 3;
  } else if (kind === 'disengage') {
    if (from !== 'engaged' || transitions !== 1) throw new RangeError('disengage must leave engaged by one zone');
    basePerTransition = 1100n;
  } else {
    if (transitions !== 1) throw new RangeError('normal movement must be an adjacent zone transition');
    const direction = zones.indexOf(to) - zones.indexOf(from);
    if (kind === 'approach' && direction >= 0) throw new RangeError('approach must move closer');
    if (kind === 'retreat' && direction <= 0) throw new RangeError('retreat must move farther away');
    basePerTransition = 1000n;
  }
  const multiplier = CORE_V1_TERRAIN_MULTIPLIER_BPS[terrain];
  if (multiplier === undefined) throw new TypeError('terrain is invalid');
  const movementTime = applyTickMultiplier(basePerTransition * BigInt(transitions), multiplier);
  const result: MovementResult = { from, to, transitions, movementTime, conceptualSpCost };
  if (options.combinedActionAllowed === true) {
    if (options.combinedActionTime === undefined || options.startTick === undefined) {
      throw new TypeError('combined movement requires action time and start tick');
    }
    assertTick(options.combinedActionTime, 'combinedActionTime');
    assertCombatTick(options.startTick, 'startTick');
    const combinedActionAtTick = addTicks(addTicks(options.startTick, movementTime, 'movement completion'), options.combinedActionTime, 'combined action tick');
    assertCombatTick(combinedActionAtTick, 'combinedActionAtTick');
    return {
      ...result,
      combinedActionAtTick,
    };
  }
  if (options.combinedActionTime !== undefined) throw new RangeError('combined action must be explicitly allowed');
  return result;
}

export function startCasting(input: {
  readonly startTick: bigint;
  readonly castTime: bigint;
  readonly reservedMana: number;
  readonly preparedUntilTick?: bigint | null;
  readonly channelInterval?: bigint | null;
}): { readonly state: CastingState; readonly manaDelta: ManaDelta } {
  assertCombatTick(input.startTick, 'startTick');
  assertTick(input.castTime, 'castTime');
  if (input.castTime === 0n) throw new RangeError('castTime must be non-zero');
  assertNonNegativeInteger(input.reservedMana, 'reservedMana');
  const completionTick = addTicks(input.startTick, input.castTime, 'casting completion');
  assertCombatTick(completionTick, 'completionTick');
  const preparedUntilTick = input.preparedUntilTick ?? null;
  if (preparedUntilTick !== null) assertCombatTick(preparedUntilTick, 'preparedUntilTick');
  const channelInterval = input.channelInterval ?? null;
  if (channelInterval !== null) {
    assertTick(channelInterval, 'channelInterval');
    if (channelInterval < 250n) throw new RangeError('channelInterval must be at least 250 ticks');
  }
  return {
    state: {
      startTick: input.startTick,
      completionTick,
      reservedMana: input.reservedMana,
      phase: 'casting',
      preparedUntilTick,
      channelNextPulseTick: channelInterval === null ? null : addTicks(completionTick, channelInterval, 'channel pulse'),
    },
    manaDelta: { reserved: input.reservedMana, consumed: 0, released: 0 },
  };
}

export function completeCasting(state: CastingState): { readonly state: CastingState; readonly manaDelta: ManaDelta } {
  if (state.phase !== 'casting') throw new RangeError('only an active cast can complete');
  return {
    state: { ...state, phase: state.channelNextPulseTick === null ? 'completed' : 'channeling' },
    manaDelta: { reserved: -state.reservedMana, consumed: state.reservedMana, released: 0 },
  };
}

export function interruptCasting(state: CastingState, interruptionTick: bigint): {
  readonly state: CastingState;
  readonly progressBps: number;
  readonly manaDelta: ManaDelta;
} {
  if (state.phase !== 'casting') throw new RangeError('only an active cast can be interrupted');
  assertCombatTick(interruptionTick, 'interruptionTick');
  if (interruptionTick < state.startTick || interruptionTick >= state.completionTick) {
    throw new RangeError('interruptionTick must be inside the casting interval');
  }
  const elapsed = interruptionTick - state.startTick;
  const duration = state.completionTick - state.startTick;
  const progressBpsBigInt = elapsed * 10000n / duration;
  const progressBps = Number(progressBpsBigInt);
  const consumed = elapsed * 2n < duration ? 0 : roundHalfUp(state.reservedMana / 4);
  return {
    state: { ...state, phase: 'interrupted', channelNextPulseTick: null },
    progressBps,
    manaDelta: { reserved: -state.reservedMana, consumed, released: state.reservedMana - consumed },
  };
}

export function calculateConcentration(
  attributes: Pick<PrimaryAttributes, 'willpower' | 'wisdom'>,
  relevantSpellRank: number,
  modifiers: number,
  damageReceived: number,
  maxHp: number,
  interruptPower: number,
): { readonly concentrationScore: number; readonly concentrationDifficulty: number } {
  assertIntegerInRange(relevantSpellRank, 0, 10, 'relevantSpellRank');
  [modifiers, damageReceived, maxHp, interruptPower].forEach((value, index) => {
    assertInteger(value, ['modifiers', 'damageReceived', 'maxHp', 'interruptPower'][index] ?? 'concentration input');
  });
  if (damageReceived < 0) throw new RangeError('damageReceived must not be negative');
  if (maxHp <= 0) throw new RangeError('maxHp must be positive');
  return {
    concentrationScore: safeIntegerSum([
      2 * attributes.willpower, attributes.wisdom, relevantSpellRank, modifiers,
    ], 'concentration score'),
    concentrationDifficulty: safeIntegerSum([
      20, roundHalfUp(safeIntegerMultiply(100, damageReceived, 'concentration damage') / maxHp), interruptPower,
    ], 'concentration difficulty'),
  };
}

export function concentrationSucceeds(score: number, difficulty: number, injectedRoll: number): boolean {
  assertInteger(score, 'score');
  assertInteger(difficulty, 'difficulty');
  assertInteger(injectedRoll, 'injectedRoll');
  return safeIntegerSum([score, injectedRoll], 'concentration result') >= difficulty;
}

export function calculateMobileCastTime(castTime: bigint, canMoveWhileCasting: boolean, multiplierBps?: number): bigint {
  if (!canMoveWhileCasting) throw new RangeError('movement while casting is not allowed');
  if (multiplierBps === undefined) throw new TypeError('mobileCastTimeMultiplierBps is required');
  assertIntegerInRange(multiplierBps, 12500, 40000, 'mobileCastTimeMultiplierBps');
  return applyTickMultiplier(castTime, multiplierBps);
}

export function scheduleChannelPulses(
  firstPulseTick: bigint,
  endTick: bigint,
  interval: bigint,
  maximumPulses = 32,
): readonly bigint[] {
  assertCombatTick(firstPulseTick, 'firstPulseTick');
  assertCombatTick(endTick, 'endTick');
  assertTick(interval, 'interval');
  assertIntegerInRange(maximumPulses, 1, 32, 'maximumPulses');
  if (interval < 250n) throw new RangeError('channel interval must be at least 250 ticks');
  if (endTick < firstPulseTick) return [];
  const pulses: bigint[] = [];
  for (let tick = firstPulseTick; tick <= endTick; tick += interval) {
    if (pulses.length === maximumPulses) throw new RangeError('channel pulse limit exceeded');
    pulses.push(tick);
  }
  return pulses;
}

export function scheduleChannelPulseEvents(
  firstPulseTick: bigint,
  endTick: bigint,
  interval: bigint,
  input: Omit<TimelineEvent, 'eventId' | 'sequence' | 'type' | 'tick'> & {
    readonly eventIdPrefix: string;
    readonly firstSequence: number;
  },
): readonly TimelineEvent[] {
  if (input.eventIdPrefix.trim().length === 0) throw new TypeError('eventIdPrefix must not be empty');
  assertIntegerInRange(input.firstSequence, 0, Number.MAX_SAFE_INTEGER, 'firstSequence');
  return scheduleChannelPulses(firstPulseTick, endTick, interval).map((tick, index) => ({
    actorRef: input.actorRef,
    initiativeScore: input.initiativeScore,
    agility: input.agility,
    perception: input.perception,
    luck: input.luck,
    rngTieBreak: input.rngTieBreak,
    stableRef: input.stableRef,
    reactionDepth: input.reactionDepth,
    ...(input.actionRef === undefined ? {} : { actionRef: input.actionRef }),
    eventId: `${input.eventIdPrefix}-${index + 1}`,
    sequence: safeIntegerAdd(input.firstSequence, index, 'channel pulse sequence'),
    type: 'channel_pulse',
    tick,
  }));
}

export function getReactionDefinition(kind: ReactionKind): ReactionDefinition {
  const definition = CORE_V1_REACTION_DEFINITIONS[kind];
  if (definition === undefined) throw new TypeError('reaction kind is invalid');
  validateCooldown(definition.cooldown);
  return { ...definition };
}

export function resolveReaction(request: ReactionRequest): ReactionResolution {
  if (request.currentDepth < 0 || request.currentDepth > 2) throw new RangeError('reaction depth must be between 0 and 2');
  if (request.currentDepth === 2) throw new RangeError('reaction depth 2 is terminal');
  const isCounter = request.kind === 'counter_attack';
  if (request.sourceEventIsReaction && !isCounter) throw new RangeError('reactions cannot react to reactions');
  if (isCounter && request.currentDepth !== 1) throw new RangeError('counter-attack requires a depth 1 defensive reaction');
  if (!isCounter && request.currentDepth !== 0) throw new RangeError('defensive reaction requires an originating action');
  if (isCounter && request.counterAttackAlreadyUsed) throw new RangeError('only one counter-attack is allowed');
  if (!isCounter && request.defensiveReactionAlreadyUsed) throw new RangeError('only one defensive reaction is allowed');
  assertCombatTick(request.startTick, 'reaction startTick');
  assertCombatTick(request.originEffectTick, 'originEffectTick');
  if (typeof request.surprised !== 'boolean') throw new TypeError('surprised must be boolean');
  if (request.actorFirstReadyTick !== null) assertCombatTick(request.actorFirstReadyTick, 'actorFirstReadyTick');
  if (request.surprised && (request.actorFirstReadyTick === null || request.startTick < request.actorFirstReadyTick)) {
    throw new RangeError('a surprised actor cannot react before its first ready tick');
  }
  const definition = getReactionDefinition(request.kind);
  const completionTick = addTicks(request.startTick, definition.time, 'reaction completion');
  if (completionTick >= request.originEffectTick) throw new RangeError('reaction must complete before the action effect tick');
  const cooldownUntilTick = addTicks(completionTick, definition.cooldown, 'reaction cooldown');
  assertCombatTick(cooldownUntilTick, 'cooldownUntilTick');
  return {
    kind: request.kind,
    reactionDepth: isCounter ? 2 : 1,
    completionTick,
    nextActionPenalty: definition.nextActionPenalty,
    cooldownUntilTick,
  };
}

function cloneComboStep(step: ComboStep): ComboStep {
  return step.interruptWindow === undefined ? { stepRef: step.stepRef, offset: step.offset } : { ...step };
}

export function validateMultiTargetAction(definition: MultiTargetActionDefinition): MultiTargetActionDefinition {
  if (!multiTargetKinds.has(definition.actionKind)) throw new TypeError('multi-target action kind is invalid');
  if (typeof definition.stopOnMiss !== 'boolean') throw new TypeError('stopOnMiss must be boolean');
  const runtimeMultipliers: unknown = definition.damageMultiplierPerTargetBps;
  const runtimeSteps: unknown = definition.comboSteps;
  if (!Array.isArray(runtimeMultipliers) || !Array.isArray(runtimeSteps)) {
    throw new TypeError('multi-target multipliers and comboSteps must be arrays');
  }
  assertIntegerInRange(definition.maxTargets, 1, 64, 'maxTargets');
  assertIntegerInRange(definition.chainCount, 0, definition.maxTargets, 'chainCount');
  assertTick(definition.chainInterval, 'chainInterval');
  assertIntegerInRange(definition.targetFalloffBps, 0, 10000, 'targetFalloffBps');
  assertIntegerInRange(definition.maxComboEvents, 0, CORE_V1_MAX_COMBO_EVENTS, 'maxComboEvents');
  if (definition.comboSteps.length > CORE_V1_MAX_COMBO_STEPS) throw new RangeError('combo supports at most 5 steps');
  if (definition.actionKind === 'combo' && definition.comboSteps.length === 0) {
    throw new RangeError('combo actions require at least one step');
  }
  if (definition.actionKind !== 'combo' && definition.comboSteps.length > 0) {
    throw new RangeError('only combo actions can declare combo steps');
  }
  if (definition.actionKind === 'chain' && definition.chainCount < 1) {
    throw new RangeError('chain actions require at least one chained target');
  }
  if (definition.maxComboEvents < definition.comboSteps.length) throw new RangeError('combo events cannot be fewer than combo steps');
  if (definition.damageMultiplierPerTargetBps.length > definition.maxTargets) {
    throw new RangeError('per-target multipliers exceed maxTargets');
  }
  definition.damageMultiplierPerTargetBps.forEach((value) => assertIntegerInRange(value, 0, 20000, 'target multiplier'));
  let previousOffset: bigint | null = null;
  const refs = new Set<string>();
  for (const step of definition.comboSteps) {
    if (step.stepRef.trim().length === 0 || refs.has(step.stepRef)) throw new RangeError('combo step refs must be unique and non-empty');
    refs.add(step.stepRef);
    assertTick(step.offset, 'combo step offset');
    if (previousOffset !== null && step.offset - previousOffset < CORE_V1_MIN_IMPACT_INTERVAL) {
      throw new RangeError('combo impacts must be at least 50 ticks apart');
    }
    if (step.interruptWindow !== undefined) {
      assertTick(step.interruptWindow, 'interruptWindow');
      if (step.interruptWindow > step.offset) throw new RangeError('interruptWindow must not exceed step offset');
    }
    previousOffset = step.offset;
  }
  if (definition.actionKind === 'chain' && definition.chainCount > 1 && definition.chainInterval < CORE_V1_MIN_IMPACT_INTERVAL) {
    throw new RangeError('chain impacts must be at least 50 ticks apart');
  }
  return {
    ...definition,
    damageMultiplierPerTargetBps: [...definition.damageMultiplierPerTargetBps],
    comboSteps: definition.comboSteps.map(cloneComboStep),
  };
}

export function comboXpCreditCount(definition: MultiTargetActionDefinition): number {
  validateMultiTargetAction(definition);
  return 1;
}
