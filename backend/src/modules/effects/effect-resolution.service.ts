import {
  ActorContentState,
  ActorResourceType,
  ContentStatus,
  ContentType,
  EffectResolutionOperation,
  EffectRollKind,
  Prisma,
} from '../../generated/prisma/client.js';
import { resolveScope } from '../../shared/database/game-scope.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { loadActorMechanicalSheet, recomputeActorDerivedSnapshot } from '../actors/actor-mechanics.service.js';
import type { ResolveActorEffectInput } from '../gpt/gpt.schemas.js';
import { loadActorInventoryMechanicalInputs } from '../inventory/inventory-mechanical-inputs.js';
import {
  advanceActorActionDurations,
  resolveCoreV1ConsumableUse,
  resolveCoreV1EffectSequence,
  validateCoreV1ContentProfile,
  type CoreV1ActiveEffectInstance,
  type CoreV1ActorEffectContext,
  type CoreV1ContentVersionReference,
  type CoreV1CostModifierSet,
  type CoreV1EffectContentVersionReference,
  type CoreV1EffectSequenceResult,
  type CoreV1InjectedRolls,
  type CoreV1MechanicalContentProfile,
  type CoreV1RuntimeDurationBinding,
  type CoreV1StatusDefinitionBinding,
} from '../rules/core-v1/index.js';
import { ensureCoreV1EffectRulesVersion } from '../rules/effect-rules.registry.js';
import { loadActorActiveEffectMechanicalInputs } from './active-effect-mechanical-inputs.js';
import {
  expireDueActorEffects,
  loadActorEffectsDto,
  persistActorActiveEffects,
  type ActiveEffectPersistenceOrigin,
} from './effect-state.service.js';
import { cryptographicRollProvider, type RollProvider } from './roll-provider.js';
import { calculateEffectResolutionResultHash, createDeterministicEffectRef } from './effect-resolution.primitives.js';

type Transaction = Prisma.TransactionClient;
type WriteInput = Exclude<ResolveActorEffectInput, { operation: 'get' }>;

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

const executableVersionInclude = {
  contentDefinition: true,
  sourceEffectBindings: { include: { targetContentVersion: { include: { contentDefinition: true } } } },
} satisfies Prisma.ContentVersionInclude;

type ExecutableVersion = Prisma.ContentVersionGetPayload<{ include: typeof executableVersionInclude }>;
type ExecutableDefinition = Prisma.ContentDefinitionGetPayload<Record<string, never>>;
type Executable = { definition: ExecutableDefinition; version: ExecutableVersion; inventoryEntry: { id: string } | null };

function operationError(code: string, message: string): AppError {
  return new AppError(409, code, message);
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function contentReference(version: {
  versionNumber: number;
  contentDefinition: { campaignId: string | null; contentType: ContentType; code: string };
}): CoreV1EffectContentVersionReference {
  return {
    scope: version.contentDefinition.campaignId === null ? 'world' : 'campaign',
    contentType: version.contentDefinition.contentType.toLowerCase() as CoreV1EffectContentVersionReference['contentType'],
    code: version.contentDefinition.code,
    versionNumber: version.versionNumber,
  };
}

async function lockActor(client: Transaction, actorId: string) {
  await client.$queryRaw(Prisma.sql`SELECT 1 FROM "Actor" WHERE id = ${actorId}::uuid FOR UPDATE`);
}

async function resolveActors(client: Transaction, campaignId: string, sourceRef: string, targetRef: string) {
  const source = await client.actor.findUnique({ where: { campaignId_code: { campaignId, code: sourceRef } } });
  if (source === null) throw new NotFoundError('Source actor');
  const target = sourceRef === targetRef
    ? source
    : await client.actor.findUnique({ where: { campaignId_code: { campaignId, code: targetRef } } });
  if (target === null) throw new NotFoundError('Target actor');
  for (const actorId of [...new Set([source.id, target.id])].sort()) await lockActor(client, actorId);
  const locked = await client.actor.findMany({ where: { id: { in: [source.id, target.id] } } });
  const byId = new Map(locked.map((actor) => [actor.id, actor]));
  return { source: byId.get(source.id) ?? source, target: byId.get(target.id) ?? target };
}

type ExpectedState = NonNullable<ResolveActorEffectInput['expectedSourceState']>;

async function assertExpectedState(client: Transaction, actor: { id: string; code: string; mechanicsStateVersion: number; inventoryStateVersion: number; effectsStateVersion: number }, expected: ExpectedState) {
  const resources = await client.actorResource.findMany({ where: { actorId: actor.id }, select: { type: true, stateVersion: true } });
  const versions = Object.fromEntries(resources.map((resource) => [resource.type.toLowerCase(), resource.stateVersion]));
  if (actor.mechanicsStateVersion !== expected.mechanicsStateVersion
    || actor.inventoryStateVersion !== expected.inventoryStateVersion
    || actor.effectsStateVersion !== expected.effectsStateVersion
    || versions.hp !== expected.resourceStateVersions.hp
    || versions.mana !== expected.resourceStateVersions.mana
    || versions.sp !== expected.resourceStateVersions.sp) {
    throw new ConflictError(`Actor ${actor.code} state version conflict`);
  }
}

async function actorContext(client: Transaction, actor: { id: string; code: string; effectsStateVersion: number }): Promise<CoreV1ActorEffectContext> {
  const [sheet, effects] = await Promise.all([
    loadActorMechanicalSheet(client, actor.id),
    client.campaign.findFirst({ where: { actors: { some: { id: actor.id } } }, select: { engineTick: true } })
      .then(async (campaign) => loadActorActiveEffectMechanicalInputs(client, actor.id, campaign?.engineTick ?? 0n)),
  ]);
  return {
    actorRef: actor.code,
    primaryAttributes: sheet.primaryAttributes,
    resources: {
      hp: { current: sheet.resources.hp.current, maximum: sheet.resources.hp.max },
      mana: { current: sheet.resources.mana.current, maximum: sheet.resources.mana.max },
      sp: { current: sheet.resources.sp.current, maximum: sheet.resources.sp.max },
    },
    secondaryAttributes: {
      ...sheet.secondaryAttributes,
      elementalResistanceBps: sheet.secondaryAttributes.elementalResistanceBps.default ?? 0,
    },
    activeEffects: effects.activeEffects,
    stateVersion: actor.effectsStateVersion,
  };
}

async function executableContent(client: Transaction, scope: Awaited<ReturnType<typeof resolveScope>>, actorId: string, input: WriteInput): Promise<Executable> {
  if (input.operation === 'use_consumable') {
    const entry = await client.inventoryEntry.findUnique({
      where: { actorId_entryRef: { actorId, entryRef: input.inventoryEntryRef as string } },
      include: { contentVersion: { include: executableVersionInclude }, equipmentSlots: true },
    });
    if (entry === null) throw new NotFoundError('Consumable inventory entry');
    if (entry.contentVersion.contentDefinition.contentType !== ContentType.CONSUMABLE) throw operationError('INVALID_CONTENT_EXECUTION', 'Inventory entry is not a consumable');
    return { definition: entry.contentVersion.contentDefinition, version: entry.contentVersion, inventoryEntry: entry };
  }
  const reference = input.contentRef;
  if (reference === undefined) throw operationError('INVALID_CONTENT_EXECUTION', 'Exact content reference is required');
  const definition = await client.contentDefinition.findFirst({
    where: {
      worldId: scope.world.id,
      OR: [{ campaignId: scope.campaign.id }, { campaignId: null }],
      contentType: contentTypeToDatabase[reference.contentType],
      code: reference.code,
      status: ContentStatus.ACTIVE,
    },
    orderBy: { campaignId: 'desc' },
    include: { versions: { where: { versionNumber: reference.versionNumber }, include: executableVersionInclude, take: 1 } },
  });
  const version = definition?.versions[0];
  if (definition === null || definition === undefined || version === undefined) throw new NotFoundError('Content version');
  const known = await client.actorContent.findFirst({
    where: { actorId, contentDefinitionId: definition.id, contentVersionId: version.id, state: { in: [ActorContentState.KNOWN, ActorContentState.MASTERED] } },
  });
  if (known === null) {
    const equipped = await client.inventoryEntry.findFirst({ where: { actorId, contentVersionId: version.id, equipmentSlots: { some: {} } } });
    if (equipped === null) throw operationError('CONTENT_NOT_EXECUTABLE', 'Actor does not know or have the exact content version equipped');
  }
  return { definition, version, inventoryEntry: null };
}

function mechanicalProfile(value: unknown): CoreV1MechanicalContentProfile {
  const validated = validateCoreV1ContentProfile(value);
  if (!validated.ok || validated.value.profileMode !== 'mechanical') throw operationError('INVALID_CONTENT_EXECUTION', 'Content is not a valid mechanical profile');
  if (validated.value.activation.type !== 'active') {
    throw operationError('REQUIRES_ACTION_ORCHESTRATOR', 'Triggered, reaction and passive content cannot be executed manually');
  }
  if (validated.value.cost.type === 'custom') throw operationError('UNSUPPORTED_CUSTOM_RESOURCE', 'Persisted custom resources are not supported in this phase');
  return validated.value;
}

function resolvedEffects(profile: CoreV1MechanicalContentProfile) {
  const root = (profile.damageComponents?.length ?? 0) > 0 && profile.targeting !== undefined
    ? [{ type: 'damage', damageComponents: profile.damageComponents, targeting: profile.targeting } as const]
    : [];
  return [...root, ...(profile.effects ?? [])];
}

function assertTargeting(profile: CoreV1MechanicalContentProfile, sourceRef: string, targetRef: string) {
  const targetings = [profile.targeting?.type, ...(profile.effects ?? []).flatMap((effect) => 'targeting' in effect ? [effect.targeting.type] : [])]
    .filter((value) => value !== undefined);
  if (targetings.some((type) => !['self', 'single_target', 'weapon_attack'].includes(type))) {
    throw operationError('REQUIRES_ACTION_ORCHESTRATOR', 'Multi-target content requires the action orchestrator');
  }
  if (targetings.includes('self') && targetings.some((type) => type !== 'self')) {
    throw operationError('REQUIRES_ACTION_ORCHESTRATOR', 'Mixed targeting requires the action orchestrator');
  }
  if (targetings.length > 0 && targetings.every((type) => type === 'self') && sourceRef !== targetRef) {
    throw operationError('INVALID_TARGET', 'Self-targeted content must target the source actor');
  }
}

function statusDefinitions(
  effects: ReturnType<typeof resolvedEffects>,
  refs: readonly string[],
  bindings: readonly { effectIndex: number; targetContentVersion: { versionNumber: number; profile: Prisma.JsonValue | null; contentDefinition: { campaignId: string | null; contentType: ContentType; code: string } } }[],
): CoreV1StatusDefinitionBinding[] {
  return effects.flatMap((effect, index) => {
    if (effect.type !== 'apply_status' && effect.type !== 'remove_status') return [];
    const binding = bindings.find((candidate) => candidate.effectIndex === index);
    if (binding === undefined) throw operationError('CONTENT_EFFECT_BINDING_UNRESOLVED', 'Persisted status binding is missing');
    const validated = validateCoreV1ContentProfile(binding.targetContentVersion.profile);
    const profile = validated.ok && validated.value.profileMode === 'mechanical' ? validated.value : undefined;
    return [{ effectIndex: index, effectRef: refs[index] as string, contentVersion: contentReference(binding.targetContentVersion), ...(profile === undefined ? {} : { profile }) }];
  });
}

function runtimeDurations(profile: CoreV1MechanicalContentProfile, effects: ReturnType<typeof resolvedEffects>): CoreV1RuntimeDurationBinding[] {
  return effects.flatMap((effect, effectIndex) => effect.type === 'grant_reaction' && profile.duration !== undefined
    ? [{ effectIndex, duration: profile.duration }]
    : []);
}

async function weaponDamage(client: Transaction, actorId: string, entryRef: string | undefined, effects: ReturnType<typeof resolvedEffects>) {
  if (!effects.some((effect) => effect.type === 'add_damage')) return undefined;
  if (entryRef === undefined) throw operationError('WEAPON_REQUIRED', 'add_damage requires an exact equipped weapon entry');
  const entry = await client.inventoryEntry.findUnique({
    where: { actorId_entryRef: { actorId, entryRef } },
    include: { contentVersion: true, equipmentSlots: true },
  });
  if (entry === null || entry.equipmentSlots.length === 0) throw operationError('WEAPON_REQUIRED', 'Weapon entry is not equipped');
  const profile = mechanicalProfile(entry.contentVersion.profile);
  if (profile.contentKind !== 'weapon' || profile.damageComponents === undefined) throw operationError('WEAPON_REQUIRED', 'Equipped entry has no weapon damage profile');
  return profile.damageComponents;
}

async function costModifiers(client: Transaction, actorId: string, tick: bigint): Promise<CoreV1CostModifierSet> {
  const [inventory, active] = await Promise.all([
    loadActorInventoryMechanicalInputs(client, actorId),
    loadActorActiveEffectMechanicalInputs(client, actorId, tick),
  ]);
  const all = [...inventory.modifiers, ...active.modifiers];
  const pick = (target: string) => all.filter((modifier) => modifier.target === target).map(({ source, value }) => ({ source, value }));
  const manaCostBps = pick('manaCostBps');
  const spCostBps = pick('spCostBps');
  const hpCostBps = pick('hpCostBps');
  return {
    ...(manaCostBps.length === 0 ? {} : { manaCostBps }),
    ...(spCostBps.length === 0 ? {} : { spCostBps }),
    ...(hpCostBps.length === 0 ? {} : { hpCostBps }),
  };
}

async function defenseContext(client: Transaction, actorId: string, sheet: Awaited<ReturnType<typeof loadActorMechanicalSheet>>) {
  const inventory = await loadActorInventoryMechanicalInputs(client, actorId);
  return {
    blockValue: 0,
    completeBlock: false,
    temporaryImmunities: {
      physical: inventory.defense.physicalImmune,
      magical: inventory.defense.magicalImmune,
      elements: inventory.defense.immuneElements,
    },
    temporaryResistances: {
      physicalResistanceBps: sheet.secondaryAttributes.physicalResistanceBps,
      magicalResistanceBps: sheet.secondaryAttributes.magicalResistanceBps,
      elementalResistanceBps: sheet.secondaryAttributes.elementalResistanceBps,
    },
  };
}

async function persistResources(client: Transaction, actorId: string, before: CoreV1ActorEffectContext, after: CoreV1ActorEffectContext) {
  const map = { hp: ActorResourceType.HP, mana: ActorResourceType.MANA, sp: ActorResourceType.SP } as const;
  const changed: string[] = [];
  for (const key of Object.keys(map) as Array<keyof typeof map>) {
    if (before.resources[key].current === after.resources[key].current) continue;
    await client.actorResource.update({
      where: { actorId_type: { actorId, type: map[key] } },
      data: { current: after.resources[key].current, stateVersion: { increment: 1 } },
    });
    changed.push(key);
  }
  return changed;
}

async function persistInventoryConsumption(client: Transaction, actorId: string, entryRef: string) {
  const entry = await client.inventoryEntry.findUnique({ where: { actorId_entryRef: { actorId, entryRef } } });
  if (entry === null) throw new NotFoundError('Consumable inventory entry');
  if (entry.entryKind === 'STACK') {
    if (entry.quantity <= 1) await client.inventoryEntry.delete({ where: { id: entry.id } });
    else await client.inventoryEntry.update({ where: { id: entry.id }, data: { quantity: { decrement: 1 } } });
  } else await client.inventoryEntry.update({ where: { id: entry.id }, data: { instanceLifecycle: 'CONSUMED' } });
}

function originsFor(
  effects: readonly CoreV1ActiveEffectInstance[],
  existing: readonly { effectRef: string; sourceActorId: string; sourceContentVersionId: string; effectContentVersionId: string | null; effectRulesVersionId: string }[],
  sourceActorId: string,
  sourceContentVersionId: string,
  effectRulesVersionId: string,
  status: readonly CoreV1StatusDefinitionBinding[],
  bindingIds: ReadonlyMap<number, string>,
) {
  const origins = new Map<string, ActiveEffectPersistenceOrigin>(existing.map((row) => [row.effectRef, row]));
  for (const effect of effects) {
    if (origins.has(effect.effectRef)) continue;
    const statusBinding = status.find((binding) => binding.effectIndex === effect.effectIndex);
    origins.set(effect.effectRef, {
      sourceActorId,
      sourceContentVersionId,
      effectRulesVersionId,
      effectContentVersionId: statusBinding === undefined ? null : bindingIds.get(effect.effectIndex) ?? null,
    });
  }
  return origins;
}

async function persistActorEffects(
  client: Transaction,
  actorId: string,
  effects: readonly CoreV1ActiveEffectInstance[],
  origin: Omit<ActiveEffectPersistenceOrigin, 'effectContentVersionId'>,
  statuses: readonly CoreV1StatusDefinitionBinding[],
  bindingIds: ReadonlyMap<number, string>,
) {
  const existing = await client.activeEffect.findMany({ where: { targetActorId: actorId } });
  const origins = originsFor(effects, existing, origin.sourceActorId, origin.sourceContentVersionId, origin.effectRulesVersionId, statuses, bindingIds);
  return persistActorActiveEffects(client, actorId, effects, origins);
}

function resultError(result: { ok: false; code: string; issues: readonly unknown[] }): never {
  throw operationError(result.code, result.code === 'INSUFFICIENT_RESOURCE' ? 'Actor has insufficient resources' : 'Effect resolution is invalid for the current state');
}

function publicState(actor: { code: string }, sheet: Awaited<ReturnType<typeof loadActorMechanicalSheet>>) {
  return {
    actorRef: actor.code,
    mechanicsStateVersion: sheet.mechanicsStateVersion,
    inventoryStateVersion: sheet.inventoryStateVersion,
    effectsStateVersion: sheet.effectsStateVersion,
    resources: sheet.resources,
  };
}

export async function getActorEffects(client: Transaction, input: ResolveActorEffectInput) {
  const scope = await resolveScope(client, input);
  const actor = await client.actor.findUnique({ where: { campaignId_code: { campaignId: scope.campaign.id, code: input.sourceActorRef } }, select: { id: true, code: true } });
  if (actor === null) throw new NotFoundError('Actor');
  const [effects, sheet] = await Promise.all([
    loadActorEffectsDto(client, actor.id, actor.code),
    loadActorMechanicalSheet(client, actor.id),
  ]);
  return {
    operation: 'get',
    ...effects,
    mechanicsStateVersion: sheet.mechanicsStateVersion,
    inventoryStateVersion: sheet.inventoryStateVersion,
    resources: sheet.resources,
  };
}

export async function resolveActorEffectTransaction(
  client: Transaction,
  input: WriteInput,
  requestHash: string,
  rollProvider: RollProvider = cryptographicRollProvider,
) {
  const scope = await resolveScope(client, input);
  await client.$queryRaw(Prisma.sql`SELECT 1 FROM "Campaign" WHERE id = ${scope.campaign.id}::uuid FOR UPDATE`);
  const targetRef = input.targetActorRef as string;
  let actors = await resolveActors(client, scope.campaign.id, input.sourceActorRef, targetRef);
  await assertExpectedState(client, actors.source, input.expectedSourceState as ExpectedState);
  if (actors.target.id !== actors.source.id) await assertExpectedState(client, actors.target, input.expectedTargetState as ExpectedState);
  await expireDueActorEffects(client, actors.source.id, scope.campaign.engineTick);
  if (actors.target.id !== actors.source.id) await expireDueActorEffects(client, actors.target.id, scope.campaign.engineTick);
  actors = await resolveActors(client, scope.campaign.id, input.sourceActorRef, targetRef);

  const executable = await executableContent(client, scope, actors.source.id, input);
  if (executable.version.rulesetVersionId !== scope.campaign.rulesetVersionId) throw operationError('RULESET_VERSION_MISMATCH', 'Content version is incompatible with the campaign');
  const profile = mechanicalProfile(executable.version.profile);
  assertTargeting(profile, actors.source.code, actors.target.code);
  const effects = resolvedEffects(profile);
  const sourceContent = contentReference({ ...executable.version, contentDefinition: executable.definition });
  const refs = effects.map((_, index) => createDeterministicEffectRef(actors.target.code, sourceContent, index));
  const statuses = statusDefinitions(effects, refs, executable.version.sourceEffectBindings);
  const bindingIds = new Map<number, string>(executable.version.sourceEffectBindings.map((binding) => [binding.effectIndex, binding.targetContentVersionId]));
  const durations = runtimeDurations(profile, effects);
  const [sourceContext, targetContext, targetSheet, effectRulesVersion] = await Promise.all([
    actorContext(client, actors.source),
    actors.target.id === actors.source.id ? actorContext(client, actors.source) : actorContext(client, actors.target),
    loadActorMechanicalSheet(client, actors.target.id),
    ensureCoreV1EffectRulesVersion(client),
  ]);
  const coherentTarget = actors.target.id === actors.source.id ? sourceContext : targetContext;
  const needsRolls = effects.some((effect) => effect.type === 'damage' || effect.type === 'add_damage');
  const [weaponDamageComponents, modifiers, defense] = await Promise.all([
    weaponDamage(client, actors.source.id, input.weaponEntryRef, effects),
    costModifiers(client, actors.source.id, scope.campaign.engineTick),
    defenseContext(client, actors.target.id, targetSheet),
  ]);
  const commonWithoutRolls = {
    sourceActor: sourceContext,
    targetActor: coherentTarget,
    currentTick: scope.campaign.engineTick,
    effectRefs: refs,
    statusDefinitions: statuses,
    runtimeDurations: durations,
    targeting: { targetRef: actors.target.code, targetOrdinal: 0, damageMultiplierBps: 10_000 },
    defense,
    ...(weaponDamageComponents === undefined ? {} : { weaponDamageComponents }),
    costModifiers: modifiers,
  } as const;
  const preflightRolls: CoreV1InjectedRolls | undefined = needsRolls ? { hitRollBps: 1, criticalRollBps: 1 } : undefined;
  const preflightCommon = { ...commonWithoutRolls, ...(preflightRolls === undefined ? {} : { rolls: preflightRolls }) };
  const preflight = input.operation === 'use_consumable'
    ? resolveCoreV1ConsumableUse({
      ...preflightCommon,
      inventory: (await loadActorInventoryMechanicalInputs(client, actors.source.id)).inventory,
      entryRef: input.inventoryEntryRef as string,
      contentVersionRef: sourceContent as CoreV1ContentVersionReference,
      profile,
    })
    : resolveCoreV1EffectSequence({ ...preflightCommon, profile, sourceContent });
  if (!preflight.ok) resultError(preflight);
  const rolls: CoreV1InjectedRolls | undefined = needsRolls ? {
    hitRollBps: rollProvider.nextBps('hit'),
    criticalRollBps: rollProvider.nextBps('critical'),
  } : undefined;
  const common = { ...commonWithoutRolls, ...(rolls === undefined ? {} : { rolls }) };
  let sequence: CoreV1EffectSequenceResult;
  let resolutionEvents: CoreV1EffectSequenceResult['events'];
  if (input.operation === 'use_consumable') {
    const resolved = resolveCoreV1ConsumableUse({
      ...common,
      inventory: (await loadActorInventoryMechanicalInputs(client, actors.source.id)).inventory,
      entryRef: input.inventoryEntryRef as string,
      contentVersionRef: sourceContent as CoreV1ContentVersionReference,
      profile,
    });
    if (!resolved.ok) resultError(resolved);
    sequence = resolved.value.sequence;
    resolutionEvents = resolved.value.events;
  } else {
    const resolved = resolveCoreV1EffectSequence({ ...common, profile, sourceContent });
    if (!resolved.ok) resultError(resolved);
    sequence = resolved.value;
    resolutionEvents = resolved.value.events;
  }

  const preexistingSourceRefs = new Set(sourceContext.activeEffects.map((effect) => effect.effectRef));
  const sourceForAdvance = { ...sequence.sourceAfter, activeEffects: sequence.sourceAfter.activeEffects.filter((effect) => preexistingSourceRefs.has(effect.effectRef)) };
  const advanced = advanceActorActionDurations(sourceForAdvance, actors.source.code);
  if (!advanced.ok) resultError(advanced);
  const newSourceEffects = sequence.sourceAfter.activeEffects.filter((effect) => !preexistingSourceRefs.has(effect.effectRef));
  const finalSource = { ...sequence.sourceAfter, activeEffects: [...advanced.value.actor.activeEffects, ...newSourceEffects] };
  const finalTarget = actors.target.id === actors.source.id ? finalSource : sequence.targetAfter;

  const sourceResources = await persistResources(client, actors.source.id, sourceContext, finalSource);
  const targetResources = actors.target.id === actors.source.id ? [] : await persistResources(client, actors.target.id, coherentTarget, finalTarget);
  const origin = { sourceActorId: actors.source.id, sourceContentVersionId: executable.version.id, effectRulesVersionId: effectRulesVersion.id };
  const sourceEffectsChanged = await persistActorEffects(client, actors.source.id, finalSource.activeEffects, origin, statuses, bindingIds);
  const targetEffectsChanged = actors.target.id === actors.source.id
    ? sourceEffectsChanged
    : await persistActorEffects(client, actors.target.id, finalTarget.activeEffects, origin, statuses, bindingIds);
  const inventoryChanged = input.operation === 'use_consumable';
  if (inventoryChanged) await persistInventoryConsumption(client, actors.source.id, input.inventoryEntryRef as string);

  const actorChanges = new Map<string, { effects: boolean; inventory: boolean }>();
  actorChanges.set(actors.source.id, { effects: sourceEffectsChanged, inventory: inventoryChanged });
  if (actors.target.id !== actors.source.id) actorChanges.set(actors.target.id, { effects: targetEffectsChanged, inventory: false });
  for (const [actorId, change] of actorChanges) {
    if (!change.effects && !change.inventory) continue;
    await client.actor.update({
      where: { id: actorId },
      data: {
        mechanicsStateVersion: { increment: 1 },
        ...(change.effects ? { effectsStateVersion: { increment: 1 } } : {}),
        ...(change.inventory ? { inventoryStateVersion: { increment: 1 } } : {}),
      },
    });
    await recomputeActorDerivedSnapshot(client, actorId);
  }

  const [sourceSheetAfter, targetSheetAfter] = await Promise.all([
    loadActorMechanicalSheet(client, actors.source.id),
    actors.target.id === actors.source.id ? loadActorMechanicalSheet(client, actors.source.id) : loadActorMechanicalSheet(client, actors.target.id),
  ]);
  const rollSnapshots = sequence.damageResults.flatMap((damage, ordinal) => rolls === undefined ? [] : [
    { kind: 'hit' as const, ordinal, rollBps: rolls.hitRollBps, chanceBps: damage.hitChanceBps, success: damage.hit },
    { kind: 'critical' as const, ordinal, rollBps: rolls.criticalRollBps, chanceBps: damage.criticalChanceBps, success: damage.critical },
  ]);
  const response = {
    operation: input.operation,
    engineTick: scope.campaign.engineTick.toString(10),
    content: sourceContent,
    source: publicState(actors.source, sourceSheetAfter),
    target: publicState(actors.target, targetSheetAfter),
    effectResults: sequence.effectResults,
    cost: sequence.costResolution,
    activeEffectChanges: [...sequence.activeEffectChanges, ...advanced.value.changes],
    resourceChanges: sequence.resourceChanges,
    damageResults: sequence.damageResults,
    defeatedCandidate: sequence.damageResults.some((damage) => damage.defeatedCandidate),
    inventoryChanges: inventoryChanged ? [{ entryRef: input.inventoryEntryRef, change: 'consumed' }] : [],
    rolls: rollSnapshots,
    events: resolutionEvents,
    changedResources: { source: sourceResources, target: targetResources },
  };
  const resultHash = calculateEffectResolutionResultHash(response);
  const resolution = await client.effectResolution.create({
    data: {
      campaignId: scope.campaign.id,
      sourceActorId: actors.source.id,
      targetActorId: actors.target.id,
      sourceContentVersionId: executable.version.id,
      effectRulesVersionId: effectRulesVersion.id,
      operation: input.operation === 'use_consumable' ? EffectResolutionOperation.USE_CONSUMABLE : EffectResolutionOperation.EXECUTE_CONTENT,
      idempotencyKey: input.idempotencyKey as string,
      engineTick: scope.campaign.engineTick,
      requestHash,
      resultHash,
      resultSnapshot: json(response),
    },
  });
  if (rollSnapshots.length > 0) {
    await client.effectRoll.createMany({ data: rollSnapshots.map((roll) => ({
      effectResolutionId: resolution.id,
      kind: roll.kind === 'hit' ? EffectRollKind.HIT : EffectRollKind.CRITICAL,
      ordinal: roll.ordinal,
      rollBps: roll.rollBps,
      chanceBps: roll.chanceBps,
      success: roll.success,
    })) });
  }
  for (const [index, event] of response.events.entries()) {
    await client.gameEvent.create({ data: {
      campaignId: scope.campaign.id,
      actorId: actors.source.id,
      eventType: event.eventType,
      title: event.eventType.replaceAll('_', ' '),
      payload: json({
        schemaVersion: 1,
        eventType: event.eventType,
        sourceActorRef: event.sourceActorRef,
        targetActorRef: event.targetActorRef,
        contentRef: event.contentRef,
        ...(event.resource === undefined ? {} : { resource: event.resource }),
        amountPresent: event.amount !== undefined,
        ...(event.stacks === undefined ? {} : { stacks: event.stacks }),
      }),
      idempotencyKey: `${input.idempotencyKey}:effect:${index}`,
    } });
  }
  return response;
}
