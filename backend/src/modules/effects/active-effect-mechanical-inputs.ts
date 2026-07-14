import type { Prisma } from '../../generated/prisma/client.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import {
  collectActiveEffectModifiers,
  validateCoreV1ContentProfile,
  type CoreV1ActiveEffectInstance,
  type CoreV1ActiveEffectPayload,
  type CoreV1CollectedActiveModifier,
  type CoreV1EffectContentVersionReference,
  type CoreV1RuntimeDurationState,
} from '../rules/core-v1/index.js';

export type ActiveEffectMechanicalInputsClient = Pick<Prisma.TransactionClient, 'activeEffect'>;

export interface ActorActiveEffectMechanicalInputs {
  activeEffects: readonly CoreV1ActiveEffectInstance[];
  modifiers: readonly CoreV1CollectedActiveModifier[];
  hashInput: readonly {
    effectRef: string;
    sourceContent: CoreV1EffectContentVersionReference;
    effectContent?: CoreV1EffectContentVersionReference;
    kind: CoreV1ActiveEffectInstance['kind'];
    stacks: number;
    duration: { type: string; expiresAtTick?: string; remainingActions?: number };
    payload: unknown;
  }[];
}

function integrityError(): Error {
  return new Error('Actor active effect state failed integrity validation');
}

function contentRef(version: {
  versionNumber: number;
  contentDefinition: { campaignId: string | null; contentType: string; code: string };
}): CoreV1EffectContentVersionReference {
  return {
    scope: version.contentDefinition.campaignId === null ? 'world' : 'campaign',
    contentType: normalizeEnum(version.contentDefinition.contentType) as CoreV1EffectContentVersionReference['contentType'],
    code: version.contentDefinition.code,
    versionNumber: version.versionNumber,
  };
}

function duration(row: {
  durationType: string;
  expiresAtTick: bigint | null;
  remainingActions: number | null;
}): CoreV1RuntimeDurationState {
  const type = normalizeEnum(row.durationType);
  if (type === 'ticks' && row.expiresAtTick !== null) return { type, expiresAtTick: row.expiresAtTick };
  if (type === 'actions' && row.remainingActions !== null) return { type, remainingActions: row.remainingActions };
  if (type === 'scene') return { type, scope: type };
  if (type === 'encounter') return { type, scope: type };
  if (type === 'permanent') return { type, scope: type };
  throw integrityError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function directPayload(value: unknown, kind: string): CoreV1ActiveEffectPayload {
  if (!isRecord(value) || value.type !== kind) throw integrityError();
  if (kind === 'primary_modifier' && typeof value.attributeCode === 'string' && Number.isSafeInteger(value.amount)) {
    return { type: kind, attributeCode: value.attributeCode as never, amount: value.amount as number };
  }
  if (kind === 'secondary_modifier' && typeof value.secondaryCode === 'string' && Number.isSafeInteger(value.amount)) {
    return { type: kind, secondaryCode: value.secondaryCode as never, amount: value.amount as number };
  }
  if (kind === 'reaction_grant' && typeof value.reactionKind === 'string'
    && (value.reactionDepth === 1 || value.reactionDepth === 2)) {
    return { type: kind, reactionKind: value.reactionKind as never, reactionDepth: value.reactionDepth };
  }
  throw integrityError();
}

export async function loadActorActiveEffectMechanicalInputs(
  client: ActiveEffectMechanicalInputsClient,
  actorId: string,
  currentTick: bigint,
): Promise<ActorActiveEffectMechanicalInputs> {
  const rows = await client.activeEffect.findMany({
    where: { targetActorId: actorId },
    include: {
      sourceActor: { select: { code: true } },
      targetActor: { select: { code: true } },
      sourceContentVersion: { include: { contentDefinition: true } },
      effectContentVersion: { include: { contentDefinition: true } },
    },
    orderBy: { effectRef: 'asc' },
  });
  const activeEffects = rows.map((row): CoreV1ActiveEffectInstance => {
    const sourceContent = contentRef(row.sourceContentVersion);
    const durationState = duration(row);
    const kind = normalizeEnum(row.kind) as CoreV1ActiveEffectInstance['kind'];
    let payload: CoreV1ActiveEffectPayload;
    if (kind === 'status') {
      const effectContent = row.effectContentVersion;
      if (effectContent === null) throw integrityError();
      const validation = validateCoreV1ContentProfile(effectContent.profile);
      if (!validation.ok || validation.value.profileMode !== 'mechanical'
        || validation.value.contentKind !== 'status_effect'
        || validation.value.duration === undefined || validation.value.stacking === undefined) throw integrityError();
      payload = {
        type: 'status',
        contentVersion: contentRef(effectContent),
        profile: validation.value,
        stacking: validation.value.stacking,
        baseDuration: validation.value.duration,
      };
    } else payload = directPayload(row.payload, kind);
    return {
      effectRef: row.effectRef,
      sourceActorRef: row.sourceActor.code,
      targetActorRef: row.targetActor.code,
      sourceContent,
      effectIndex: row.effectIndex,
      kind,
      stacks: row.stacks,
      appliedAtTick: row.appliedAtTick,
      durationState,
      payload,
    };
  });
  const actorContext = {
    actorRef: rows[0]?.targetActor.code ?? 'empty-effect-projection',
    primaryAttributes: {
      strength: 0, vitality: 0, agility: 0, dexterity: 0, intelligence: 0,
      wisdom: 0, perception: 0, willpower: 0, luck: 0,
    },
    resources: {
      hp: { current: 0, maximum: 0 }, mana: { current: 0, maximum: 0 }, sp: { current: 0, maximum: 0 },
    },
    secondaryAttributes: {
      actorPhysicalPower: 0, actorMagicalPower: 0, physicalDefense: 0, magicalDefense: 0,
      accuracy: 0, evasion: 0, baseAttackSpeedBps: 1, baseCastingSpeedBps: 1,
      criticalChanceBps: 0, criticalDamageBps: 0, movementSpeed: 0, carryingCapacity: 0,
      physicalResistanceBps: 0, magicalResistanceBps: 0, elementalResistanceBps: 0,
      hpRegen: 0, manaRegen: 0, spRegen: 0,
    },
    activeEffects,
    stateVersion: 1,
  } as const;
  const collected = collectActiveEffectModifiers(actorContext, currentTick);
  if (!collected.ok) throw integrityError();
  return {
    activeEffects,
    modifiers: collected.value,
    hashInput: activeEffects.map((effect) => ({
      effectRef: effect.effectRef,
      sourceContent: effect.sourceContent,
      ...(effect.payload.type === 'status' ? { effectContent: effect.payload.contentVersion } : {}),
      kind: effect.kind,
      stacks: effect.stacks,
      duration: effect.durationState.type === 'ticks'
        ? { type: 'ticks', expiresAtTick: effect.durationState.expiresAtTick.toString(10) }
        : effect.durationState.type === 'actions'
          ? { type: 'actions', remainingActions: effect.durationState.remainingActions }
          : { type: effect.durationState.type },
      payload: effect.payload.type === 'status'
        ? {
          type: 'status',
          passiveModifiers: effect.payload.profile.passiveModifiers ?? [],
          stacking: effect.payload.stacking,
          baseDuration: effect.payload.baseDuration,
        }
        : effect.payload,
    })),
  };
}
