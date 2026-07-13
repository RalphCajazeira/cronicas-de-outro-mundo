import { createHash } from 'node:crypto';
import {
  ContentProfileMode,
  type ContentStatus,
  type ContentType,
  Prisma,
} from '../../generated/prisma/client.js';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { normalizeEnum } from '../../shared/http/normalize-enum.js';
import { canonicalJson, canonicalizeJson, type CanonicalJsonValue } from '../../shared/json/canonical-json.js';
import { ensureCoreV1ContentProfileVersion, type ContentProfileRegistryClient } from '../rules/content-profile.registry.js';
import {
  validateCoreV1ContentProfile,
  type CoreV1ContentProfile,
  type CoreV1ContentValidationResult,
} from '../rules/core-v1/index.js';
import { ensureCoreV1RulesetVersion } from '../rules/ruleset.registry.js';

export const CANONICAL_CONTENT_TYPES = Object.freeze([
  'weapon', 'armor', 'shield', 'clothing', 'spell', 'skill', 'talent', 'item',
  'consumable', 'status_effect', 'race', 'class', 'creature_template',
] as const);

export const GENERIC_CONTENT_TYPES = Object.freeze([
  'material', 'location', 'faction', 'quest_template', 'recipe', 'other',
] as const);

const canonicalTypeSet = new Set<string>(CANONICAL_CONTENT_TYPES);
const genericTypeSet = new Set<string>(GENERIC_CONTENT_TYPES);

export interface ContentPublicationInput {
  worldId: string;
  campaignId: string | null;
  contentType: ContentType;
  code: string;
  name: string;
  description: string | null;
  profile?: unknown;
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

export class InvalidPersistedContentProfileError extends Error {
  readonly code = 'INVALID_CORE_V1_CONTENT_PROFILE';
  readonly retryable = true;

  constructor(public readonly issues: Extract<CoreV1ContentValidationResult, { ok: false }>['issues']) {
    super('Content profile is invalid');
    this.name = 'InvalidPersistedContentProfileError';
  }
}

export const contentVersionPublicInclude = {
  rulesetVersion: { select: { code: true, revision: true } },
  contentProfileVersion: { select: { code: true, schemaVersion: true } },
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
export type ContentPublicationClient = ContentProfileRegistryClient & Pick<
  Prisma.TransactionClient,
  'world' | 'campaign' | 'contentDefinition' | 'contentVersion' | '$queryRaw'
>;

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
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
): Promise<PublishedContent> {
  const officialRuleset = await ensureCoreV1RulesetVersion(client);
  const contentProfileVersion = await ensureCoreV1ContentProfileVersion(client);
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
  if (rulesetVersionId !== officialRuleset.id || contentProfileVersion.rulesetVersionId !== rulesetVersionId) {
    throw new ConflictError('Content ruleset is not compatible with the publication scope');
  }

  const validated = validateProfile(input);
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
    definition = await client.contentDefinition.create({
      data: {
        worldId: input.worldId,
        campaignId: input.campaignId,
        contentType: input.contentType,
        code: input.code,
        status: input.status,
        versions: {
          create: {
            rulesetVersionId,
            contentProfileVersionId: contentProfileVersion.id,
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
          },
        },
      },
      include: publishedContentInclude,
    });
    return definition;
  }

  await client.$queryRaw(Prisma.sql`SELECT "id" FROM "ContentDefinition" WHERE "id" = ${definition.id}::uuid FOR UPDATE`);
  definition = await client.contentDefinition.findUniqueOrThrow({
    where: { id: definition.id },
    include: publishedContentInclude,
  });
  const latest = currentVersion(definition);
  if (latest.contentHash === contentHash) {
    if (definition.status !== input.status) {
      definition = await client.contentDefinition.update({
        where: { id: definition.id },
        data: { status: input.status },
        include: publishedContentInclude,
      });
    }
    return definition;
  }
  const historical = await client.contentVersion.findUnique({
    where: { contentDefinitionId_contentHash: { contentDefinitionId: definition.id, contentHash } },
    select: { id: true },
  });
  if (historical !== null) throw new ConflictError('A historical content snapshot cannot be republished as a new version');

  await client.contentVersion.create({
    data: {
      contentDefinitionId: definition.id,
      rulesetVersionId,
      contentProfileVersionId: contentProfileVersion.id,
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
  version: PublicContentVersion,
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
  };
}
