import {
  ActiveEffectDurationType,
  ActiveEffectKind,
  Prisma,
  type ActiveEffect,
} from '../../generated/prisma/client.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { recomputeActorDerivedSnapshot } from '../actors/actor-mechanics.service.js';
import {
  advanceActorActionDurations,
  closeEffectScope,
  expireEffectsAtTick,
  type CoreV1ActiveEffectInstance,
  type CoreV1ActorEffectContext,
} from '../rules/core-v1/index.js';
import { loadActorActiveEffectMechanicalInputs } from './active-effect-mechanical-inputs.js';
import type { ActorActiveEffectMechanicalInputs } from './active-effect-mechanical-inputs.js';

export type EffectStateClient = Pick<
  Prisma.TransactionClient,
  'activeEffect' | 'actor' | 'campaign' | 'actorAttribute' | 'actorResource' | 'actorDerivedSnapshot'
  | 'rulesetVersion' | 'ruleset' | 'inventoryEntry' | 'actorEquipmentSlot'
>;

export interface ActiveEffectPersistenceOrigin {
  sourceActorId: string;
  sourceContentVersionId: string;
  effectContentVersionId: string | null;
  effectRulesVersionId: string;
  originEncounterId: string | null;
}

const kindToDatabase = {
  status: ActiveEffectKind.STATUS,
  primary_modifier: ActiveEffectKind.PRIMARY_MODIFIER,
  secondary_modifier: ActiveEffectKind.SECONDARY_MODIFIER,
  reaction_grant: ActiveEffectKind.REACTION_GRANT,
} as const;

function durationData(effect: CoreV1ActiveEffectInstance) {
  const duration = effect.durationState;
  if (duration.type === 'ticks') return { durationType: ActiveEffectDurationType.TICKS, expiresAtTick: duration.expiresAtTick, remainingActions: null };
  if (duration.type === 'actions') return { durationType: ActiveEffectDurationType.ACTIONS, expiresAtTick: null, remainingActions: duration.remainingActions };
  if (duration.type === 'scene') return { durationType: ActiveEffectDurationType.SCENE, expiresAtTick: null, remainingActions: null };
  if (duration.type === 'encounter') return { durationType: ActiveEffectDurationType.ENCOUNTER, expiresAtTick: null, remainingActions: null };
  return { durationType: ActiveEffectDurationType.PERMANENT, expiresAtTick: null, remainingActions: null };
}

function payload(effect: CoreV1ActiveEffectInstance): Prisma.InputJsonValue {
  const value = effect.payload.type === 'status'
    ? { type: 'status' }
    : effect.payload;
  return value;
}

export async function persistActorActiveEffects(
  client: EffectStateClient,
  actorId: string,
  effects: readonly CoreV1ActiveEffectInstance[],
  origins: ReadonlyMap<string, ActiveEffectPersistenceOrigin>,
): Promise<boolean> {
  const existing = await client.activeEffect.findMany({ where: { targetActorId: actorId } });
  const existingByRef = new Map(existing.map((row) => [row.effectRef, row]));
  const desiredRefs = new Set(effects.map((effect) => effect.effectRef));
  const removedIds = existing.filter((row) => !desiredRefs.has(row.effectRef)).map((row) => row.id);
  if (removedIds.length > 0) await client.activeEffect.deleteMany({ where: { id: { in: removedIds } } });
  let changed = removedIds.length > 0;
  for (const effect of effects) {
    const current = existingByRef.get(effect.effectRef);
    const origin = origins.get(effect.effectRef) ?? (current === undefined ? undefined : {
      sourceActorId: current.sourceActorId,
      sourceContentVersionId: current.sourceContentVersionId,
      effectContentVersionId: current.effectContentVersionId,
      effectRulesVersionId: current.effectRulesVersionId,
      originEncounterId: current.originEncounterId,
    });
    if (origin === undefined) throw new Error('Active effect origin failed integrity validation');
    const data = {
      targetActorId: actorId,
      ...origin,
      effectRef: effect.effectRef,
      effectIndex: effect.effectIndex,
      kind: kindToDatabase[effect.kind],
      stacks: effect.stacks,
      appliedAtTick: effect.appliedAtTick,
      ...durationData(effect),
      payload: payload(effect),
    };
    if (current === undefined) {
      await client.activeEffect.create({ data });
      changed = true;
      continue;
    }
    const same = current.sourceActorId === data.sourceActorId
      && current.sourceContentVersionId === data.sourceContentVersionId
      && current.effectContentVersionId === data.effectContentVersionId
      && current.effectRulesVersionId === data.effectRulesVersionId
      && current.originEncounterId === data.originEncounterId
      && current.effectIndex === data.effectIndex
      && current.kind === data.kind
      && current.stacks === data.stacks
      && current.appliedAtTick === data.appliedAtTick
      && current.durationType === data.durationType
      && current.expiresAtTick === data.expiresAtTick
      && current.remainingActions === data.remainingActions;
    if (!same) {
      await client.activeEffect.update({ where: { id: current.id }, data });
      changed = true;
    }
  }
  return changed;
}

function publicDuration(row: ActiveEffect) {
  const type = normalizeEnum(row.durationType);
  if (row.expiresAtTick !== null) return { type, expiresAtTick: row.expiresAtTick.toString(10) };
  if (row.remainingActions !== null) return { type, remainingActions: row.remainingActions };
  return { type };
}

export async function loadActorEffectsDto(client: EffectStateClient, actorId: string, actorRef: string) {
  const actor = await client.actor.findUnique({ where: { id: actorId }, select: { effectsStateVersion: true } });
  if (actor === null) throw new NotFoundError('Actor');
  const rows = await client.activeEffect.findMany({
    where: { targetActorId: actorId },
    include: {
      sourceActor: { select: { code: true } },
      sourceContentVersion: { include: { contentDefinition: true } },
      effectContentVersion: { include: { contentDefinition: true } },
    },
    orderBy: { effectRef: 'asc' },
  });
  const content = (version: typeof rows[number]['sourceContentVersion']) => ({
    scope: version.contentDefinition.campaignId === null ? 'world' : 'campaign',
    contentType: normalizeEnum(version.contentDefinition.contentType),
    code: version.contentDefinition.code,
    versionNumber: version.versionNumber,
  });
  return {
    actorRef,
    effectsStateVersion: actor.effectsStateVersion,
    activeEffects: rows.map((row) => ({
      effectRef: row.effectRef,
      kind: normalizeEnum(row.kind),
      sourceActorRef: row.sourceActor.code,
      sourceContent: content(row.sourceContentVersion),
      ...(row.effectContentVersion === null ? {} : { statusContent: content(row.effectContentVersion) }),
      effectIndex: row.effectIndex,
      stacks: row.stacks,
      appliedAtTick: row.appliedAtTick.toString(10),
      duration: publicDuration(row),
    })),
  };
}

export async function loadActorActiveEffectSummary(
  client: Pick<Prisma.TransactionClient, 'activeEffect'>,
  actorId: string,
) {
  const groups = await client.activeEffect.groupBy({
    by: ['kind'], where: { targetActorId: actorId }, _count: { _all: true }, orderBy: { kind: 'asc' },
  });
  return {
    total: groups.reduce((total, group) => total + group._count._all, 0),
    statusCount: groups.find((group) => group.kind === ActiveEffectKind.STATUS)?._count._all ?? 0,
    modifierCount: groups.filter((group) => new Set<ActiveEffectKind>([
      ActiveEffectKind.PRIMARY_MODIFIER, ActiveEffectKind.SECONDARY_MODIFIER,
    ]).has(group.kind))
      .reduce((total, group) => total + group._count._all, 0),
    reactionGrantCount: groups.find((group) => group.kind === ActiveEffectKind.REACTION_GRANT)?._count._all ?? 0,
  };
}

export function projectActorActiveEffectSummary(inputs: ActorActiveEffectMechanicalInputs) {
  return {
    total: inputs.activeEffects.length,
    statusCount: inputs.activeEffects.filter((effect) => effect.kind === 'status').length,
    modifierCount: inputs.activeEffects.filter((effect) => ['primary_modifier', 'secondary_modifier'].includes(effect.kind)).length,
    reactionGrantCount: inputs.activeEffects.filter((effect) => effect.kind === 'reaction_grant').length,
  };
}

async function applyLifecycle(
  client: EffectStateClient,
  actorId: string,
  transform: (actor: CoreV1ActorEffectContext) => ReturnType<typeof expireEffectsAtTick>,
) {
  const actor = await client.actor.findUnique({ where: { id: actorId }, include: { campaign: { select: { engineTick: true } } } });
  if (actor === null) throw new NotFoundError('Actor');
  const inputs = await loadActorActiveEffectMechanicalInputs(client, actorId, actor.campaign.engineTick);
  const context = {
    actorRef: actor.code,
    primaryAttributes: { strength: 0, vitality: 0, agility: 0, dexterity: 0, intelligence: 0, wisdom: 0, perception: 0, willpower: 0, luck: 0 },
    resources: { hp: { current: 0, maximum: 0 }, mana: { current: 0, maximum: 0 }, sp: { current: 0, maximum: 0 } },
    secondaryAttributes: {
      actorPhysicalPower: 0, actorMagicalPower: 0, physicalDefense: 0, magicalDefense: 0, accuracy: 0, evasion: 0,
      baseAttackSpeedBps: 1, baseCastingSpeedBps: 1, criticalChanceBps: 0, criticalDamageBps: 0, movementSpeed: 0,
      carryingCapacity: 0, physicalResistanceBps: 0, magicalResistanceBps: 0, elementalResistanceBps: 0,
      hpRegen: 0, manaRegen: 0, spRegen: 0,
    },
    activeEffects: inputs.activeEffects,
    stateVersion: actor.effectsStateVersion,
  } satisfies CoreV1ActorEffectContext;
  const result = transform(context);
  if (!result.ok) throw new Error('Active effect lifecycle failed integrity validation');
  if (result.value.changes.length === 0 && result.value.actor.activeEffects.length === context.activeEffects.length) return result.value;
  const rows = await client.activeEffect.findMany({ where: { targetActorId: actorId } });
  const origins = new Map(rows.map((row) => [row.effectRef, row]));
  await persistActorActiveEffects(client, actorId, result.value.actor.activeEffects, origins);
  await client.actor.update({ where: { id: actorId }, data: { effectsStateVersion: { increment: 1 }, mechanicsStateVersion: { increment: 1 } } });
  await recomputeActorDerivedSnapshot(client, actorId);
  return result.value;
}

export function expireDueActorEffects(client: EffectStateClient, actorId: string, currentTick: bigint) {
  return applyLifecycle(client, actorId, (actor) => expireEffectsAtTick(actor, currentTick));
}

export function advanceActorActionEffects(client: EffectStateClient, actorId: string) {
  return applyLifecycle(client, actorId, (actor) => advanceActorActionDurations(actor, actor.actorRef));
}

export function closeActorEffectScope(client: EffectStateClient, actorId: string, scope: 'scene' | 'encounter') {
  return applyLifecycle(client, actorId, (actor) => closeEffectScope(actor, scope));
}

export async function advanceCampaignEngineTick(
  client: EffectStateClient,
  campaignId: string,
  ticks: bigint,
  expectedEngineStateVersion: number,
) {
  if (ticks <= 0n) throw new RangeError('Campaign engine tick advance must be positive');
  const updated = await client.campaign.updateMany({
    where: { id: campaignId, engineStateVersion: expectedEngineStateVersion },
    data: { engineTick: { increment: ticks }, engineStateVersion: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error('Campaign engine state version conflict');
  const campaign = await client.campaign.findUnique({ where: { id: campaignId }, select: { engineTick: true, engineStateVersion: true } });
  if (campaign === null) throw new NotFoundError('Campaign');
  const actors = await client.actor.findMany({ where: { campaignId }, select: { id: true }, orderBy: { id: 'asc' } });
  for (const actor of actors) await expireDueActorEffects(client, actor.id, campaign.engineTick);
  return campaign;
}
