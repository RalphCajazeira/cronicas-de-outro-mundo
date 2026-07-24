import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  CORE_V1_MAX_ENCOUNTER_TICK,
  validateCoreV1ContentProfile,
  validateCoreV1EncounterState,
} from '../rules/core-v1/index.js';
import type { CoreV1EncounterCompletionCandidate, CoreV1EncounterState } from '../rules/core-v1/index.js';
import { CORE_V1_MAX_TECHNICAL_TICK } from '../rules/core-v1/core-v1.action-economy.config.js';
import { CORE_V1_VERSION_CODE } from '../rules/core-v1/core-v1.manifest.js';
import { CORE_V1_2_VERSION_CODE } from '../rules/core-v1/core-v1.progression-v2.js';
import { CORE_V1_3_VERSION_CODE } from '../rules/core-v1/core-v1.progression-v3.js';
import { canonicalJson, canonicalizeJson } from '../../shared/json/canonical-json.js';

export const LEGACY_ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES = 1024 * 1024;

export type CoreV1EncounterSnapshotRulesetVersionCode =
  | typeof CORE_V1_VERSION_CODE
  | typeof CORE_V1_2_VERSION_CODE
  | typeof CORE_V1_3_VERSION_CODE;

type SnapshotValue<T> = T extends bigint
  ? string
  : T extends readonly (infer Item)[]
    ? readonly SnapshotValue<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: SnapshotValue<T[Key]> }
      : T;

export type EncounterStateSnapshotV1 = SnapshotValue<CoreV1EncounterState> & {
  readonly snapshotSchemaVersion: typeof LEGACY_ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION;
};

export type EncounterStateSnapshotV2 = SnapshotValue<CoreV1EncounterState> & {
  readonly snapshotSchemaVersion: typeof ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION;
};

export type EncounterStateSnapshot = EncounterStateSnapshotV1 | EncounterStateSnapshotV2;

type PlainRecord = Record<string, unknown>;

const tickFields = new Set([
  'currentTick', 'firstReadyTick', 'nextActionAtTick', 'lastActionAtTick',
  'appliedAtTick', 'expiresAtTick', 'tick', 'startTick', 'effectTick',
  'preparationTicks', 'recoveryTicks', 'effectTickOffset', 'readyAtTick',
  'completionTick', 'preparedUntilTick', 'channelNextPulseTick',
]);
const activeEffectTechnicalTickPath = /^\$\.participants\.\d+\.activeEffects\.\d+\.(?:appliedAtTick|durationState\.expiresAtTick)$/;
const primaryAttributeFields = [
  'strength', 'vitality', 'agility', 'dexterity', 'intelligence',
  'wisdom', 'perception', 'willpower', 'luck',
] as const;
const legacySecondaryAttributeFields = [
  'actorPhysicalPower', 'actorMagicalPower', 'physicalDefense', 'magicalDefense',
  'accuracy', 'evasion', 'baseAttackSpeedBps', 'baseCastingSpeedBps',
  'criticalChanceBps', 'criticalDamageBps', 'movementSpeed', 'carryingCapacity',
  'physicalResistanceBps', 'magicalResistanceBps', 'elementalResistanceBps',
  'hpRegen', 'manaRegen', 'spRegen',
] as const;
const currentSecondaryAttributeFields = [
  'actorPhysicalPower', 'actorMagicalPower', 'physicalDefense', 'magicalDefense',
  'accuracy', 'evasion', 'stealth', 'detection', 'baseAttackSpeedBps', 'baseCastingSpeedBps',
  'criticalChanceBps', 'criticalDamageBps', 'movementSpeed', 'carryingCapacity',
  'physicalResistanceBps', 'magicalResistanceBps', 'elementalResistanceBps',
  'hpRegen', 'manaRegen', 'spRegen',
] as const;
const actionPlanStopConditions = new Set([
  'actorIncapacitated', 'hostileBecomesReady', 'targetSetChangedMaterially',
  'resourceBelowRequired', 'zoneChanged', 'newThreatDetected', 'stateVersionChanged',
  'processingLimit', 'noValidTarget', 'reactionRequired', 'newPlayerIntentRequired',
]);
const completionCandidates = new Set<CoreV1EncounterCompletionCandidate>([
  'party_victory_candidate', 'hostile_victory_candidate', 'stalemate_candidate', 'cancelled',
]);

function plainRecord(value: unknown, path: string): PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as PlainRecord;
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): PlainRecord {
  const record = plainRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`${path}.${key} is not part of snapshot schema 1`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${path}.${key} is required by snapshot schema 1`);
  }
  return record;
}

function arrayValue(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  if (Object.keys(value).length !== value.length) throw new TypeError(`${path} must not be sparse`);
  return value;
}

function assertContentReference(value: unknown, path: string): void {
  exactKeys(value, ['scope', 'contentType', 'code', 'versionNumber'], [], path);
}

function assertCost(value: unknown, path: string): void {
  const record = plainRecord(value, path);
  const requiredByType: Readonly<Record<string, readonly string[]>> = {
    mana: ['type', 'amount'], sp: ['type', 'amount'], hybrid: ['type', 'mana', 'sp'],
    active_defense: ['type', 'sp'], special_dodge: ['type', 'sp'],
    maintenance: ['type', 'resource', 'amount', 'activationCost'], hp: ['type', 'percentBps'],
    none: ['type'], custom: ['type', 'resourceRef', 'amount'],
  };
  const fields = typeof record.type === 'string' ? requiredByType[record.type] : undefined;
  if (fields === undefined) throw new TypeError(`${path}.type is not supported`);
  exactKeys(record, fields, [], path);
}

function assertDuration(value: unknown, path: string): void {
  const record = plainRecord(value, path);
  const durationTypes = new Set(['instant', 'ticks', 'actions', 'scene', 'encounter', 'permanent']);
  if (typeof record.type !== 'string' || !durationTypes.has(record.type)) {
    throw new TypeError(`${path}.type is not supported`);
  }
  exactKeys(record, ['type'], ['value'], path);
  if ((record.type === 'ticks' || record.type === 'actions') !== Object.hasOwn(record, 'value')) {
    throw new TypeError(`${path} has an invalid duration shape`);
  }
}

function assertStacking(value: unknown, path: string): void {
  const record = plainRecord(value, path);
  if (record.type === 'stack_intensity' || record.type === 'stack_duration') {
    exactKeys(record, ['type', 'maxStacks'], [], path);
    return;
  }
  if (record.type !== 'none' && record.type !== 'refresh' && record.type !== 'replace') {
    throw new TypeError(`${path}.type is not supported`);
  }
  exactKeys(record, ['type'], [], path);
}

function assertActiveEffectPayload(value: unknown, path: string): void {
  const payload = plainRecord(value, path);
  if (payload.type === 'status') {
    const status = exactKeys(payload, [
      'type', 'contentVersion', 'profile', 'stacking', 'baseDuration',
    ], [], path);
    assertContentReference(status.contentVersion, `${path}.contentVersion`);
    if (!validateCoreV1ContentProfile(status.profile).ok) {
      throw new TypeError(`${path}.profile is not a valid closed core-v1 profile`);
    }
    assertStacking(status.stacking, `${path}.stacking`);
    assertDuration(status.baseDuration, `${path}.baseDuration`);
    return;
  }
  if (payload.type === 'primary_modifier') {
    exactKeys(payload, ['type', 'attributeCode', 'amount'], [], path);
    return;
  }
  if (payload.type === 'secondary_modifier') {
    exactKeys(payload, ['type', 'secondaryCode', 'amount'], [], path);
    return;
  }
  if (payload.type === 'reaction_grant') {
    exactKeys(payload, ['type', 'reactionKind', 'reactionDepth'], [], path);
    return;
  }
  throw new TypeError(`${path}.type is not supported`);
}

function assertActiveEffect(value: unknown, path: string): void {
  const effect = exactKeys(value, [
    'effectRef', 'sourceActorRef', 'targetActorRef', 'sourceContent', 'effectIndex',
    'kind', 'stacks', 'appliedAtTick', 'durationState', 'payload',
  ], [], path);
  assertContentReference(effect.sourceContent, `${path}.sourceContent`);
  const duration = plainRecord(effect.durationState, `${path}.durationState`);
  if (duration.type === 'ticks') exactKeys(duration, ['type', 'expiresAtTick'], [], `${path}.durationState`);
  else if (duration.type === 'actions') exactKeys(duration, ['type', 'remainingActions'], [], `${path}.durationState`);
  else exactKeys(duration, ['type', 'scope'], [], `${path}.durationState`);
  assertActiveEffectPayload(effect.payload, `${path}.payload`);
}

function assertParticipant(value: unknown, path: string, requiresStealthState: boolean): void {
  const participant = exactKeys(value, [
    'actorRef', 'sideRef', 'actorStateVersion', 'mechanicsStateVersion', 'inventoryStateVersion',
    'effectsStateVersion', 'zone', 'combatState', 'primaryAttributes', 'resources',
    'secondaryAttributes', 'activeEffects', 'actionSlots', 'reactionCapabilities',
    'equipmentContext', 'initiative',
    ...(requiresStealthState ? ['stealthState'] : []),
  ], [], path);
  const resources = exactKeys(participant.resources, ['hp', 'mana', 'sp'], ['customResources'], `${path}.resources`);
  exactKeys(participant.primaryAttributes, primaryAttributeFields, [], `${path}.primaryAttributes`);
  exactKeys(
    participant.secondaryAttributes,
    requiresStealthState ? currentSecondaryAttributeFields : legacySecondaryAttributeFields,
    [],
    `${path}.secondaryAttributes`,
  );
  for (const pool of ['hp', 'mana', 'sp']) exactKeys(resources[pool], ['current', 'maximum'], [], `${path}.resources.${pool}`);
  for (const [index, effect] of arrayValue(participant.activeEffects, `${path}.activeEffects`).entries()) {
    assertActiveEffect(effect, `${path}.activeEffects.${index}`);
  }
  for (const [index, slot] of arrayValue(participant.actionSlots, `${path}.actionSlots`).entries()) {
    exactKeys(slot, [
      'slotRef', 'slotType', 'nextActionAtTick', 'lastActionAtTick', 'allowedActionTags',
      'potencyMultiplierBps', 'stateVersion',
    ], [], `${path}.actionSlots.${index}`);
  }
  for (const [index, capability] of arrayValue(participant.reactionCapabilities, `${path}.reactionCapabilities`).entries()) {
    const record = exactKeys(capability, ['capabilityRef', 'kind', 'tier', 'cost'], ['blockValue'], `${path}.reactionCapabilities.${index}`);
    assertCost(record.cost, `${path}.reactionCapabilities.${index}.cost`);
  }
  const equipment = exactKeys(participant.equipmentContext, ['inventory', 'loadout', 'requirements'], [], `${path}.equipmentContext`);
  exactKeys(equipment.inventory, ['entries'], [], `${path}.equipmentContext.inventory`);
  exactKeys(equipment.loadout, ['slots'], [], `${path}.equipmentContext.loadout`);
  const requirements = exactKeys(equipment.requirements, [
    'level', 'primaryAttributes', 'knownContentRefs', 'equippedWeaponTags',
    'equippedEquipmentTags', 'rulesetCode',
  ], [], `${path}.equipmentContext.requirements`);
  exactKeys(requirements.primaryAttributes, primaryAttributeFields, [], `${path}.equipmentContext.requirements.primaryAttributes`);
  for (const [index, contentRef] of arrayValue(
    requirements.knownContentRefs,
    `${path}.equipmentContext.requirements.knownContentRefs`,
  ).entries()) {
    exactKeys(contentRef, ['contentKind', 'code'], [], `${path}.equipmentContext.requirements.knownContentRefs.${index}`);
  }
  exactKeys(participant.initiative, ['score', 'tieBreak', 'firstReadyTick', 'surprised'], [], `${path}.initiative`);
  if (requiresStealthState) {
    const stealthState = exactKeys(
      participant.stealthState,
      ['visibility', 'observerAwareness'],
      [],
      `${path}.stealthState`,
    );
    for (const [index, awareness] of arrayValue(
      stealthState.observerAwareness,
      `${path}.stealthState.observerAwareness`,
    ).entries()) {
      exactKeys(
        awareness,
        ['observerActorRef', 'awareness', 'margin', 'marginTier'],
        [],
        `${path}.stealthState.observerAwareness.${index}`,
      );
    }
  }
}

function assertTimelineEvent(value: unknown, path: string): void {
  exactKeys(value, [
    'eventId', 'sequence', 'type', 'tick', 'actorRef', 'initiativeScore', 'agility',
    'perception', 'luck', 'rngTieBreak', 'stableRef', 'reactionDepth',
  ], ['actionRef'], path);
}

function assertEncounterEvent(value: unknown, path: string): void {
  const event = exactKeys(value, ['eventRef', 'type', 'timelineEvent'], [
    'actionRef', 'targetRef', 'targetOrdinal', 'comboStepRef', 'reactionKind',
  ], path);
  assertTimelineEvent(event.timelineEvent, `${path}.timelineEvent`);
}

function assertCooldown(value: unknown, path: string): void {
  exactKeys(value, ['actorRef', 'cooldownRef', 'readyAtTick', 'sourceKind'], [], path);
}

function assertReactionPolicy(value: unknown, path: string): void {
  exactKeys(value, ['mode', 'allowCounterAttack'], ['preferredReaction'], path);
}

function assertIntent(value: unknown, path: string): void {
  const intent = exactKeys(value, [
    'intentRef', 'sourceActorRef', 'slotRef', 'actionSource', 'targetSelector', 'requestedTargetRefs',
  ], ['contentRef', 'weaponEntryRef', 'versatileMode', 'reactionPolicy'], path);
  if (intent.contentRef !== undefined) assertContentReference(intent.contentRef, `${path}.contentRef`);
  if (intent.reactionPolicy !== undefined) assertReactionPolicy(intent.reactionPolicy, `${path}.reactionPolicy`);
}

function assertDamageComponent(value: unknown, path: string): void {
  exactKeys(value, ['id', 'channel', 'element', 'baseDamage', 'scaling', 'canCrit'], [], path);
}

function assertCostModifiers(value: unknown, path: string): void {
  const modifiers = exactKeys(value, [], ['manaCostBps', 'spCostBps', 'hpCostBps'], path);
  for (const [resource, entries] of Object.entries(modifiers)) {
    for (const [index, modifier] of arrayValue(entries, `${path}.${resource}`).entries()) {
      const record = exactKeys(modifier, ['source', 'value'], [], `${path}.${resource}.${index}`);
      exactKeys(record.source, ['type', 'ref'], [], `${path}.${resource}.${index}.source`);
    }
  }
}

function assertDefense(value: unknown, path: string): void {
  const defense = exactKeys(value, ['blockValue', 'completeBlock'], [
    'temporaryImmunities', 'temporaryResistances',
  ], path);
  if (defense.temporaryImmunities !== undefined) {
    exactKeys(defense.temporaryImmunities, [], ['physical', 'magical', 'elements', 'componentIds'], `${path}.temporaryImmunities`);
  }
  if (defense.temporaryResistances !== undefined) {
    const resistances = exactKeys(defense.temporaryResistances, [
      'physicalResistanceBps', 'magicalResistanceBps',
    ], ['elementalResistanceBps'], `${path}.temporaryResistances`);
    if (resistances.elementalResistanceBps !== undefined) {
      plainRecord(resistances.elementalResistanceBps, `${path}.temporaryResistances.elementalResistanceBps`);
    }
  }
}

function assertExecutionPlan(value: unknown, path: string): void {
  const plan = exactKeys(value, [
    'effectRefs', 'statusDefinitions', 'runtimeDurations', 'weaponDamageComponents', 'defenses',
    'reactionPolicy', 'comboStopOnMiss',
  ], ['profile', 'contentRef', 'costModifiers', 'movement', 'castingState', 'consumedEntryRef'], path);
  if (plan.profile !== undefined && !validateCoreV1ContentProfile(plan.profile).ok) {
    throw new TypeError(`${path}.profile is not a valid closed core-v1 profile`);
  }
  if (plan.contentRef !== undefined) assertContentReference(plan.contentRef, `${path}.contentRef`);
  for (const [index, binding] of arrayValue(plan.statusDefinitions, `${path}.statusDefinitions`).entries()) {
    const record = exactKeys(binding, ['effectIndex', 'effectRef', 'contentVersion'], ['profile'], `${path}.statusDefinitions.${index}`);
    assertContentReference(record.contentVersion, `${path}.statusDefinitions.${index}.contentVersion`);
    if (record.profile !== undefined && !validateCoreV1ContentProfile(record.profile).ok) {
      throw new TypeError(`${path}.statusDefinitions.${index}.profile is invalid`);
    }
  }
  for (const [index, binding] of arrayValue(plan.runtimeDurations, `${path}.runtimeDurations`).entries()) {
    const record = exactKeys(binding, ['effectIndex', 'duration'], [], `${path}.runtimeDurations.${index}`);
    assertDuration(record.duration, `${path}.runtimeDurations.${index}.duration`);
  }
  for (const [index, component] of arrayValue(plan.weaponDamageComponents, `${path}.weaponDamageComponents`).entries()) {
    assertDamageComponent(component, `${path}.weaponDamageComponents.${index}`);
  }
  if (plan.costModifiers !== undefined) assertCostModifiers(plan.costModifiers, `${path}.costModifiers`);
  for (const [actorRef, defense] of Object.entries(plainRecord(plan.defenses, `${path}.defenses`))) {
    assertDefense(defense, `${path}.defenses.${actorRef}`);
  }
  if (plan.movement !== undefined) exactKeys(plan.movement, ['kind', 'from', 'to', 'terrain'], ['combinedActionAllowed'], `${path}.movement`);
  if (plan.castingState !== undefined) exactKeys(plan.castingState, [
    'startTick', 'completionTick', 'reservedMana', 'phase', 'preparedUntilTick', 'channelNextPulseTick',
  ], [], `${path}.castingState`);
  assertReactionPolicy(plan.reactionPolicy, `${path}.reactionPolicy`);
}

function assertActiveAction(value: unknown, path: string): void {
  const action = exactKeys(value, [
    'actionRef', 'intentRef', 'sourceActorRef', 'slotRef', 'actionKind', 'startTick', 'effectTick',
    'nextActionAtTick', 'preparationTicks', 'recoveryTicks', 'targets', 'reactionDepth',
    'interruptible', 'blockable', 'dodgeable', 'canRetargetBeforeEffect',
    'resourceReservationPlan', 'cooldownPlan', 'upkeepPlan', 'internalEvents', 'executionPlan',
    'state', 'costApplied', 'selfEffectsApplied', 'dodgedTargetRefs',
  ], ['contentRef'], path);
  if (action.contentRef !== undefined) assertContentReference(action.contentRef, `${path}.contentRef`);
  for (const [index, target] of arrayValue(action.targets, `${path}.targets`).entries()) {
    exactKeys(target, ['targetRef', 'targetOrdinal', 'damageMultiplierBps', 'effectTickOffset'], [], `${path}.targets.${index}`);
  }
  const reservations = exactKeys(action.resourceReservationPlan, ['cost', 'affordable', 'reservations'], [], `${path}.resourceReservationPlan`);
  assertCost(reservations.cost, `${path}.resourceReservationPlan.cost`);
  for (const [index, reservation] of arrayValue(reservations.reservations, `${path}.resourceReservationPlan.reservations`).entries()) {
    exactKeys(reservation, ['resource', 'amount'], [], `${path}.resourceReservationPlan.reservations.${index}`);
  }
  for (const [index, cooldown] of arrayValue(action.cooldownPlan, `${path}.cooldownPlan`).entries()) {
    assertCooldown(cooldown, `${path}.cooldownPlan.${index}`);
  }
  for (const [index, upkeep] of arrayValue(action.upkeepPlan, `${path}.upkeepPlan`).entries()) {
    exactKeys(upkeep, ['resource', 'amount'], [], `${path}.upkeepPlan.${index}`);
  }
  for (const [index, event] of arrayValue(action.internalEvents, `${path}.internalEvents`).entries()) {
    assertEncounterEvent(event, `${path}.internalEvents.${index}`);
  }
  assertExecutionPlan(action.executionPlan, `${path}.executionPlan`);
}

function assertCompletionCandidate(value: unknown, path: string): void {
  if (value !== null && (typeof value !== 'string' || !completionCandidates.has(value as CoreV1EncounterCompletionCandidate))) {
    throw new TypeError(`${path} must be a supported completion candidate or null`);
  }
}

function snapshotSchemaVersionForRulesetVersionCode(
  rulesetVersionCode: CoreV1EncounterSnapshotRulesetVersionCode,
): 1 | 2 {
  return rulesetVersionCode === CORE_V1_3_VERSION_CODE
    ? ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION
    : LEGACY_ENCOUNTER_STATE_SNAPSHOT_SCHEMA_VERSION;
}

export function encounterSnapshotSchemaVersionForRulesetVersionCode(
  rulesetVersionCode: string,
): 1 | 2 {
  assertRulesetVersionCode(rulesetVersionCode);
  return snapshotSchemaVersionForRulesetVersionCode(rulesetVersionCode);
}

function assertRulesetVersionCode(value: string): asserts value is CoreV1EncounterSnapshotRulesetVersionCode {
  if (value !== CORE_V1_VERSION_CODE && value !== CORE_V1_2_VERSION_CODE && value !== CORE_V1_3_VERSION_CODE) {
    throw new TypeError('Encounter snapshot ruleset version is not supported');
  }
}

function assertClosedSnapshot(
  value: unknown,
  rulesetVersionCode: CoreV1EncounterSnapshotRulesetVersionCode,
): asserts value is EncounterStateSnapshot {
  const snapshot = exactKeys(value, [
    'snapshotSchemaVersion', 'schemaVersion', 'rulesetCode', 'encounterRulesCode', 'encounterRef',
    'partySideRef', 'currentTick', 'stateVersion', 'actionSequence', 'status', 'participants',
    'relations', 'scheduledEvents', 'activeActions', 'cooldowns', 'actionPlans', 'completionCandidate',
  ], [], '$');
  const requiresStealthState = rulesetVersionCode === CORE_V1_3_VERSION_CODE;
  if (snapshot.snapshotSchemaVersion !== snapshotSchemaVersionForRulesetVersionCode(rulesetVersionCode)) {
    throw new TypeError('Snapshot schema version is not supported');
  }
  assertCompletionCandidate(snapshot.completionCandidate, '$.completionCandidate');
  for (const [index, participant] of arrayValue(snapshot.participants, '$.participants').entries()) {
    assertParticipant(participant, `$.participants.${index}`, requiresStealthState);
  }
  for (const [index, relation] of arrayValue(snapshot.relations, '$.relations').entries()) {
    exactKeys(relation, ['leftActorRef', 'rightActorRef', 'relation'], [], `$.relations.${index}`);
  }
  for (const [index, event] of arrayValue(snapshot.scheduledEvents, '$.scheduledEvents').entries()) {
    assertEncounterEvent(event, `$.scheduledEvents.${index}`);
  }
  for (const [index, action] of arrayValue(snapshot.activeActions, '$.activeActions').entries()) {
    assertActiveAction(action, `$.activeActions.${index}`);
  }
  for (const [index, cooldown] of arrayValue(snapshot.cooldowns, '$.cooldowns').entries()) {
    assertCooldown(cooldown, `$.cooldowns.${index}`);
  }
  for (const [index, plan] of arrayValue(snapshot.actionPlans, '$.actionPlans').entries()) {
    const record = exactKeys(plan, ['planRef', 'actorRef', 'expectedStateVersion', 'intents', 'stopConditions'], [], `$.actionPlans.${index}`);
    for (const [intentIndex, intent] of arrayValue(record.intents, `$.actionPlans.${index}.intents`).entries()) {
      assertIntent(intent, `$.actionPlans.${index}.intents.${intentIndex}`);
    }
    for (const condition of arrayValue(record.stopConditions, `$.actionPlans.${index}.stopConditions`)) {
      if (typeof condition !== 'string' || !actionPlanStopConditions.has(condition)) {
        throw new TypeError(`$.actionPlans.${index}.stopConditions contains an unsupported value`);
      }
    }
  }
}

function encodeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (Array.isArray(value)) return value.map(encodeBigInts);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeBigInts(child)]));
  }
  return value;
}

function parseTick(value: unknown, path: string, maximum: bigint): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${path} must be a canonical non-negative decimal tick`);
  }
  const tick = BigInt(value);
  if (tick > maximum) throw new RangeError(`${path} exceeds the core-v1 tick limit`);
  return tick;
}

function decodeBigInts(value: unknown, path = '$', field?: string): unknown {
  if (field !== undefined && tickFields.has(field) && value !== null) {
    const maximum = activeEffectTechnicalTickPath.test(path)
      ? CORE_V1_MAX_TECHNICAL_TICK
      : CORE_V1_MAX_ENCOUNTER_TICK;
    return parseTick(value, path, maximum);
  }
  if (Array.isArray(value)) return value.map((child, index) => decodeBigInts(child, `${path}.${index}`));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeBigInts(child, `${path}.${key}`, key)]));
  }
  return value;
}

function canonicalSnapshot(value: unknown): EncounterStateSnapshot {
  return canonicalizeJson(value) as unknown as EncounterStateSnapshot;
}

function assertSnapshotSize(value: unknown): void {
  const bytes = Buffer.byteLength(canonicalJson(value), 'utf8');
  if (bytes > ENCOUNTER_STATE_SNAPSHOT_MAX_BYTES) {
    throw new RangeError('Encounter state snapshot exceeds the 1 MiB UTF-8 limit');
  }
}

function legacySnapshotState(encodedState: PlainRecord): PlainRecord {
  return {
    ...encodedState,
    participants: arrayValue(encodedState.participants, '$.participants').map((participant, index) => {
      const record = plainRecord(participant, `$.participants.${index}`);
      const legacyParticipant = { ...record };
      delete legacyParticipant.stealthState;
      const secondary = plainRecord(record.secondaryAttributes, `$.participants.${index}.secondaryAttributes`);
      const legacySecondary = { ...secondary };
      delete legacySecondary.stealth;
      delete legacySecondary.detection;
      return { ...legacyParticipant, secondaryAttributes: legacySecondary };
    }),
  };
}

function projectLegacySnapshotState(decodedState: PlainRecord): PlainRecord {
  return {
    ...decodedState,
    participants: arrayValue(decodedState.participants, '$.participants').map((participant, index) => {
      const record = plainRecord(participant, `$.participants.${index}`);
      const secondary = plainRecord(record.secondaryAttributes, `$.participants.${index}.secondaryAttributes`);
      return {
        ...record,
        secondaryAttributes: { ...secondary, stealth: 0, detection: 0 },
      };
    }),
  };
}

export function serializeCoreV1EncounterState(
  state: CoreV1EncounterState,
  rulesetVersionCode: string = CORE_V1_3_VERSION_CODE,
): EncounterStateSnapshot {
  assertRulesetVersionCode(rulesetVersionCode);
  const validated = validateCoreV1EncounterState(state);
  if (!validated.ok) throw new TypeError('Core-v1 encounter state is invalid');
  const encodedState = plainRecord(encodeBigInts(validated.value), '$');
  const encoded = {
    snapshotSchemaVersion: snapshotSchemaVersionForRulesetVersionCode(rulesetVersionCode),
    ...(rulesetVersionCode === CORE_V1_3_VERSION_CODE ? encodedState : legacySnapshotState(encodedState)),
  };
  assertClosedSnapshot(encoded, rulesetVersionCode);
  assertSnapshotSize(encoded);
  return canonicalSnapshot(encoded);
}

export function parseCoreV1EncounterSnapshot(
  snapshot: unknown,
  rulesetVersionCode: string = CORE_V1_3_VERSION_CODE,
): CoreV1EncounterState {
  assertRulesetVersionCode(rulesetVersionCode);
  assertSnapshotSize(snapshot);
  assertClosedSnapshot(snapshot, rulesetVersionCode);
  const encodedState = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => key !== 'snapshotSchemaVersion'),
  );
  const decoded = plainRecord(decodeBigInts(encodedState), '$');
  const projected = rulesetVersionCode === CORE_V1_3_VERSION_CODE
    ? decoded
    : projectLegacySnapshotState(decoded);
  const validated = validateCoreV1EncounterState(projected);
  if (!validated.ok) throw new TypeError('Encounter state snapshot does not contain a valid core-v1 state');
  return validated.value;
}

export function createCoreV1EncounterSnapshotHash(
  snapshot: unknown,
  rulesetVersionCode: string = CORE_V1_3_VERSION_CODE,
): string {
  assertRulesetVersionCode(rulesetVersionCode);
  // Parsing is intentionally performed before hashing so malformed historical
  // payloads never become acceptable merely because their raw JSON can hash.
  parseCoreV1EncounterSnapshot(snapshot, rulesetVersionCode);
  const canonical = rulesetVersionCode === CORE_V1_3_VERSION_CODE
    ? serializeCoreV1EncounterState(parseCoreV1EncounterSnapshot(snapshot, rulesetVersionCode), rulesetVersionCode)
    : canonicalSnapshot(snapshot);
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
