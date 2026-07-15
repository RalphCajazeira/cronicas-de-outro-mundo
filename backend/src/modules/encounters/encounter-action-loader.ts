import {
  ActorContentState,
  ContentStatus,
  ContentType,
  type Prisma,
} from '../../generated/prisma/client.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { createDeterministicEffectRef } from '../effects/effect-resolution.primitives.js';
import type {
  CoreV1CostModifierSet,
  CoreV1ContentKind,
  CoreV1EncounterActionDefinition,
  CoreV1EncounterActionIntent,
  CoreV1EncounterContentReference,
  CoreV1EncounterTargetingContext,
  CoreV1MechanicalContentProfile,
  CoreV1RuntimeDurationBinding,
  CoreV1StatusDefinitionBinding,
} from '../rules/core-v1/index.js';
import { validateCoreV1ContentProfile } from '../rules/core-v1/index.js';
import { EncounterError } from './encounter.errors.js';
import type { LoadedEncounter } from './encounter-state-loader.js';
import type { EncounterTransaction } from './encounter.repository.js';

const executableInclude = {
  contentDefinition: true,
  sourceEffectBindings: { include: { targetContentVersion: { include: { contentDefinition: true } } } },
} satisfies Prisma.ContentVersionInclude;

type ExecutableVersion = Prisma.ContentVersionGetPayload<{ include: typeof executableInclude }>;

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
  const authority = loaded.authorities.get(actorRef);
  if (authority === undefined) return {};
  const modifiers = [...authority.inventory.modifiers, ...authority.effects.modifiers];
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

export function createAuthoritativeTargetingContext(
  loaded: LoadedEncounter,
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

export async function loadAuthoritativeEncounterAction(
  transaction: EncounterTransaction,
  loaded: LoadedEncounter,
  intent: CoreV1EncounterActionIntent,
): Promise<{
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
}> {
  const executable = await loadExecutable(transaction, loaded, intent);
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
    defenses: Object.fromEntries([...loaded.authorities].map(([actorRef, authority]) => [actorRef, {
      blockValue: 0,
      completeBlock: false,
      temporaryImmunities: {
        physical: authority.inventory.defense.physicalImmune,
        magical: authority.inventory.defense.magicalImmune,
        elements: authority.inventory.defense.immuneElements,
      },
      temporaryResistances: {
        physicalResistanceBps: authority.sheet.secondaryAttributes.physicalResistanceBps,
        magicalResistanceBps: authority.sheet.secondaryAttributes.magicalResistanceBps,
        elementalResistanceBps: authority.sheet.secondaryAttributes.elementalResistanceBps,
      },
    }])),
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
  return { definition, targetingContext: createAuthoritativeTargetingContext(loaded, intent, mechanical) };
}
