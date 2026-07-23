import {
  ActorContentState,
  ContentStatus,
  ContentType,
  type Prisma,
} from '../../generated/prisma/client.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { observeOperationStage } from '../../shared/observability/operation-observability.js';
import { createDeterministicEffectRef } from '../effects/effect-resolution.primitives.js';
import type {
  CoreV1CostModifierSet,
  CoreV1ContentKind,
  CoreV1EncounterActionDefinition,
  CoreV1EncounterActionIntent,
  CoreV1EncounterContentReference,
  CoreV1EncounterTargetingContext,
  CoreV1MechanicalContentProfile,
  CoreV1Targeting,
  CoreV1RuntimeDurationBinding,
  CoreV1StatusDefinitionBinding,
} from '../rules/core-v1/index.js';
import {
  collectActiveEffectModifiers,
  resolveCoreV1Cost,
  resolveCoreV1EncounterTargets,
  validateCoreV1ContentProfile,
} from '../rules/core-v1/index.js';
import { EncounterError } from './encounter.errors.js';
import type { LoadedEncounter } from './encounter-state-loader.js';
import type { EncounterTransaction } from './encounter.repository.js';
import type { EncounterProjectedActionDto, EncounterProjectedCostDto } from './encounter.types.js';

const executableInclude = {
  contentDefinition: true,
  sourceEffectBindings: { include: { targetContentVersion: { include: { contentDefinition: true } } } },
} satisfies Prisma.ContentVersionInclude;

type ExecutableVersion = Prisma.ContentVersionGetPayload<{ include: typeof executableInclude }>;

export const ENCOUNTER_MAX_PROJECTED_ACTIONS = 256;
export const ENCOUNTER_MAX_DETAILED_ACTIONS_PER_CATEGORY = {
  attacks: 32,
  abilities: 48,
  items: 24,
} as const;

const contentTypeToDatabase = {
  weapon: ContentType.WEAPON,
  armor: ContentType.ARMOR,
  shield: ContentType.SHIELD,
  clothing: ContentType.CLOTHING,
  spell: ContentType.SPELL,
  skill: ContentType.SKILL,
  talent: ContentType.TALENT,
  item: ContentType.ITEM,
  consumable: ContentType.CONSUMABLE,
  status_effect: ContentType.STATUS_EFFECT,
} as const;

function profile(value: unknown): CoreV1MechanicalContentProfile {
  const validated = validateCoreV1ContentProfile(value);
  if (!validated.ok || validated.value.profileMode !== 'mechanical'
    || validated.value.activation.type !== 'active') {
    throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  }
  return validated.value;
}

function contentReference(version: ExecutableVersion): CoreV1EncounterContentReference {
  return {
    scope: version.contentDefinition.campaignId === null ? 'world' as const : 'campaign' as const,
    contentType: normalizeEnum(version.contentDefinition.contentType) as CoreV1ContentKind,
    code: version.contentDefinition.code,
    versionNumber: version.versionNumber,
  };
}

function resolvedEffects(mechanical: CoreV1MechanicalContentProfile) {
  const root = (mechanical.damageComponents?.length ?? 0) > 0 && mechanical.targeting !== undefined
    ? [{ type: 'damage' as const, damageComponents: mechanical.damageComponents ?? [], targeting: mechanical.targeting }]
    : [];
  return [...root, ...(mechanical.effects ?? [])];
}

function primaryTargeting(mechanical: CoreV1MechanicalContentProfile): CoreV1Targeting | undefined {
  if (mechanical.targeting !== undefined) return mechanical.targeting;
  return resolvedEffects(mechanical).find((effect): effect is typeof effect & { targeting: CoreV1Targeting } => (
    'targeting' in effect
  ))?.targeting;
}

function projectedCost(
  cost: CoreV1MechanicalContentProfile['cost'],
  adjusted: ReadonlyMap<string, number>,
  hpMaximum: number,
): EncounterProjectedCostDto {
  if (cost.type === 'none') return { type: 'none' };
  if (cost.type === 'mana' || cost.type === 'sp') {
    return { type: cost.type, amount: adjusted.get(cost.type) ?? cost.amount };
  }
  if (cost.type === 'hybrid') {
    return {
      type: 'hybrid',
      mana: adjusted.get('mana') ?? cost.mana,
      sp: adjusted.get('sp') ?? cost.sp,
    };
  }
  if (cost.type === 'hp') {
    const amount = adjusted.get('hp');
    return {
      type: 'hp',
      percent: amount === undefined || hpMaximum < 1
        ? Math.ceil(cost.percentBps / 100)
        : Math.ceil(amount * 100 / hpMaximum),
    };
  }
  return { type: 'unsupported' };
}

type EncounterCatalogSource = Pick<LoadedEncounter, 'state' | 'authorities'>;

export interface EncounterActionCatalogSource {
  readonly contentActions: readonly {
    readonly actorRef: string;
    readonly version: ExecutableVersion;
  }[];
  readonly inventoryActions: readonly {
    readonly actorRef: string;
    readonly entryRef: string;
    readonly equipped: boolean;
    readonly version: ExecutableVersion;
  }[];
}

function currentCostModifiers(
  loaded: EncounterCatalogSource,
  actorRef: string,
): CoreV1CostModifierSet {
  const authority = loaded.authorities.get(actorRef);
  const participant = loaded.state.participants.find((entry) => entry.actorRef === actorRef);
  if (authority === undefined || participant === undefined) return {};
  const active = collectActiveEffectModifiers({
    actorRef,
    primaryAttributes: participant.primaryAttributes,
    resources: participant.resources,
    secondaryAttributes: participant.secondaryAttributes,
    activeEffects: participant.activeEffects,
    stateVersion: participant.effectsStateVersion,
  }, loaded.state.currentTick);
  if (!active.ok) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  const modifiers = [...(authority.inventory.modifiers ?? []), ...active.value];
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

function resolvedProjectedCost(
  mechanical: CoreV1MechanicalContentProfile,
  source: LoadedEncounter['state']['participants'][number],
  modifiers: CoreV1CostModifierSet,
): { readonly cost: EncounterProjectedCostDto; readonly blockers: readonly string[] } {
  const resolved = resolveCoreV1Cost({
    tier: mechanical.tier,
    cost: mechanical.cost,
    resources: source.resources,
    modifiers,
  });
  if (!resolved.ok) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  const adjusted = new Map(resolved.value.amounts.map((amount) => [amount.resource, amount.adjusted]));
  const blockers = resolved.value.affordable ? []
    : resolved.value.amounts.flatMap((amount) => amount.resource === 'hp'
      ? ['unsafe_hp_cost'] : [`insufficient_${amount.resource}`]);
  if (mechanical.cost.type === 'custom') blockers.push('unsupported_custom_resource');
  return {
    cost: projectedCost(mechanical.cost, adjusted, source.resources.hp.maximum),
    blockers,
  };
}

function projectedTargets(
  loaded: EncounterCatalogSource,
  actorRef: string,
  mechanical: CoreV1MechanicalContentProfile,
): string[] {
  const targeting = primaryTargeting(mechanical);
  if (targeting === undefined) return [];
  const effects = resolvedEffects(mechanical);
  const damaging = effects.some((effect) => effect.type === 'damage' || effect.type === 'add_damage');
  const allowedRelations = targeting.type === 'self' ? ['self'] as const
    : damaging ? ['hostile'] as const : ['self', 'ally'] as const;
  const context = createAuthoritativeTargetingContext(loaded, {
    intentRef: 'capsule-projection',
    sourceActorRef: actorRef,
    slotRef: 'primary',
    actionSource: 'content',
    targetSelector: 'explicit',
    requestedTargetRefs: [],
  }, mechanical);
  return context.candidates.flatMap((candidate) => {
    const result = resolveCoreV1EncounterTargets({
      encounter: loaded.state,
      sourceActorRef: actorRef,
      targeting,
      selector: targeting.type === 'self' ? 'self' : 'explicit',
      requestedTargetRefs: [candidate.actorRef],
      allowedRelations,
      context,
    });
    return result.ok && result.value.some((target) => target.targetRef === candidate.actorRef)
      ? [candidate.actorRef] : [];
  }).filter((ref, index, refs) => refs.indexOf(ref) === index).sort();
}

function projectedAction(
  loaded: EncounterCatalogSource,
  actorRef: string,
  mechanical: CoreV1MechanicalContentProfile,
  identity: Pick<EncounterProjectedActionDto, 'source' | 'inventoryEntryRef' | 'contentRef' | 'quantity'>,
  modifiers: CoreV1CostModifierSet,
): EncounterProjectedActionDto {
  const source = loaded.state.participants.find((participant) => participant.actorRef === actorRef);
  if (source === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const resolvedCost = resolvedProjectedCost(mechanical, source, modifiers);
  let spatialContextUnavailable = false;
  let validTargetRefs: string[] = [];
  try {
    validTargetRefs = projectedTargets(loaded, actorRef, mechanical);
  } catch (error) {
    if (!(error instanceof EncounterError) || error.code !== 'ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE') throw error;
    spatialContextUnavailable = true;
  }
  const activationBlockers = mechanical.activation.type !== 'active' ? ['activation_not_active'] : [];
  const targetingBlockers = spatialContextUnavailable ? ['spatial_context_unavailable']
    : primaryTargeting(mechanical) === undefined ? ['targeting_unavailable']
    : validTargetRefs.length === 0 ? ['no_valid_target'] : [];
  const blockers = [
    ...activationBlockers,
    ...resolvedCost.blockers,
    ...targetingBlockers,
    ...(identity.quantity !== undefined && identity.quantity < 1 ? ['quantity_unavailable'] : []),
  ];
  const compatibleModes = mechanical.handedness === 'versatile'
    ? ['one_handed', 'two_handed'] as const
    : mechanical.handedness === 'two_handed' ? ['two_handed'] as const
      : mechanical.handedness === 'one_handed' ? ['one_handed'] as const : [];
  return {
    ...identity,
    code: mechanical.code,
    name: mechanical.name,
    actionType: mechanical.contentKind === 'weapon' ? 'attack'
      : mechanical.contentKind === 'consumable' ? 'use_item' : 'cast',
    ...(mechanical.rarity === 'common' ? {} : { rarity: mechanical.rarity }),
    range: primaryTargeting(mechanical)?.rangeBand ?? 'unavailable',
    cost: resolvedCost.cost,
    ...(mechanical.consumable === true || mechanical.contentKind === 'consumable'
      ? { consumable: true } : {}),
    ...(compatibleModes.length === 0 ? {} : { compatibleModes }),
    validTargetRefs,
    canUse: blockers.length === 0,
    ...(blockers.length === 0 ? {} : { blockers }),
  };
}

export interface EncounterActionCatalog {
  readonly attacks: readonly EncounterProjectedActionDto[];
  readonly abilities: readonly EncounterProjectedActionDto[];
  readonly items: readonly EncounterProjectedActionDto[];
}

export async function loadEncounterActionCatalogSource(
  transaction: EncounterTransaction,
  loaded: EncounterCatalogSource,
): Promise<EncounterActionCatalogSource> {
  const actorIds = [...loaded.authorities.values()].map((authority) => authority.actor.id);
  if (actorIds.length === 0) return { contentActions: [], inventoryActions: [] };
  const links = await observeOperationStage('encounter_content', () => transaction.actorContent.findMany({
    where: {
      actorId: { in: actorIds },
      state: { in: [ActorContentState.KNOWN, ActorContentState.MASTERED] },
    },
    include: {
      actor: { select: { code: true } },
      contentVersion: { include: executableInclude },
    },
    orderBy: [{ actorId: 'asc' }, { contentDefinition: { code: 'asc' } }],
  }));
  const inventoryEntries = await observeOperationStage('encounter_inventory', () => transaction.inventoryEntry.findMany({
    where: { actorId: { in: actorIds } },
    include: { actor: { select: { code: true } }, contentVersion: { include: executableInclude }, equipmentSlots: true },
    orderBy: [{ actorId: 'asc' }, { entryRef: 'asc' }],
  }));
  return {
    contentActions: links.flatMap((link) => {
      const contentType = link.contentVersion.contentDefinition.contentType;
      return (contentType === ContentType.SPELL || contentType === ContentType.SKILL)
        && link.contentVersion.contentDefinition.status === ContentStatus.ACTIVE
        ? [{ actorRef: link.actor.code, version: link.contentVersion }]
        : [];
    }),
    inventoryActions: inventoryEntries.flatMap((entry) => {
      const contentType = entry.contentVersion.contentDefinition.contentType;
      return (contentType === ContentType.WEAPON || contentType === ContentType.CONSUMABLE)
        && entry.contentVersion.contentDefinition.status === ContentStatus.ACTIVE
        ? [{
          actorRef: entry.actor.code,
          entryRef: entry.entryRef,
          equipped: entry.equipmentSlots.length > 0,
          version: entry.contentVersion,
        }]
        : [];
    }),
  };
}

export function projectEncounterActionCatalog(
  source: EncounterActionCatalogSource,
  loaded: EncounterCatalogSource,
  options: {
    readonly actorRefs?: ReadonlySet<string>;
    readonly consumedEntryCounts?: ReadonlyMap<string, number>;
  } = {},
): ReadonlyMap<string, EncounterActionCatalog> {
  const catalog = new Map<string, {
    attacks: EncounterProjectedActionDto[];
    abilities: EncounterProjectedActionDto[];
    items: EncounterProjectedActionDto[];
  }>();
  const modifiersByActor = new Map(loaded.state.participants.map((participant) => [
    participant.actorRef,
    currentCostModifiers(loaded, participant.actorRef),
  ]));
  for (const actorRef of loaded.state.participants.map((participant) => participant.actorRef)) {
    if (options.actorRefs !== undefined && !options.actorRefs.has(actorRef)) continue;
    catalog.set(actorRef, { attacks: [], abilities: [], items: [] });
  }
  for (const inventoryAction of source.inventoryActions) {
    const actorRef = inventoryAction.actorRef;
    const entryCatalog = catalog.get(actorRef);
    if (entryCatalog === undefined) continue;
    const authority = loaded.authorities.get(actorRef);
    const entry = authority?.inventory.inventory.entries.find((candidate) => candidate.entryRef === inventoryAction.entryRef);
    if (entry?.profile?.profileMode !== 'mechanical') continue;
    if (entry.profile.contentKind === 'weapon' && inventoryAction.equipped) {
      entryCatalog.attacks.push(projectedAction(loaded, actorRef, entry.profile, {
          source: 'inventory',
          inventoryEntryRef: entry.entryRef,
      }, modifiersByActor.get(actorRef) ?? {}));
    }
    if (entry.profile.contentKind === 'consumable') {
      const quantity = (entry.entryKind === 'stack' ? entry.quantity : 1)
        - (options.consumedEntryCounts?.get(`${actorRef}:${entry.entryRef}`) ?? 0);
      entryCatalog.items.push(projectedAction(loaded, actorRef, entry.profile, {
          source: 'inventory',
          inventoryEntryRef: entry.entryRef,
          quantity: Math.max(0, quantity),
      }, modifiersByActor.get(actorRef) ?? {}));
    }
  }
  for (const action of source.contentActions) {
    const validated = validateCoreV1ContentProfile(action.version.profile);
    if (!validated.ok || validated.value.profileMode !== 'mechanical') continue;
    if (!['spell', 'skill'].includes(validated.value.contentKind)) continue;
    const entryCatalog = catalog.get(action.actorRef);
    if (entryCatalog === undefined) continue;
    entryCatalog.abilities.push(projectedAction(loaded, action.actorRef, validated.value, {
      source: 'content',
      contentRef: contentReference(action.version),
    }, modifiersByActor.get(action.actorRef) ?? {}));
  }
  for (const entry of catalog.values()) {
    entry.attacks.sort((left, right) => left.code.localeCompare(right.code));
    entry.abilities.sort((left, right) => left.code.localeCompare(right.code));
    entry.items.sort((left, right) => left.code.localeCompare(right.code));
  }
  return catalog;
}

export async function loadEncounterActionCatalog(
  transaction: EncounterTransaction,
  loaded: EncounterCatalogSource,
): Promise<ReadonlyMap<string, EncounterActionCatalog>> {
  const source = await loadEncounterActionCatalogSource(transaction, loaded);
  return projectEncounterActionCatalog(source, loaded);
}

async function loadExecutable(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  intent: CoreV1EncounterActionIntent,
): Promise<{ readonly version: ExecutableVersion; readonly consumedEntryRef?: string }> {
  const source = loaded.authorities.get(intent.sourceActorRef);
  if (source === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  if (intent.actionSource === 'consumable' || intent.actionSource === 'basic_weapon_attack') {
    if (intent.weaponEntryRef === undefined) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    const entry = await transaction.inventoryEntry.findUnique({
      where: { actorId_entryRef: { actorId: source.actor.id, entryRef: intent.weaponEntryRef } },
      include: { contentVersion: { include: executableInclude }, equipmentSlots: true },
    });
    if (entry === null || entry.contentVersion.rulesetVersionId !== loaded.record.rulesetVersionId) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    if (intent.actionSource === 'consumable' && entry.contentVersion.contentDefinition.contentType !== ContentType.CONSUMABLE) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    if (intent.actionSource === 'basic_weapon_attack'
      && (entry.contentVersion.contentDefinition.contentType !== ContentType.WEAPON || entry.equipmentSlots.length === 0)) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    return { version: entry.contentVersion, ...(intent.actionSource === 'consumable' ? { consumedEntryRef: entry.entryRef } : {}) };
  }
  if (intent.actionSource !== 'content' || intent.contentRef === undefined) {
    throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  }
  const databaseContentType = (contentTypeToDatabase as Partial<Record<CoreV1ContentKind, ContentType>>)[intent.contentRef.contentType];
  if (databaseContentType === undefined) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  const definition = await transaction.contentDefinition.findFirst({
    where: {
      worldId: loaded.record.campaign.worldId,
      campaignId: intent.contentRef.scope === 'campaign' ? loaded.record.campaignId : null,
      contentType: databaseContentType,
      code: intent.contentRef.code,
      status: ContentStatus.ACTIVE,
    },
    include: { versions: { where: { versionNumber: intent.contentRef.versionNumber }, include: executableInclude, take: 1 } },
  });
  const version = definition?.versions[0];
  if (definition === null || definition === undefined || version === undefined
    || version.rulesetVersionId !== loaded.record.rulesetVersionId) {
    throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  }
  const known = await transaction.actorContent.findFirst({
    where: {
      actorId: source.actor.id,
      contentDefinitionId: definition.id,
      contentVersionId: version.id,
      state: { in: [ActorContentState.KNOWN, ActorContentState.MASTERED] },
    },
  });
  const equipped = known === null ? await transaction.inventoryEntry.findFirst({
    where: { actorId: source.actor.id, contentVersionId: version.id, equipmentSlots: { some: {} } },
  }) : null;
  if (known === null && equipped === null) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  return { version };
}

function statusDefinitions(
  version: ExecutableVersion,
  effects: ReturnType<typeof resolvedEffects>,
  effectRefs: readonly string[],
): CoreV1StatusDefinitionBinding[] {
  return version.sourceEffectBindings.map((binding) => {
    const target = binding.targetContentVersion;
    const validated = validateCoreV1ContentProfile(target.profile);
    const targetProfile = validated.ok && validated.value.profileMode === 'mechanical'
      ? validated.value : undefined;
    const effect = effects[binding.effectIndex];
    if (effect === undefined || !['apply_status', 'remove_status'].includes(effect.type)) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    return {
      effectIndex: binding.effectIndex,
      effectRef: effectRefs[binding.effectIndex] as string,
      contentVersion: {
        scope: target.contentDefinition.campaignId === null ? 'world' : 'campaign',
        contentType: normalizeEnum(target.contentDefinition.contentType) as CoreV1ContentKind,
        code: target.contentDefinition.code,
        versionNumber: target.versionNumber,
      },
      ...(targetProfile === undefined ? {} : { profile: targetProfile }),
    };
  });
}

function actionKind(mechanical: CoreV1MechanicalContentProfile, source: CoreV1EncounterActionIntent['actionSource']) {
  if (source === 'consumable') return 'item' as const;
  const components = [
    ...(mechanical.damageComponents ?? []),
    ...(mechanical.effects ?? []).flatMap((effect) => effect.type === 'damage' || effect.type === 'add_damage'
      ? effect.damageComponents : []),
  ];
  const physical = components.some((component) => component.channel === 'physical');
  const magical = components.some((component) => component.channel === 'magical');
  return physical && magical ? 'hybrid' as const : magical ? 'magic' as const : 'physical' as const;
}

function costModifiers(loaded: LoadedEncounter, actorRef: string): CoreV1CostModifierSet {
  return currentCostModifiers(loaded, actorRef);
}

export function createAuthoritativeTargetingContext(
  loaded: Pick<LoadedEncounter, 'state'>,
  intent: CoreV1EncounterActionIntent,
  mechanical: CoreV1MechanicalContentProfile,
): CoreV1EncounterTargetingContext {
  const targeting = mechanical.targeting
    ?? mechanical.effects?.find((effect) => 'targeting' in effect)?.targeting;
  if (targeting !== undefined && ['area', 'chain', 'cleave'].includes(targeting.type)) {
    throw new EncounterError('ENCOUNTER_SPATIAL_CONTEXT_UNAVAILABLE');
  }
  const relation = (actorRef: string) => {
    if (actorRef === intent.sourceActorRef) return 'self' as const;
    const pair = loaded.state.relations.find((entry) => (
      entry.leftActorRef === intent.sourceActorRef && entry.rightActorRef === actorRef
    ) || (entry.rightActorRef === intent.sourceActorRef && entry.leftActorRef === actorRef));
    return pair?.relation ?? 'neutral';
  };
  return {
    candidates: loaded.state.participants.map((participant, stableOrder) => ({
      actorRef: participant.actorRef,
      relation: relation(participant.actorRef),
      rangeBand: participant.zone,
      targetable: participant.combatState !== 'removed',
      active: participant.combatState !== 'removed' && participant.resources.hp.current > 0,
      hpCurrent: participant.resources.hp.current,
      hpMaximum: participant.resources.hp.maximum,
      stableOrder,
    })),
  };
}

function authoritativeEncounterAction(
  loaded: LoadedEncounter,
  intent: CoreV1EncounterActionIntent,
  executable: { readonly version: ExecutableVersion; readonly consumedEntryRef?: string },
): Promise<{
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
}> {
  const mechanical = profile(executable.version.profile);
  const effects = resolvedEffects(mechanical);
  const reference = contentReference(executable.version);
  const effectTargetRef = intent.requestedTargetRefs[0] ?? intent.sourceActorRef;
  const effectRefs = effects.map((_, index) => createDeterministicEffectRef(effectTargetRef, reference, index));
  const durations: CoreV1RuntimeDurationBinding[] = effects.flatMap((effect, effectIndex) => (
    effect.type === 'grant_reaction' && mechanical.duration !== undefined
      ? [{ effectIndex, duration: mechanical.duration }] : []
  ));
  const kind = actionKind(mechanical, intent.actionSource);
  const source = loaded.state.participants.find((participant) => participant.actorRef === intent.sourceActorRef);
  if (source === undefined) throw new EncounterError('ENCOUNTER_PARTICIPANT_INVALID');
  const hasDamage = effects.some((effect) => effect.type === 'damage' || effect.type === 'add_damage');
  const modifiers = costModifiers(loaded, intent.sourceActorRef);
  const weaponEntry = intent.actionSource === 'basic_weapon_attack'
    ? source.equipmentContext.inventory.entries.find((entry) => entry.entryRef === intent.weaponEntryRef)
    : undefined;
  if (intent.actionSource === 'basic_weapon_attack' && weaponEntry === undefined) {
    throw new EncounterError('ENCOUNTER_INVENTORY_DRIFT');
  }
  const definition: CoreV1EncounterActionDefinition = {
    actionSource: intent.actionSource,
    actionKind: kind,
    profile: mechanical,
    contentRef: reference,
    actionTags: intent.actionSource === 'consumable'
      ? ['item']
      : hasDamage
        ? ['attack']
        : [mechanical.contentKind],
    fullPrimaryAction: intent.actionSource !== 'consumable',
    allowedRelations: mechanical.targeting?.type === 'self' ? ['self'] : hasDamage ? ['hostile'] : ['self', 'ally'],
    effectRefs,
    statusDefinitions: statusDefinitions(executable.version, effects, effectRefs),
    runtimeDurations: durations,
    costModifiers: modifiers,
    defenses: Object.fromEntries([...loaded.authorities].map(([actorRef, authority]) => {
      const currentParticipant = loaded.state.participants.find((participant) => participant.actorRef === actorRef);
      const secondary = currentParticipant?.secondaryAttributes ?? authority.sheet.secondaryAttributes;
      return [actorRef, {
        blockValue: 0,
        completeBlock: false,
        temporaryImmunities: {
          physical: authority.inventory.defense.physicalImmune,
          magical: authority.inventory.defense.magicalImmune,
          elements: authority.inventory.defense.immuneElements,
        },
        temporaryResistances: {
          physicalResistanceBps: secondary.physicalResistanceBps,
          magicalResistanceBps: secondary.magicalResistanceBps,
          elementalResistanceBps: authority.sheet.secondaryAttributes.elementalResistanceBps,
        },
      }];
    })),
    ...(kind === 'physical' || kind === 'hybrid' ? { physicalSpeed: {
      attributes: source.primaryAttributes,
      weaponFamilyRank: 0,
      weaponWeightUnits: weaponEntry?.inventorySpec.unitWeight ?? 0,
      twoHanded: intent.versatileMode === 'two_handed',
      carriedWeightUnits: loaded.authorities.get(source.actorRef)?.inventory.totalCarriedWeight ?? 0,
      carryingCapacityUnits: source.secondaryAttributes.carryingCapacity,
    } } : {}),
    ...(kind === 'magic' || kind === 'hybrid' ? { magicalSpeed: {
      attributes: source.primaryAttributes,
      magicSchoolRank: 0,
      armorCastingPenaltyBps: 0,
    } } : {}),
    interruptible: true,
    blockable: hasDamage,
    dodgeable: hasDamage,
    canRetargetBeforeEffect: false,
  };
  return Promise.resolve({ definition, targetingContext: createAuthoritativeTargetingContext(loaded, intent, mechanical) });
}

function sameContentReference(
  left: CoreV1EncounterContentReference,
  right: CoreV1EncounterContentReference,
): boolean {
  return left.scope === right.scope && left.contentType === right.contentType
    && left.code === right.code && left.versionNumber === right.versionNumber;
}

export function loadCachedAuthoritativeEncounterAction(
  source: EncounterActionCatalogSource,
  loaded: LoadedEncounter,
  intent: CoreV1EncounterActionIntent,
): Promise<{
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
}> {
  let executable: { readonly version: ExecutableVersion; readonly consumedEntryRef?: string } | undefined;
  if (intent.actionSource === 'consumable' || intent.actionSource === 'basic_weapon_attack') {
    if (intent.weaponEntryRef === undefined) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    const entry = source.inventoryActions.find((candidate) => (
      candidate.actorRef === intent.sourceActorRef && candidate.entryRef === intent.weaponEntryRef
    ));
    if (entry === undefined || entry.version.rulesetVersionId !== loaded.record.rulesetVersionId
      || (intent.actionSource === 'consumable'
        && entry.version.contentDefinition.contentType !== ContentType.CONSUMABLE)
      || (intent.actionSource === 'basic_weapon_attack'
        && (entry.version.contentDefinition.contentType !== ContentType.WEAPON || !entry.equipped))) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    executable = {
      version: entry.version,
      ...(intent.actionSource === 'consumable' ? { consumedEntryRef: entry.entryRef } : {}),
    };
  } else if (intent.actionSource === 'content' && intent.contentRef !== undefined) {
    const action = source.contentActions.find((candidate) => (
      candidate.actorRef === intent.sourceActorRef
      && sameContentReference(contentReference(candidate.version), intent.contentRef as CoreV1EncounterContentReference)
    ));
    if (action === undefined || action.version.rulesetVersionId !== loaded.record.rulesetVersionId) {
      throw new EncounterError('ENCOUNTER_CORE_REJECTED');
    }
    executable = { version: action.version };
  }
  if (executable === undefined) throw new EncounterError('ENCOUNTER_CORE_REJECTED');
  return authoritativeEncounterAction(loaded, intent, executable);
}

export async function loadAuthoritativeEncounterAction(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  intent: CoreV1EncounterActionIntent,
): Promise<{
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
}> {
  return authoritativeEncounterAction(loaded, intent, await loadExecutable(transaction, loaded, intent));
}
