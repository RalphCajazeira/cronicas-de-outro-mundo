import { createHash } from 'node:crypto';
import {
  ContentEffectBindingKind,
  ContentProfileMode,
  ContentStatus,
  ContentType,
  Prisma,
} from '../../generated/prisma/client.js';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { canonicalJson, canonicalizeJson, type CanonicalJsonValue } from '../../shared/json/canonical-json.js';
import { ensureCoreV1ContentProfileVersion, type ContentProfileRegistryClient, type CoreContentProfileVersion } from '../rules/content-profile.registry.js';
import {
  validateCoreV1InventorySpec,
  validateCoreV1InventoryState,
  validateCoreV1ContentProfile,
  type CoreV1ContentProfile,
  type CoreV1InventorySpec,
  type CoreV1ContentValidationResult,
} from '../rules/core-v1/index.js';
import { ensureCoreV1InventoryRulesVersion, type InventoryRulesRegistryClient, type CoreInventoryRulesVersion } from '../rules/inventory-rules.registry.js';
import { ensureCoreV1EffectRulesVersion, type EffectRulesRegistryClient, type CoreEffectRulesVersion } from '../rules/effect-rules.registry.js';
import { ensureCoreV1RulesetVersion, type CoreRulesetVersion } from '../rules/ruleset.registry.js';

export const CANONICAL_CONTENT_TYPES = Object.freeze([
  'weapon', 'armor', 'shield', 'clothing', 'spell', 'skill', 'talent', 'item',
  'consumable', 'status_effect', 'race', 'class', 'creature_template',
] as const);

export const GENERIC_CONTENT_TYPES = Object.freeze([
  'material', 'location', 'faction', 'quest_template', 'recipe', 'other',
] as const);

const canonicalTypeSet = new Set<string>(CANONICAL_CONTENT_TYPES);
const genericTypeSet = new Set<string>(GENERIC_CONTENT_TYPES);
const inventoryRequiredTypeSet = new Set(['weapon', 'armor', 'shield', 'clothing', 'consumable', 'material']);
const inventoryOptionalTypeSet = new Set(['item', 'other']);

export interface ContentPublicationInput {
  worldId: string;
  campaignId: string | null;
  contentType: ContentType;
  code: string;
  name: string;
  description: string | null;
  profile?: unknown;
  inventorySpec?: unknown;
  presentation: Record<string, unknown>;
  tags: readonly string[];
  status: ContentStatus;
  metadata: Record<string, unknown>;
}

export interface ContentHashInput {
  schemaVersion: number;
  contentType: string;
  code: string;
  name: string;
  description: string | null;
  profile: CoreV1ContentProfile | null;
  presentation: Record<string, unknown>;
  tags: readonly string[];
  metadata: Record<string, unknown>;
  ruleset: { code: string; revision: string };
  contentProfileVersion: { code: string; schemaVersion: number; configHash: string };
}

export interface ContentEffectBindingHashEntry {
  effectIndex: number;
  bindingKind: 'apply_status' | 'remove_status';
  target: {
    scope: 'world' | 'campaign';
    contentType: 'status_effect';
    code: string;
    versionNumber: number;
  };
}

interface ResolvedContentEffectBinding extends ContentEffectBindingHashEntry {
  targetContentDefinitionId: string;
  targetContentVersionId: string;
}

export function buildContentHashSnapshot(input: ContentHashInput): CanonicalJsonValue {
  return canonicalizeJson({
    schemaVersion: input.schemaVersion,
    contentType: input.contentType,
    code: input.code,
    name: input.name,
    description: input.description,
    profile: input.profile,
    presentation: input.presentation,
    tags: input.tags,
    metadata: input.metadata,
    ruleset: input.ruleset,
    contentProfileVersion: input.contentProfileVersion,
  });
}

export function calculateContentHash(input: ContentHashInput): string {
  return createHash('sha256').update(canonicalJson(buildContentHashSnapshot(input))).digest('hex');
}

export function calculateInventorySpecHash(spec: CoreV1InventorySpec): string {
  return createHash('sha256').update(canonicalJson(spec)).digest('hex');
}

export function calculateEffectBindingHash(bindings: readonly ContentEffectBindingHashEntry[]): string {
  const ordered = [...bindings].sort((left, right) => left.effectIndex - right.effectIndex
    || left.bindingKind.localeCompare(right.bindingKind)
    || left.target.scope.localeCompare(right.target.scope)
    || left.target.code.localeCompare(right.target.code)
    || left.target.versionNumber - right.target.versionNumber);
  return createHash('sha256').update(canonicalJson(ordered)).digest('hex');
}

export class ContentEffectBindingResolutionError extends AppError {
  constructor(public readonly statusRef: string) {
    super(409, 'CONTENT_EFFECT_BINDING_UNRESOLVED', 'Referenced status effect has no compatible published version');
    this.name = 'ContentEffectBindingResolutionError';
  }
}

export class InvalidPersistedContentProfileError extends Error {
  readonly code = 'INVALID_CORE_V1_CONTENT_PROFILE';
  readonly retryable = true;

  constructor(public readonly issues: Extract<CoreV1ContentValidationResult, { ok: false }>['issues']) {
    super('Content profile is invalid');
    this.name = 'InvalidPersistedContentProfileError';
  }
}

export class InvalidPersistedInventorySpecError extends Error {
  readonly code = 'INVALID_CORE_V1_INVENTORY_SPEC';
  readonly retryable = true;

  constructor(public readonly issues: readonly { path: string; rule: string; message: string }[]) {
    super('Inventory spec is invalid');
    this.name = 'InvalidPersistedInventorySpecError';
  }
}

export const contentVersionPublicInclude = {
  rulesetVersion: { select: { code: true, revision: true } },
  contentProfileVersion: { select: { code: true, schemaVersion: true } },
  sourceEffectBindings: {
    include: { targetContentDefinition: true, targetContentVersion: true },
    orderBy: [{ effectIndex: 'asc' as const }, { bindingKind: 'asc' as const }],
  },
} satisfies Prisma.ContentVersionInclude;

export const publishedContentInclude = {
  versions: {
    orderBy: { versionNumber: 'desc' as const },
    take: 1,
    include: contentVersionPublicInclude,
  },
} satisfies Prisma.ContentDefinitionInclude;

export type PublishedContent = Prisma.ContentDefinitionGetPayload<{ include: typeof publishedContentInclude }>;
export type PublicContentVersion = Prisma.ContentVersionGetPayload<{ include: typeof contentVersionPublicInclude }>;
export type ContentPublicationClient = ContentProfileRegistryClient & InventoryRulesRegistryClient & EffectRulesRegistryClient & Pick<
  Prisma.TransactionClient,
  'world' | 'campaign' | 'contentDefinition' | 'contentVersion' | '$queryRaw'
>;

export interface ContentPublicationRegistryContext {
  readonly ruleset: CoreRulesetVersion;
  readonly contentProfile: CoreContentProfileVersion;
  readonly inventoryRules: CoreInventoryRulesVersion;
  readonly effectRules: CoreEffectRulesVersion;
}

export async function resolveContentPublicationRegistryContext(
  client: ContentPublicationClient,
): Promise<ContentPublicationRegistryContext> {
  const ruleset = await ensureCoreV1RulesetVersion(client);
  const contentProfile = await ensureCoreV1ContentProfileVersion(client, ruleset);
  const inventoryRules = await ensureCoreV1InventoryRulesVersion(client, ruleset);
  const effectRules = await ensureCoreV1EffectRulesVersion(client, ruleset);
  return { ruleset, contentProfile, inventoryRules, effectRules };
}

function statusEffects(profile: CoreV1ContentProfile | null) {
  if (profile?.profileMode !== 'mechanical') return [];
  const rootOffset = (profile.damageComponents?.length ?? 0) > 0 && profile.targeting !== undefined ? 1 : 0;
  return (profile.effects ?? []).flatMap((effect, index) => {
    if (effect.type !== 'apply_status' && effect.type !== 'remove_status') return [];
    return [{
      effectIndex: rootOffset + index,
      bindingKind: effect.type,
      statusRef: effect.statusRef,
    }];
  });
}

async function resolveEffectBindings(
  client: ContentPublicationClient,
  input: ContentPublicationInput,
  profile: CoreV1ContentProfile | null,
  rulesetVersionId: string,
): Promise<readonly ResolvedContentEffectBinding[]> {
  const resolved: ResolvedContentEffectBinding[] = [];
  for (const effect of statusEffects(profile)) {
    let definition = input.campaignId === null ? null : await client.contentDefinition.findFirst({
      where: {
        worldId: input.worldId,
        campaignId: input.campaignId,
        contentType: ContentType.STATUS_EFFECT,
        code: effect.statusRef,
        status: ContentStatus.ACTIVE,
      },
      include: publishedContentInclude,
    });
    definition ??= await client.contentDefinition.findFirst({
      where: {
        worldId: input.worldId,
        campaignId: null,
        contentType: ContentType.STATUS_EFFECT,
        code: effect.statusRef,
        status: ContentStatus.ACTIVE,
      },
      include: publishedContentInclude,
    });
    const version = definition?.versions[0];
    if (definition === null || version === undefined || version.rulesetVersionId !== rulesetVersionId
      || version.profileMode !== ContentProfileMode.MECHANICAL) {
      throw new ContentEffectBindingResolutionError(effect.statusRef);
    }
    resolved.push({
      effectIndex: effect.effectIndex,
      bindingKind: effect.bindingKind,
      target: {
        scope: definition.campaignId === null ? 'world' : 'campaign',
        contentType: 'status_effect',
        code: definition.code,
        versionNumber: version.versionNumber,
      },
      targetContentDefinitionId: definition.id,
      targetContentVersionId: version.id,
    });
  }
  return resolved;
}

function effectBindingCreates(bindings: readonly ResolvedContentEffectBinding[]) {
  return bindings.map((binding) => ({
    effectIndex: binding.effectIndex,
    bindingKind: binding.bindingKind === 'apply_status'
      ? ContentEffectBindingKind.APPLY_STATUS
      : ContentEffectBindingKind.REMOVE_STATUS,
    targetContentDefinitionId: binding.targetContentDefinitionId,
    targetContentVersionId: binding.targetContentVersionId,
  }));
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function validateInventorySpec(
  input: ContentPublicationInput,
  profile: CoreV1ContentProfile | null,
): CoreV1InventorySpec | null {
  const contentType = normalizeEnum(input.contentType);
  const required = inventoryRequiredTypeSet.has(contentType);
  const allowed = required || inventoryOptionalTypeSet.has(contentType);
  if (input.inventorySpec === undefined || input.inventorySpec === null) {
    if (required) throw new ConflictError('Physical content requires an inventory spec');
    return null;
  }
  if (!allowed) throw new ConflictError('This content type cannot contain an inventory spec');
  const validation = validateCoreV1InventorySpec(input.inventorySpec);
  if (!validation.ok) throw new InvalidPersistedInventorySpecError(validation.issues);
  const spec = validation.value;
  const mechanicalEquipment = profile?.profileMode === 'mechanical'
    && ['weapon', 'armor', 'shield', 'clothing'].includes(contentType);
  if (mechanicalEquipment && (spec.stacking.mode !== 'unique'
    || spec.equipmentSlots === undefined || spec.equipmentSlots.length === 0)) {
    throw new ConflictError('Mechanical equipment requires unique stacking and explicit physical slots');
  }
  if (mechanicalEquipment && contentType === 'weapon' && spec.handedness === undefined) {
    throw new ConflictError('Mechanical weapons require explicit physical handedness');
  }
  const entry = spec.stacking.mode === 'unique'
    ? {
      entryKind: 'instance' as const, entryRef: 'publication-validation',
      contentVersion: { scope: input.campaignId === null ? 'world' as const : 'campaign' as const, contentType, code: input.code, versionNumber: 1 },
      inventorySpec: spec, profile, state: 'available' as const,
    }
    : {
      entryKind: 'stack' as const, entryRef: 'publication-validation',
      contentVersion: { scope: input.campaignId === null ? 'world' as const : 'campaign' as const, contentType, code: input.code, versionNumber: 1 },
      inventorySpec: spec, profile, quantity: 1,
    };
  const compatibility = validateCoreV1InventoryState({ entries: [entry] });
  if (!compatibility.ok) throw new InvalidPersistedInventorySpecError(compatibility.issues);
  return spec;
}

function validateProfile(input: ContentPublicationInput): {
  profile: CoreV1ContentProfile | null;
  profileMode: ContentProfileMode;
  schemaVersion: number;
} {
  const contentType = normalizeEnum(input.contentType);
  if (genericTypeSet.has(contentType)) {
    if (input.profile !== undefined && input.profile !== null) throw new ConflictError('Generic content cannot contain a canonical profile');
    return { profile: null, profileMode: ContentProfileMode.GENERIC, schemaVersion: 1 };
  }
  if (!canonicalTypeSet.has(contentType)) throw new ConflictError('Content type is not supported');
  if (input.profile === undefined || input.profile === null) throw new ConflictError('Canonical content requires a profile');
  const validation = validateCoreV1ContentProfile(input.profile);
  if (!validation.ok) throw new InvalidPersistedContentProfileError(validation.issues);
  const profile = validation.value;
  if (profile.contentKind !== contentType
    || profile.code !== input.code
    || profile.name !== input.name
    || (profile.description !== undefined && profile.description !== input.description)
    || (profile.presentation !== undefined && canonicalJson(profile.presentation) !== canonicalJson(input.presentation))
    || (profile.tags !== undefined && canonicalJson(profile.tags) !== canonicalJson(input.tags))) {
    throw new ConflictError('Content profile identity does not match the publication');
  }
  return {
    profile,
    profileMode: profile.profileMode === 'mechanical' ? ContentProfileMode.MECHANICAL : ContentProfileMode.NARRATIVE,
    schemaVersion: profile.schemaVersion,
  };
}

async function lockIdentity(client: ContentPublicationClient, input: ContentPublicationInput): Promise<void> {
  const identity = [input.worldId, input.campaignId ?? 'world', normalizeEnum(input.contentType), input.code].join(':');
  await client.$queryRaw(Prisma.sql`
    SELECT 1::integer AS "locked"
    FROM pg_advisory_xact_lock(hashtextextended(${identity}, 0))
  `);
}

function currentVersion(content: PublishedContent) {
  const version = content.versions[0];
  if (version === undefined) throw new ConflictError('Content definition has no published version');
  return version;
}

export async function publishContentVersion(
  client: ContentPublicationClient,
  input: ContentPublicationInput,
  resolvedRegistry?: ContentPublicationRegistryContext,
): Promise<PublishedContent> {
  const registry = resolvedRegistry ?? await resolveContentPublicationRegistryContext(client);
  const officialRuleset = registry.ruleset;
  const contentProfileVersion = registry.contentProfile;
  const inventoryRulesVersion = registry.inventoryRules;
  const effectRulesVersion = registry.effectRules;
  const world = await client.world.findUnique({
    where: { id: input.worldId },
    select: { id: true, defaultRulesetVersionId: true },
  });
  if (world === null) throw new NotFoundError('World');
  let rulesetVersionId = world.defaultRulesetVersionId;
  if (input.campaignId !== null) {
    const campaign = await client.campaign.findUnique({
      where: { id: input.campaignId },
      select: { worldId: true, rulesetVersionId: true },
    });
    if (campaign === null || campaign.worldId !== world.id) throw new NotFoundError('Campaign');
    rulesetVersionId = campaign.rulesetVersionId;
  }
  if (rulesetVersionId !== officialRuleset.id || contentProfileVersion.rulesetVersionId !== rulesetVersionId
    || inventoryRulesVersion.rulesetVersionId !== rulesetVersionId
    || effectRulesVersion.rulesetVersionId !== rulesetVersionId) {
    throw new ConflictError('Content ruleset is not compatible with the publication scope');
  }

  const validated = validateProfile(input);
  const inventorySpec = validateInventorySpec(input, validated.profile);
  const inventorySpecHash = inventorySpec === null
    ? null
    : calculateInventorySpecHash(inventorySpec);
  const effectBindings = await resolveEffectBindings(client, input, validated.profile, rulesetVersionId);
  const effectBindingHash = calculateEffectBindingHash(effectBindings);
  const hashInput: ContentHashInput = {
    schemaVersion: validated.schemaVersion,
    contentType: normalizeEnum(input.contentType),
    code: input.code,
    name: input.name,
    description: input.description,
    profile: validated.profile,
    presentation: input.presentation,
    tags: input.tags,
    metadata: input.metadata,
    ruleset: { code: officialRuleset.code, revision: officialRuleset.revision },
    contentProfileVersion: {
      code: contentProfileVersion.code,
      schemaVersion: contentProfileVersion.schemaVersion,
      configHash: contentProfileVersion.configHash,
    },
  };
  const contentHash = calculateContentHash(hashInput);

  await lockIdentity(client, input);
  let definition = await client.contentDefinition.findFirst({
    where: {
      worldId: input.worldId,
      campaignId: input.campaignId,
      contentType: input.contentType,
      code: input.code,
    },
    include: publishedContentInclude,
  });
  if (definition === null) {
    const createdDefinition = await client.contentDefinition.create({
      data: {
        worldId: input.worldId,
        campaignId: input.campaignId,
        contentType: input.contentType,
        code: input.code,
        status: input.status,
      },
      select: { id: true },
    });
    await client.contentVersion.create({
      data: {
        contentDefinitionId: createdDefinition.id,
        rulesetVersionId,
        contentProfileVersionId: contentProfileVersion.id,
        inventoryRulesVersionId: inventorySpec === null ? null : inventoryRulesVersion.id,
        versionNumber: 1,
        schemaVersion: validated.schemaVersion,
        profileMode: validated.profileMode,
        name: input.name,
        description: input.description,
        profile: validated.profile === null ? Prisma.DbNull : inputJson(validated.profile),
        presentation: inputJson(input.presentation),
        tags: inputJson(input.tags),
        metadata: inputJson(input.metadata),
        contentHash,
        inventorySpec: inventorySpec === null ? Prisma.DbNull : inputJson(inventorySpec),
        inventorySpecHash,
        effectBindingHash,
        sourceEffectBindings: { create: effectBindingCreates(effectBindings) },
      },
    });
    return client.contentDefinition.findUniqueOrThrow({
      where: { id: createdDefinition.id },
      include: publishedContentInclude,
    });
  }

  await client.$queryRaw(Prisma.sql`SELECT "id" FROM "ContentDefinition" WHERE "id" = ${definition.id}::uuid FOR UPDATE`);
  definition = await client.contentDefinition.findUniqueOrThrow({
    where: { id: definition.id },
    include: publishedContentInclude,
  });
  const latest = currentVersion(definition);
  if (latest.contentHash === contentHash && latest.inventorySpecHash === inventorySpecHash
    && latest.effectBindingHash === effectBindingHash) {
    if (definition.status !== input.status) {
      definition = await client.contentDefinition.update({
        where: { id: definition.id },
        data: { status: input.status },
        include: publishedContentInclude,
      });
    }
    return definition;
  }
  const historical = await client.contentVersion.findFirst({
    where: { contentDefinitionId: definition.id, contentHash, inventorySpecHash, effectBindingHash },
    select: { id: true },
  });
  if (historical !== null) throw new ConflictError('A historical content snapshot cannot be republished as a new version');

  await client.contentVersion.create({
    data: {
      contentDefinitionId: definition.id,
      rulesetVersionId,
      contentProfileVersionId: contentProfileVersion.id,
      inventoryRulesVersionId: inventorySpec === null ? null : inventoryRulesVersion.id,
      versionNumber: latest.versionNumber + 1,
      schemaVersion: validated.schemaVersion,
      profileMode: validated.profileMode,
      name: input.name,
      description: input.description,
      profile: validated.profile === null ? Prisma.DbNull : inputJson(validated.profile),
      presentation: inputJson(input.presentation),
      tags: inputJson(input.tags),
      metadata: inputJson(input.metadata),
      contentHash,
      inventorySpec: inventorySpec === null ? Prisma.DbNull : inputJson(inventorySpec),
      inventorySpecHash,
      effectBindingHash,
      sourceEffectBindings: { create: effectBindingCreates(effectBindings) },
    },
  });
  return client.contentDefinition.update({
    where: { id: definition.id },
    data: { status: input.status },
    include: publishedContentInclude,
  });
}

export function publicContentDto(content: PublishedContent) {
  const version = currentVersion(content);
  return publicContentVersionDto(content, version);
}

export function publicContentVersionDto(
  content: Pick<PublishedContent, 'code' | 'contentType' | 'status'>,
  version: Omit<PublicContentVersion, 'sourceEffectBindings'> & { sourceEffectBindings?: PublicContentVersion['sourceEffectBindings'] },
) {
  return {
    code: content.code,
    name: version.name,
    contentType: normalizeEnum(content.contentType),
    description: version.description,
    profile: version.profile,
    presentation: version.presentation,
    tags: version.tags,
    status: normalizeEnum(content.status),
    metadata: version.metadata,
    versionNumber: version.versionNumber,
    ruleset: version.rulesetVersion,
    contentProfile: version.contentProfileVersion,
    inventorySpec: version.inventorySpec,
  };
}
