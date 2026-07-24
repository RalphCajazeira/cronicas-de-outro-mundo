import { Prisma } from '../../generated/prisma/client.js';
import type { DbClient } from '../../shared/database/game-scope.js';
import { isExpectedUniqueConflict } from '../../shared/database/prisma-errors.js';
import { AppError, NotFoundError } from '../../shared/errors/app-error.js';
import type { ManageActorProgressionInput } from '../gpt/gpt.schemas.js';
import {
  CORE_V1_ATTRIBUTE_HARD_CAP,
  CORE_V1_LEVEL_CAP,
  CORE_V1_PRIMARY_ATTRIBUTES,
  CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM,
  CORE_V1_2_XP_STORAGE_MAXIMUM,
  CORE_V1_2_VERSION_CODE,
  legacyNextLevelXp,
  nextCoreV12LevelXp,
  type PrimaryAttributeCode,
  type PrimaryAttributes,
  type ValidationIssue,
} from '../rules/core-v1/index.js';
import {
  validateSupportedCoreRulesetVersion,
  type CoreRulesetVersion,
} from '../rules/ruleset.registry.js';
import { assertActorsMutableOutsideEncounter } from '../encounters/encounter-authority-guard.js';
import {
  attributeCodeToDatabase,
  actorProgressionPolicy,
  loadActorMechanicalSheet,
  projectStoredAttributeState,
  recomputeActorDerivedSnapshot,
  validateActorProgressionAttributes,
} from './actor-mechanics.service.js';

interface ActorProgressionRecord {
  readonly id: string;
  readonly campaignId: string;
  readonly code: string;
  readonly level: number;
  readonly xp: number;
  readonly mechanicsStateVersion: number;
  readonly campaign: { readonly rulesetVersion: CoreRulesetVersion };
  readonly attributes: readonly {
    readonly code: (typeof attributeCodeToDatabase)[PrimaryAttributeCode];
    readonly baseValue: number;
    readonly earnedValue: number;
  }[];
}

export interface ActorProgressionDto extends Record<string, unknown> {
  readonly actorRef: string;
  readonly level: number;
  readonly xpCurrent: number;
  readonly xpRequiredForNextLevel: number | null;
  readonly basePrimaryAttributes: PrimaryAttributes;
  readonly progressionPrimaryAttributes: PrimaryAttributes;
  readonly effectivePrimaryAttributes: PrimaryAttributes;
  readonly attributePointsEarned: number;
  readonly attributePointsAllocated: number;
  readonly attributePointsAvailable: number;
  readonly totalAttributeEntitlement: number;
  readonly mechanicsStateVersion: number;
  readonly canLevelUp: boolean;
}

interface ResourceState {
  readonly hp: { readonly current: number; readonly max: number };
  readonly mana: { readonly current: number; readonly max: number };
  readonly sp: { readonly current: number; readonly max: number };
}

function progressionStateVersionConflict(): AppError {
  return new AppError(409, 'MECHANICS_STATE_VERSION_CONFLICT', 'Actor mechanics state version does not match', {
    retryable: false,
    recoveryAction: 'get_actor_progression',
    auditCode: 'ACTOR_PROGRESSION_STATE_VERSION_CONFLICT',
    issues: [{
      path: 'expectedMechanicsStateVersion',
      code: 'STATE_VERSION_CONFLICT',
      message: 'Get actor progression again and use the returned mechanicsStateVersion in a new request.',
    }],
  });
}

function publicProgressionIssue(issue: ValidationIssue) {
  const knownRules = new Set([
    'PLAIN_OBJECT',
    'UNKNOWN_ATTRIBUTE',
    'REQUIRED',
    'INTEGER',
    'CREATION_RANGE',
    'INITIAL_ATTRIBUTE_BUDGET',
    'ATTRIBUTE_KEYS',
    'ATTRIBUTE_PROGRESSION_VALUE',
    'ATTRIBUTE_POINTS_EXCEEDED',
    'ATTRIBUTE_EFFECTIVE_CAP',
    'LEVEL',
    'LEVEL_TECHNICAL_RANGE',
  ]);
  const path = issue.path.replace(/^primaryAttributes/, 'basePrimaryAttributes');
  const code = knownRules.has(issue.rule) ? issue.rule : 'ACTOR_PROGRESSION_RULE_REJECTED';
  const messages: Readonly<Record<string, string>> = {
    PLAIN_OBJECT: 'Base primary attributes must be a closed object.',
    UNKNOWN_ATTRIBUTE: 'Use only the nine canonical primary attributes.',
    REQUIRED: 'All nine base primary attributes are required.',
    INTEGER: 'Primary attribute values must be safe integers.',
    CREATION_RANGE: 'Each base primary attribute must be between 4 and 16.',
    INITIAL_ATTRIBUTE_BUDGET: 'Base primary attributes must total exactly 90 points.',
    ATTRIBUTE_KEYS: 'Use exactly the nine canonical primary attributes.',
    ATTRIBUTE_PROGRESSION_VALUE: 'Progression attribute values must be non-negative safe integers.',
    ATTRIBUTE_POINTS_EXCEEDED: 'Allocated progression points exceed the entitlement for this level.',
    ATTRIBUTE_EFFECTIVE_CAP: `An effective attribute cannot exceed the versioned core-v1 cap of ${CORE_V1_ATTRIBUTE_HARD_CAP}.`,
    LEVEL: `Actor level must be between 1 and ${CORE_V1_LEVEL_CAP}.`,
    LEVEL_TECHNICAL_RANGE: `Actor level exceeds the technical safe range ending at ${CORE_V1_2_TECHNICAL_LEVEL_MAXIMUM}; this is not a gameplay level cap.`,
  };
  return { path, code, message: messages[code] ?? 'The requested progression state violates an authoritative rule.' };
}

function progressionRuleError(issues: readonly ValidationIssue[]): AppError {
  return new AppError(422, 'INVALID_ACTOR_PROGRESSION', 'The actor progression operation could not be completed', {
    retryable: false,
    recoveryAction: 'correct_request',
    auditCode: 'ACTOR_PROGRESSION_RULE_REJECTED',
    issues: issues.slice(0, 20).map(publicProgressionIssue),
  });
}

function insufficientAttributePoints(): AppError {
  return new AppError(422, 'INSUFFICIENT_ATTRIBUTE_POINTS', 'The actor does not have enough available attribute points', {
    retryable: false,
    recoveryAction: 'get_actor_progression',
    auditCode: 'ACTOR_ATTRIBUTE_POINTS_INSUFFICIENT',
    issues: [{
      path: 'attributeDeltas',
      code: 'ATTRIBUTE_POINTS_EXCEEDED',
      message: 'Get actor progression and allocate no more than attributePointsAvailable.',
    }],
  });
}

function insufficientXp(): AppError {
  return new AppError(422, 'INSUFFICIENT_XP', 'The actor does not have enough XP to level up', {
    retryable: false,
    recoveryAction: 'get_actor_progression',
    auditCode: 'ACTOR_LEVEL_UP_XP_INSUFFICIENT',
    issues: [{
      path: 'operation',
      code: 'XP_REQUIRED',
      message: 'Get actor progression and grant or earn enough XP before trying level_up again.',
    }],
  });
}

function levelCapReached(): AppError {
  return new AppError(422, 'LEVEL_CAP_REACHED', 'The actor is already at the ruleset level cap', {
    retryable: false,
    recoveryAction: 'get_actor_progression',
    auditCode: 'ACTOR_LEVEL_CAP_REACHED',
  });
}

function safeXpAdd(current: number, amount: number): number {
  const total = current + amount;
  if (!Number.isSafeInteger(total) || total > CORE_V1_2_XP_STORAGE_MAXIMUM) {
    throw new AppError(422, 'XP_RANGE_EXCEEDED', 'XP total exceeds the technical Actor.xp storage range', {
      retryable: false,
      recoveryAction: 'correct_request',
      auditCode: 'ACTOR_XP_RANGE_EXCEEDED',
    });
  }
  return total;
}

function technicalLevelRangeReached(): AppError {
  return new AppError(422, 'LEVEL_TECHNICAL_RANGE_EXCEEDED', 'Actor level exceeds the technical storage and calculation range', {
    retryable: false,
    recoveryAction: 'correct_request',
    auditCode: 'ACTOR_LEVEL_TECHNICAL_RANGE_EXCEEDED',
    issues: [{
      path: 'level',
      code: 'TECHNICAL_INTEGER_RANGE',
      message: 'This is a storage safety boundary, not a gameplay maximum level.',
    }],
  });
}

function xpSourceAlreadyGranted(): AppError {
  return new AppError(409, 'XP_SOURCE_ALREADY_GRANTED', 'This XP source was already granted to the actor', {
    retryable: false,
    recoveryAction: 'get_actor_progression',
    auditCode: 'ACTOR_XP_SOURCE_DUPLICATE',
    issues: [{
      path: 'source',
      code: 'DUPLICATE_REWARD_SOURCE',
      message: 'Use a different source only for a genuinely different reward fact.',
    }],
  });
}

export function mapActorProgressionUniqueConflict(error: unknown): AppError | undefined {
  return isExpectedUniqueConflict(error, {
    modelName: 'GameEvent',
    fields: ['actorId', 'xpSourceType', 'xpSourceRef'],
    index: 'GameEvent_actorId_xpSourceType_xpSourceRef_key',
  })
    ? xpSourceAlreadyGranted()
    : undefined;
}

async function findProgressionRecord(
  client: DbClient,
  campaignId: string,
  actorRef: string,
): Promise<ActorProgressionRecord> {
  const actor = await client.actor.findUnique({
    where: { campaignId_code: { campaignId, code: actorRef } },
    select: {
      id: true,
      campaignId: true,
      code: true,
      level: true,
      xp: true,
      mechanicsStateVersion: true,
       campaign: {
         select: {
           rulesetVersion: {
             select: {
               id: true,
               rulesetId: true,
               code: true,
               revision: true,
               schemaVersion: true,
               configHash: true,
               configSnapshot: true,
               ruleset: { select: { code: true } },
             },
           },
         },
       },
      attributes: {
        select: { code: true, baseValue: true, earnedValue: true },
        orderBy: { code: 'asc' },
      },
    },
  });
  if (actor === null) throw new NotFoundError('Actor');
  return actor;
}

function progressionDto(actor: ActorProgressionRecord): ActorProgressionDto {
  const rulesetVersion = validateSupportedCoreRulesetVersion(actor.campaign.rulesetVersion);
  const policy = actorProgressionPolicy(rulesetVersion.code);
  const attributes = projectStoredAttributeState(actor.attributes, actor.level, policy);
  const required = policy === 'unbounded_core_v1_2'
    ? nextCoreV12LevelXp(actor.level)
    : legacyNextLevelXp(actor.level);
  return {
    actorRef: actor.code,
    level: actor.level,
    xpCurrent: actor.xp,
    xpRequiredForNextLevel: required,
    ...attributes,
    mechanicsStateVersion: actor.mechanicsStateVersion,
    canLevelUp: required !== null && actor.xp >= required,
  };
}

export async function loadActorProgression(
  client: DbClient,
  campaignId: string,
  actorRef: string,
): Promise<ActorProgressionDto> {
  return progressionDto(await findProgressionRecord(client, campaignId, actorRef));
}

function resourceState(sheet: Awaited<ReturnType<typeof loadActorMechanicalSheet>>): ResourceState {
  return {
    hp: { current: sheet.resources.hp.current, max: sheet.resources.hp.max },
    mana: { current: sheet.resources.mana.current, max: sheet.resources.mana.max },
    sp: { current: sheet.resources.sp.current, max: sheet.resources.sp.max },
  };
}

function resourceChanges(before: ResourceState, after: ResourceState) {
  return (['hp', 'mana', 'sp'] as const).flatMap((resource) => {
    const previous = before[resource];
    const current = after[resource];
    return previous.current === current.current && previous.max === current.max
      ? []
      : [{ resource, before: previous, after: current }];
  });
}

function progressionValuesWithDeltas(
  before: ActorProgressionDto,
  deltas: NonNullable<ManageActorProgressionInput['attributeDeltas']>,
): PrimaryAttributes {
  const progression = { ...before.progressionPrimaryAttributes };
  let requested = 0;
  for (const code of CORE_V1_PRIMARY_ATTRIBUTES) {
    const delta = deltas[code] ?? 0;
    requested += delta;
    progression[code] += delta;
  }
  if (requested > before.attributePointsAvailable) throw insufficientAttributePoints();
  return progression;
}

async function writeAttributeState(
  transaction: Prisma.TransactionClient,
  actorId: string,
  base: PrimaryAttributes,
  progression: PrimaryAttributes,
): Promise<void> {
  for (const code of CORE_V1_PRIMARY_ATTRIBUTES) {
    await transaction.actorAttribute.update({
      where: { actorId_code: { actorId, code: attributeCodeToDatabase[code] } },
      data: { baseValue: base[code], earnedValue: progression[code] },
    });
  }
}

function eventTitle(operation: ManageActorProgressionInput['operation']): string {
  const titles: Readonly<Record<ManageActorProgressionInput['operation'], string>> = {
    get: 'Progressão consultada',
    grant_xp: 'XP concedido',
    level_up: 'Nível aumentado',
    allocate_attributes: 'Atributos distribuídos',
    set_progression_state: 'Ficha mecânica corrigida',
  };
  return titles[operation];
}

export async function manageActorProgressionTransaction(
  transaction: Prisma.TransactionClient,
  campaignId: string,
  input: Exclude<ManageActorProgressionInput, { operation: 'get' }>,
) {
  if (input.idempotencyKey === undefined || input.expectedMechanicsStateVersion === undefined) {
    throw progressionRuleError([]);
  }
  const idempotencyKey = input.idempotencyKey;
  const initial = await findProgressionRecord(transaction, campaignId, input.actorRef);
  await assertActorsMutableOutsideEncounter(transaction, campaignId, [initial]);
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "Actor" WHERE "id" = ${initial.id}::uuid FOR UPDATE`);
  const actor = await findProgressionRecord(transaction, campaignId, input.actorRef);
  if (input.operation !== 'grant_xp'
    && actor.mechanicsStateVersion !== input.expectedMechanicsStateVersion) throw progressionStateVersionConflict();

  const before = progressionDto(actor);
  const policy = actorProgressionPolicy(actor.campaign.rulesetVersion.code);
  const beforeResources = resourceState(await loadActorMechanicalSheet(transaction, actor.id));
  let nextLevel = actor.level;
  let nextXp = actor.xp;
  let nextBase = { ...before.basePrimaryAttributes };
  let nextProgression = { ...before.progressionPrimaryAttributes };

  if (input.operation === 'grant_xp') {
    if (input.xpAmount === undefined || input.source === undefined) throw progressionRuleError([]);
    const semanticIdentity = `${actor.id}:${input.source.type}:${input.source.ref}`;
    await transaction.$queryRaw(Prisma.sql`
      SELECT 1::integer AS "locked"
      FROM pg_advisory_xact_lock(hashtextextended(${semanticIdentity}, 0))
    `);
    const existingGrant = await transaction.gameEvent.findFirst({
      where: {
        actorId: actor.id,
        xpSourceType: input.source.type,
        xpSourceRef: input.source.ref,
      },
      select: { id: true },
    });
    if (existingGrant !== null) throw xpSourceAlreadyGranted();
    if (actor.mechanicsStateVersion !== input.expectedMechanicsStateVersion) throw progressionStateVersionConflict();
    nextXp = safeXpAdd(actor.xp, input.xpAmount);
  } else if (input.operation === 'level_up') {
    const required = policy === 'unbounded_core_v1_2'
      ? nextCoreV12LevelXp(actor.level)
      : legacyNextLevelXp(actor.level);
    if (required === null) {
      if (actor.campaign.rulesetVersion.code === CORE_V1_2_VERSION_CODE) throw technicalLevelRangeReached();
      throw levelCapReached();
    }
    if (actor.xp < required) throw insufficientXp();
    nextLevel = actor.level + 1;
    nextXp = actor.xp - required;
  } else if (input.operation === 'allocate_attributes') {
    if (input.attributeDeltas === undefined) throw progressionRuleError([]);
    nextProgression = progressionValuesWithDeltas(before, input.attributeDeltas);
  } else {
    nextLevel = input.level ?? actor.level;
    nextXp = input.xp ?? actor.xp;
    nextBase = input.basePrimaryAttributes ?? nextBase;
    nextProgression = input.progressionPrimaryAttributes ?? nextProgression;
  }

  const validation = validateActorProgressionAttributes(nextBase, nextProgression, nextLevel, policy);
  if (!validation.ok) throw progressionRuleError(validation.issues);
  const changed = nextLevel !== actor.level
    || nextXp !== actor.xp
    || CORE_V1_PRIMARY_ATTRIBUTES.some((code) => (
      nextBase[code] !== before.basePrimaryAttributes[code]
      || nextProgression[code] !== before.progressionPrimaryAttributes[code]
    ));

  if (changed) {
    if (CORE_V1_PRIMARY_ATTRIBUTES.some((code) => (
      nextBase[code] !== before.basePrimaryAttributes[code]
      || nextProgression[code] !== before.progressionPrimaryAttributes[code]
    ))) {
      await writeAttributeState(transaction, actor.id, nextBase, nextProgression);
    }
    await transaction.actor.update({
      where: { id: actor.id },
      data: { level: nextLevel, xp: nextXp, mechanicsStateVersion: { increment: 1 } },
    });
    await recomputeActorDerivedSnapshot(transaction, actor.id);
  }

  const after = await loadActorProgression(transaction, campaignId, input.actorRef);
  const afterResources = resourceState(await loadActorMechanicalSheet(transaction, actor.id));
  const confirmedResourceChanges = resourceChanges(beforeResources, afterResources);
  const reason = input.reason ?? (
    input.operation === 'level_up' ? 'Level-up requested by the player' : 'Attribute allocation requested by the player'
  );
  await transaction.gameEvent.create({
    data: {
      campaignId,
      actorId: actor.id,
      eventType: `actor-progression-${input.operation.replaceAll('_', '-')}`,
      title: eventTitle(input.operation),
      idempotencyKey,
      ...(input.operation === 'grant_xp' && input.source !== undefined
        ? { xpSourceType: input.source.type, xpSourceRef: input.source.ref }
        : {}),
      payload: {
        schemaVersion: 1,
        operation: input.operation,
        reason,
        changed,
        before,
        after,
        resourceChanges: confirmedResourceChanges,
      } as Prisma.InputJsonValue,
    },
  });
  return { operation: input.operation, changed, ...after, resourceChanges: confirmedResourceChanges };
}
