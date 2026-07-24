import {
  ActorContentState,
  ActorStatus,
} from '../../generated/prisma/client.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import type { ActorActiveEffectMechanicalInputs } from '../effects/active-effect-mechanical-inputs.js';
import type { ActorInventoryMechanicalInputs } from '../inventory/inventory-mechanical-inputs.js';
import {
  evaluateEquipmentRequirements,
  resolveCoreV1Cost,
  validateCoreV1ContentProfile,
  validateCoreV1InventorySpec,
  type AuthorizedNumericModifier,
  type CoreV1CostModifierSet,
  type CoreV1EquipmentRequirementContext,
  type CoreV1MechanicalContentProfile,
  type CoreV1ResourceState,
} from '../rules/core-v1/index.js';
import { loadActorMechanicalProjection, type ActorMechanicalSheet } from './actor-mechanics.service.js';

export type ActorReadinessBlockingReason =
  | 'actor_not_active'
  | 'hp_depleted'
  | 'no_usable_starter_action'
  | 'starter_action_resource_insufficient'
  | 'starter_action_cost_unsupported'
  | 'starter_action_requirements_unmet'
  | 'starter_action_targeting_unsupported'
  | 'mechanical_content_incomplete';

export interface ActorReadinessDto {
  readonly status: 'ready' | 'narrative_only' | 'incomplete' | 'blocked';
  readonly canBeginMechanically: boolean;
  readonly canStartEncounter: boolean;
  readonly hasUsableOffensiveAction: boolean;
  readonly hasDefensiveAlternative: boolean;
  readonly hasUtilityCapability: boolean;
  readonly hasStealthCapability: boolean;
  readonly hasDetectionCapability: boolean;
  readonly hasInformationalContent: boolean;
  readonly inventoryValid: boolean;
  readonly equipmentValid: boolean;
  readonly usableActions: readonly {
    readonly source: 'known_content' | 'equipped_weapon' | 'consumable';
    readonly ref: string;
    readonly action: 'cast' | 'attack' | 'use_item';
  }[];
  readonly blockingReasons: readonly ActorReadinessBlockingReason[];
  readonly narrativeContentCount: number;
  readonly narrativeInventoryItemRefs: readonly string[];
  readonly incompleteContentRefs: readonly string[];
  readonly stealthContentRefs: readonly string[];
  readonly detectionContentRefs: readonly string[];
  readonly informationalContentRefs: readonly string[];
}

type ReadinessRow = {
  readonly actor: { readonly status: ActorStatus };
  readonly resources: CoreV1ResourceState;
  readonly requirementContext: CoreV1EquipmentRequirementContext;
  readonly costModifiers?: CoreV1CostModifierSet;
  readonly linked: readonly {
    readonly state: ActorContentState;
    readonly definition: { readonly code: string; readonly contentType?: string };
    readonly version: { readonly profile: unknown };
  }[];
  readonly inventory: readonly {
    readonly entryRef: string;
    readonly entryKind: 'instance' | 'stack';
    readonly quantity: number;
    readonly state: 'available' | 'equipped' | 'reserved' | 'consumed' | 'destroyed' | null;
    readonly definition: { readonly code: string; readonly contentType?: string };
    readonly version: { readonly profile: unknown; readonly inventorySpec: unknown };
  }[];
};

type ActionAvailability = 'usable' | 'resource_insufficient' | 'cost_unsupported' | 'targeting_unsupported';

const spatialTargetingWithoutAuthority = new Set(['area', 'chain', 'cleave']);
const inventoryBoundContentKinds = new Set([
  'weapon', 'armor', 'shield', 'clothing', 'item', 'consumable', 'material',
]);

function isUsablePhysicalEntry(entry: ReadinessRow['inventory'][number]): boolean {
  if (entry.quantity <= 0) return false;
  if (entry.entryKind === 'stack') return true;
  return entry.state === 'available' || entry.state === 'equipped';
}

function isNarrativeNullProfile(contentType: string | undefined, inventory = false): boolean {
  const allowed = inventory ? ['clothing', 'item', 'material', 'other'] : ['clothing', 'item', 'class'];
  return allowed.includes(normalizeEnum(contentType ?? ''));
}

function contentIdentityMatches(
  profile: CoreV1MechanicalContentProfile,
  definition: { readonly code: string; readonly contentType?: string },
): boolean {
  return profile.code === definition.code
    && profile.contentKind === normalizeEnum(definition.contentType ?? profile.contentKind);
}

function hasActionOutcome(profile: CoreV1MechanicalContentProfile): boolean {
  return (profile.damageComponents?.length ?? 0) > 0 || (profile.effects?.length ?? 0) > 0;
}

function hasOffensiveOutcome(profile: CoreV1MechanicalContentProfile): boolean {
  return (profile.damageComponents?.length ?? 0) > 0
    || (profile.effects ?? []).some((effect) => effect.type === 'damage');
}

function profileModifies(profile: CoreV1MechanicalContentProfile, target: string): boolean {
  return (profile.passiveModifiers ?? []).some((modifier) => modifier.target === target)
    || (profile.effects ?? []).some((effect) => (
      effect.type === 'modify_secondary_attribute' && effect.secondaryCode === target
    ));
}

function hasDefensiveOutcome(profile: CoreV1MechanicalContentProfile): boolean {
  return profile.defense !== undefined
    || (profile.effects ?? []).some((effect) => effect.type === 'restore_resource'
      || (effect.type === 'modify_secondary_attribute'
        && ['physicalDefense', 'magicalDefense', 'evasion'].includes(effect.secondaryCode)));
}

function hasInformationalSemantics(profile: CoreV1MechanicalContentProfile): boolean {
  return (profile.tags ?? []).some((tag) => (
    tag === 'informational' || tag === 'detect_hidden' || tag === 'inspect'
    || tag === 'appraise' || tag === 'analyze' || tag === 'identify_content'
  ));
}

function hasUnsupportedTargeting(profile: CoreV1MechanicalContentProfile): boolean {
  const targetings = [
    profile.targeting,
    ...(profile.effects ?? []).flatMap((effect) => 'targeting' in effect ? [effect.targeting] : []),
  ].filter((targeting) => targeting !== undefined);
  return targetings.some((targeting) => spatialTargetingWithoutAuthority.has(targeting.type));
}

function actionAvailability(
  profile: CoreV1MechanicalContentProfile,
  row: ReadinessRow,
): ActionAvailability {
  if (profile.cost.type === 'custom') return 'cost_unsupported';
  if (hasUnsupportedTargeting(profile)) return 'targeting_unsupported';
  const cost = resolveCoreV1Cost({
    tier: profile.tier,
    cost: profile.cost,
    resources: row.resources,
    ...(row.costModifiers === undefined ? {} : { modifiers: row.costModifiers }),
  });
  if (!cost.ok) return 'cost_unsupported';
  return cost.value.affordable ? 'usable' : 'resource_insufficient';
}

function costModifierSet(
  modifiers: readonly { readonly target: string; readonly source: AuthorizedNumericModifier['source']; readonly value: number }[],
): CoreV1CostModifierSet {
  const collect = (target: string) => modifiers
    .filter((modifier) => modifier.target === target)
    .map(({ source, value }) => ({ source, value }));
  const manaCostBps = collect('manaCostBps');
  const spCostBps = collect('spCostBps');
  const hpCostBps = collect('hpCostBps');
  return {
    ...(manaCostBps.length === 0 ? {} : { manaCostBps }),
    ...(spCostBps.length === 0 ? {} : { spCostBps }),
    ...(hpCostBps.length === 0 ? {} : { hpCostBps }),
  };
}

export interface ActorReadinessProjectionInput {
  readonly actor: { readonly status: ActorStatus; readonly level: number };
  readonly sheet: ActorMechanicalSheet;
  readonly inventoryInputs: ActorInventoryMechanicalInputs;
  readonly effectInputs: ActorActiveEffectMechanicalInputs;
  readonly linked: ReadinessRow['linked'];
}

export function projectActorReadiness(input: ActorReadinessProjectionInput): ActorReadinessDto {
  const equipped = input.inventoryInputs.inventory.entries
    .filter((entry) => entry.entryKind === 'instance' && entry.state === 'equipped');
  const knownContentRefs = input.linked
    .filter((link) => link.state === ActorContentState.KNOWN || link.state === ActorContentState.MASTERED)
    .map((link) => ({
      contentKind: normalizeEnum(link.definition.contentType ?? '') as CoreV1EquipmentRequirementContext['knownContentRefs'][number]['contentKind'],
      code: link.definition.code,
    }));
  const requirementContext: CoreV1EquipmentRequirementContext = {
    level: input.actor.level,
    primaryAttributes: input.sheet.primaryAttributes,
    knownContentRefs,
    equippedWeaponTags: equipped.flatMap((entry) => entry.contentVersion.contentType === 'weapon'
      ? [...(entry.profile?.profileMode === 'mechanical' && entry.profile.contentKind === 'weapon'
        ? entry.profile.weaponTags ?? []
        : []), ...(entry.profile?.tags ?? [])]
      : []),
    equippedEquipmentTags: equipped.flatMap((entry) => [...(entry.profile?.tags ?? [])]),
    rulesetCode: input.sheet.ruleset.code,
  };
  return classifyActorReadiness({
    actor: { status: input.actor.status },
    resources: {
      hp: { current: input.sheet.resources.hp.current, maximum: input.sheet.resources.hp.max },
      mana: { current: input.sheet.resources.mana.current, maximum: input.sheet.resources.mana.max },
      sp: { current: input.sheet.resources.sp.current, maximum: input.sheet.resources.sp.max },
    },
    requirementContext,
    costModifiers: costModifierSet([...input.inventoryInputs.modifiers, ...input.effectInputs.modifiers]),
    linked: input.linked,
    inventory: input.inventoryInputs.inventory.entries.map((entry) => ({
      entryRef: entry.entryRef,
      entryKind: entry.entryKind,
      quantity: entry.entryKind === 'stack' ? entry.quantity : 1,
      state: entry.entryKind === 'instance' ? entry.state : null,
      definition: { code: entry.contentVersion.code, contentType: entry.contentVersion.contentType },
      version: { profile: entry.profile, inventorySpec: entry.inventorySpec },
    })),
  });
}

/**
 * READY preserves the encounter-compatible meaning: active actor above zero
 * HP, no relevant malformed mechanics, and at least one affordable action.
 * canBeginMechanically is stricter and also requires an offensive action for a
 * rich quick-start handoff. NARRATIVE_ONLY is reserved for cosmetic/narrative
 * setup with no action. INCOMPLETE reports relevant persisted mechanics that
 * cannot safely execute. BLOCKED covers status, HP, or temporary lack of an
 * affordable action when the persisted mechanics are otherwise coherent.
 */
export function classifyActorReadiness(row: ReadinessRow): ActorReadinessDto {
  const usableActions: ActorReadinessDto['usableActions'][number][] = [];
  const usableOffensiveActionRefs = new Set<string>();
  const incomplete = new Set<string>();
  const narrativeInventoryItemRefs = new Set<string>();
  const stealthContentRefs = new Set<string>();
  const detectionContentRefs = new Set<string>();
  const informationalContentRefs = new Set<string>();
  const observedBlockers = new Set<ActorReadinessBlockingReason>();
  let narrativeContentCount = 0;
  let inventoryValid = true;
  let equipmentValid = true;
  let hasDefensiveAlternative = false;
  let hasUtilityCapability = false;

  const evaluateRelevantProfile = (
    profile: CoreV1MechanicalContentProfile,
    ref: string,
  ): ActionAvailability | 'requirements_unmet' => {
    const requirements = evaluateEquipmentRequirements(profile.requirements, row.requirementContext);
    if (!requirements.met) {
      incomplete.add(ref);
      observedBlockers.add('starter_action_requirements_unmet');
      return 'requirements_unmet';
    }
    const availability = actionAvailability(profile, row);
    if (availability === 'cost_unsupported') {
      incomplete.add(ref);
      observedBlockers.add('starter_action_cost_unsupported');
    } else if (availability === 'targeting_unsupported') {
      incomplete.add(ref);
      observedBlockers.add('starter_action_targeting_unsupported');
    } else if (availability === 'resource_insufficient') {
      observedBlockers.add('starter_action_resource_insufficient');
    }
    return availability;
  };

  for (const link of row.linked) {
    if (link.state !== ActorContentState.KNOWN && link.state !== ActorContentState.MASTERED) continue;
    const validated = validateCoreV1ContentProfile(link.version.profile);
    if (!validated.ok) {
      if (link.version.profile === null && isNarrativeNullProfile(link.definition.contentType)) {
        narrativeContentCount += 1;
        continue;
      }
      incomplete.add(link.definition.code);
      continue;
    }
    const profile = validated.value;
    if (profile.profileMode === 'narrative') {
      narrativeContentCount += 1;
      continue;
    }
    if (!contentIdentityMatches(profile, link.definition)) {
      incomplete.add(link.definition.code);
      continue;
    }
    if (profileModifies(profile, 'stealth') || (profile.tags ?? []).includes('stealth')) {
      stealthContentRefs.add(link.definition.code);
    }
    if (profileModifies(profile, 'detection') || (profile.tags ?? []).includes('detect_hidden')) {
      detectionContentRefs.add(link.definition.code);
    }
    if (hasInformationalSemantics(profile)) informationalContentRefs.add(link.definition.code);
    if (hasDefensiveOutcome(profile)) hasDefensiveAlternative = true;
    if (!hasOffensiveOutcome(profile) && (hasActionOutcome(profile) || hasInformationalSemantics(profile))) {
      hasUtilityCapability = true;
    }
    if (inventoryBoundContentKinds.has(profile.contentKind)) continue;
    if (profile.activation.type !== 'active' || !hasActionOutcome(profile)) continue;
    if (evaluateRelevantProfile(profile, link.definition.code) === 'usable') {
      usableActions.push({ source: 'known_content', ref: link.definition.code, action: 'cast' });
      if (hasOffensiveOutcome(profile)) usableOffensiveActionRefs.add(`known_content:${link.definition.code}`);
    }
  }

  for (const entry of row.inventory) {
    const usablePhysicalEntry = isUsablePhysicalEntry(entry);
    const relevant = entry.state === 'equipped'
      || (normalizeEnum(entry.definition.contentType ?? '') === 'consumable' && usablePhysicalEntry);
    const validated = validateCoreV1ContentProfile(entry.version.profile);
    if (!validated.ok) {
      if (entry.version.profile === null && isNarrativeNullProfile(entry.definition.contentType, true)) {
        const inventorySpec = validateCoreV1InventorySpec(entry.version.inventorySpec);
        if (!inventorySpec.ok) {
          inventoryValid = false;
          if (entry.state === 'equipped') equipmentValid = false;
          if (relevant) incomplete.add(entry.definition.code);
          continue;
        }
        if (usablePhysicalEntry) {
          narrativeContentCount += 1;
          narrativeInventoryItemRefs.add(entry.entryRef);
        }
        continue;
      }
      inventoryValid = false;
      if (entry.state === 'equipped') equipmentValid = false;
      if (relevant) incomplete.add(entry.definition.code);
      continue;
    }
    const profile = validated.value;
    if (profile.profileMode === 'narrative') {
      const inventorySpec = validateCoreV1InventorySpec(entry.version.inventorySpec);
      if (!inventorySpec.ok) {
        inventoryValid = false;
        if (entry.state === 'equipped') equipmentValid = false;
        if (relevant) incomplete.add(entry.definition.code);
        continue;
      }
      if (usablePhysicalEntry) {
        narrativeContentCount += 1;
        narrativeInventoryItemRefs.add(entry.entryRef);
      }
      continue;
    }
    const inventorySpec = validateCoreV1InventorySpec(entry.version.inventorySpec);
    if (!contentIdentityMatches(profile, entry.definition) || !inventorySpec.ok) {
      inventoryValid = false;
      if (entry.state === 'equipped') equipmentValid = false;
      if (relevant) incomplete.add(entry.definition.code);
      continue;
    }
    if (profileModifies(profile, 'stealth') || (profile.tags ?? []).includes('stealth')) {
      stealthContentRefs.add(entry.definition.code);
    }
    if (profileModifies(profile, 'detection') || (profile.tags ?? []).includes('detect_hidden')) {
      detectionContentRefs.add(entry.definition.code);
    }
    if (hasInformationalSemantics(profile)) informationalContentRefs.add(entry.definition.code);
    if (hasDefensiveOutcome(profile)) hasDefensiveAlternative = true;
    if (!relevant) continue;
    const availability = evaluateRelevantProfile(profile, entry.definition.code);
    if (availability !== 'usable') {
      if (entry.state === 'equipped' && availability !== 'resource_insufficient') equipmentValid = false;
      continue;
    }
    if (entry.state === 'equipped' && profile.contentKind === 'weapon'
      && (profile.damageComponents?.length ?? 0) > 0) {
      usableActions.push({ source: 'equipped_weapon', ref: entry.entryRef, action: 'attack' });
      usableOffensiveActionRefs.add(`equipped_weapon:${entry.entryRef}`);
    } else if (usablePhysicalEntry && profile.contentKind === 'consumable'
      && profile.activation.type === 'active' && (profile.effects?.length ?? 0) > 0) {
      usableActions.push({ source: 'consumable', ref: entry.entryRef, action: 'use_item' });
      if (hasOffensiveOutcome(profile)) usableOffensiveActionRefs.add(`consumable:${entry.entryRef}`);
    }
  }

  const blockingReasons: ActorReadinessBlockingReason[] = [];
  if (row.actor.status !== ActorStatus.ACTIVE) blockingReasons.push('actor_not_active');
  if (row.resources.hp.current <= 0) blockingReasons.push('hp_depleted');
  const hasUsableOffensiveAction = usableOffensiveActionRefs.size > 0;
  if (usableActions.length === 0) {
    blockingReasons.push('no_usable_starter_action');
    for (const reason of [
      'starter_action_resource_insufficient',
      'starter_action_cost_unsupported',
      'starter_action_requirements_unmet',
      'starter_action_targeting_unsupported',
    ] as const) {
      if (observedBlockers.has(reason)) blockingReasons.push(reason);
    }
  } else {
    for (const reason of ['starter_action_cost_unsupported', 'starter_action_requirements_unmet', 'starter_action_targeting_unsupported'] as const) {
      if (observedBlockers.has(reason)) blockingReasons.push(reason);
    }
  }
  if (incomplete.size > 0) blockingReasons.push('mechanical_content_incomplete');
  const canStartEncounter = blockingReasons.length === 0;
  return {
    status: canStartEncounter ? 'ready'
      : incomplete.size > 0 ? 'incomplete'
        : narrativeContentCount > 0 && blockingReasons.length === 1 ? 'narrative_only' : 'blocked',
    canBeginMechanically: canStartEncounter && hasUsableOffensiveAction && inventoryValid && equipmentValid,
    canStartEncounter,
    hasUsableOffensiveAction,
    hasDefensiveAlternative,
    hasUtilityCapability,
    hasStealthCapability: stealthContentRefs.size > 0,
    hasDetectionCapability: detectionContentRefs.size > 0,
    hasInformationalContent: informationalContentRefs.size > 0,
    inventoryValid,
    equipmentValid,
    usableActions: usableActions
      .sort((left, right) => `${left.source}:${left.ref}`.localeCompare(`${right.source}:${right.ref}`))
      .slice(0, 128),
    blockingReasons,
    narrativeContentCount,
    narrativeInventoryItemRefs: [...narrativeInventoryItemRefs].sort().slice(0, 128),
    incompleteContentRefs: [...incomplete].sort().slice(0, 128),
    stealthContentRefs: [...stealthContentRefs].sort().slice(0, 128),
    detectionContentRefs: [...detectionContentRefs].sort().slice(0, 128),
    informationalContentRefs: [...informationalContentRefs].sort().slice(0, 128),
  };
}

export async function loadActorReadiness(client: DbClient, actorId: string): Promise<ActorReadinessDto> {
  const actor = await client.actor.findUniqueOrThrow({
    where: { id: actorId },
    select: {
      status: true,
      level: true,
      content: {
        select: {
          state: true,
          contentDefinition: { select: { code: true, contentType: true } },
          contentVersion: { select: { profile: true } },
        },
      },
    },
  });
  const projection = await loadActorMechanicalProjection(client, actorId);
  return projectActorReadiness({
    actor,
    ...projection,
    effectInputs: projection.activeEffectInputs,
    linked: actor.content.map((link) => ({
      state: link.state,
      definition: link.contentDefinition,
      version: link.contentVersion,
    })),
  });
}
