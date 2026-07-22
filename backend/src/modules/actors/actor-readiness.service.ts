import {
  ActorContentState,
  ActorStatus,
} from '../../generated/prisma/client.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { loadActorActiveEffectMechanicalInputs } from '../effects/active-effect-mechanical-inputs.js';
import { loadActorInventoryMechanicalInputs } from '../inventory/inventory-mechanical-inputs.js';
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
import { loadActorMechanicalSheet } from './actor-mechanics.service.js';

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
  readonly canStartEncounter: boolean;
  readonly usableActions: readonly {
    readonly source: 'known_content' | 'equipped_weapon' | 'consumable';
    readonly ref: string;
    readonly action: 'cast' | 'attack' | 'use_item';
  }[];
  readonly blockingReasons: readonly ActorReadinessBlockingReason[];
  readonly narrativeContentCount: number;
  readonly incompleteContentRefs: readonly string[];
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
  const allowed = inventory ? ['clothing', 'item'] : ['clothing', 'item', 'class'];
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

/**
 * READY requires an active actor above zero HP, no relevant malformed or
 * unevaluable mechanics, and at least one action affordable with the current
 * authoritative resources. NARRATIVE_ONLY is reserved for cosmetic/narrative
 * setup with no action. INCOMPLETE reports relevant persisted mechanics that
 * cannot safely execute. BLOCKED covers status, HP, or temporary lack of an
 * affordable action when the persisted mechanics are otherwise coherent.
 */
export function classifyActorReadiness(row: ReadinessRow): ActorReadinessDto {
  const usableActions: ActorReadinessDto['usableActions'][number][] = [];
  const incomplete = new Set<string>();
  const observedBlockers = new Set<ActorReadinessBlockingReason>();
  let narrativeContentCount = 0;

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
    if (inventoryBoundContentKinds.has(profile.contentKind)) continue;
    if (profile.activation.type !== 'active' || !hasActionOutcome(profile)) continue;
    if (evaluateRelevantProfile(profile, link.definition.code) === 'usable') {
      usableActions.push({ source: 'known_content', ref: link.definition.code, action: 'cast' });
    }
  }

  for (const entry of row.inventory) {
    const usablePhysicalEntry = isUsablePhysicalEntry(entry);
    const relevant = entry.state === 'equipped'
      || (normalizeEnum(entry.definition.contentType ?? '') === 'consumable' && usablePhysicalEntry);
    const validated = validateCoreV1ContentProfile(entry.version.profile);
    if (!validated.ok) {
      if (entry.version.profile === null && isNarrativeNullProfile(entry.definition.contentType, true)) {
        if (usablePhysicalEntry) narrativeContentCount += 1;
        continue;
      }
      if (relevant) incomplete.add(entry.definition.code);
      continue;
    }
    const profile = validated.value;
    if (profile.profileMode === 'narrative') {
      if (usablePhysicalEntry) narrativeContentCount += 1;
      continue;
    }
    if (!relevant) continue;
    const inventorySpec = validateCoreV1InventorySpec(entry.version.inventorySpec);
    if (!contentIdentityMatches(profile, entry.definition) || !inventorySpec.ok) {
      incomplete.add(entry.definition.code);
      continue;
    }
    const availability = evaluateRelevantProfile(profile, entry.definition.code);
    if (availability !== 'usable') continue;
    if (entry.state === 'equipped' && profile.contentKind === 'weapon'
      && (profile.damageComponents?.length ?? 0) > 0) {
      usableActions.push({ source: 'equipped_weapon', ref: entry.entryRef, action: 'attack' });
    } else if (usablePhysicalEntry && profile.contentKind === 'consumable'
      && profile.activation.type === 'active' && (profile.effects?.length ?? 0) > 0) {
      usableActions.push({ source: 'consumable', ref: entry.entryRef, action: 'use_item' });
    }
  }

  const blockingReasons: ActorReadinessBlockingReason[] = [];
  if (row.actor.status !== ActorStatus.ACTIVE) blockingReasons.push('actor_not_active');
  if (row.resources.hp.current <= 0) blockingReasons.push('hp_depleted');
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
    canStartEncounter,
    usableActions: usableActions
      .sort((left, right) => `${left.source}:${left.ref}`.localeCompare(`${right.source}:${right.ref}`))
      .slice(0, 128),
    blockingReasons,
    narrativeContentCount,
    incompleteContentRefs: [...incomplete].sort().slice(0, 128),
  };
}

export async function loadActorReadiness(client: DbClient, actorId: string): Promise<ActorReadinessDto> {
  const actor = await client.actor.findUniqueOrThrow({
    where: { id: actorId },
    select: {
      status: true,
      level: true,
      campaign: { select: { engineTick: true } },
      content: {
        select: {
          state: true,
          contentDefinition: { select: { code: true, contentType: true } },
          contentVersion: { select: { profile: true } },
        },
      },
    },
  });
  const [sheet, inventoryInputs, effectInputs] = await Promise.all([
    loadActorMechanicalSheet(client, actorId),
    loadActorInventoryMechanicalInputs(client, actorId),
    loadActorActiveEffectMechanicalInputs(client, actorId, actor.campaign.engineTick),
  ]);
  const knownContentRefs = actor.content
    .filter((link) => link.state === ActorContentState.KNOWN || link.state === ActorContentState.MASTERED)
    .map((link) => ({
      contentKind: normalizeEnum(link.contentDefinition.contentType) as CoreV1EquipmentRequirementContext['knownContentRefs'][number]['contentKind'],
      code: link.contentDefinition.code,
    }));
  const equipped = inventoryInputs.inventory.entries
    .filter((entry) => entry.entryKind === 'instance' && entry.state === 'equipped');
  const requirementContext: CoreV1EquipmentRequirementContext = {
    level: actor.level,
    primaryAttributes: sheet.primaryAttributes,
    knownContentRefs,
    equippedWeaponTags: equipped.flatMap((entry) => entry.contentVersion.contentType === 'weapon'
      ? [...(entry.profile?.profileMode === 'mechanical' && entry.profile.contentKind === 'weapon'
        ? entry.profile.weaponTags ?? []
        : []), ...(entry.profile?.tags ?? [])]
      : []),
    equippedEquipmentTags: equipped.flatMap((entry) => [...(entry.profile?.tags ?? [])]),
    rulesetCode: sheet.ruleset.code,
  };
  return classifyActorReadiness({
    actor: { status: actor.status },
    resources: {
      hp: { current: sheet.resources.hp.current, maximum: sheet.resources.hp.max },
      mana: { current: sheet.resources.mana.current, maximum: sheet.resources.mana.max },
      sp: { current: sheet.resources.sp.current, maximum: sheet.resources.sp.max },
    },
    requirementContext,
    costModifiers: costModifierSet([...inventoryInputs.modifiers, ...effectInputs.modifiers]),
    linked: actor.content.map((link) => ({
      state: link.state,
      definition: link.contentDefinition,
      version: link.contentVersion,
    })),
    inventory: inventoryInputs.inventory.entries.map((entry) => ({
      entryRef: entry.entryRef,
      entryKind: entry.entryKind,
      quantity: entry.entryKind === 'stack' ? entry.quantity : 1,
      state: entry.entryKind === 'instance' ? entry.state : null,
      definition: { code: entry.contentVersion.code, contentType: entry.contentVersion.contentType },
      version: { profile: entry.profile, inventorySpec: entry.inventorySpec },
    })),
  });
}
