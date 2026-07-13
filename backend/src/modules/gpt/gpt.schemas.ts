import { z } from 'zod';
import { codeSchema } from '../actors/actors.schemas.js';
import { contentTypeSchema } from '../content/content.schemas.js';
import {
  METADATA_MAX_BYTES, METADATA_TOTAL_MAX_BYTES, PROFILE_MAX_BYTES, START_GAME_MAX_BYTES,
  difficultyPresets, hasDangerousJsonKey, jsonByteSize, jsonDepth, jsonKeyCount,
} from './gpt.start-game.js';

const idempotencyKeySchema = z.string().trim().min(8).max(200);
const jsonObjectSchema = z.record(z.string(), z.json());
const safeMetadataObjectSchema = z.unknown().superRefine((value, context) => {
  if (hasDangerousJsonKey(value)) context.addIssue({ code: 'custom', message: 'Contains a reserved object key' });
}).pipe(jsonObjectSchema);
const scopeFields = { playerRef: codeSchema, worldRef: codeSchema, campaignRef: codeSchema };
const shortText = z.string().trim().min(1).max(300);

function limitedJsonObject(maxRootKeys = 30) {
  return safeMetadataObjectSchema.superRefine((value, context) => {
    if (Object.keys(value).length > maxRootKeys) context.addIssue({ code: 'custom', message: `Must have at most ${maxRootKeys} top-level keys` });
    if (jsonKeyCount(value) > 30) context.addIssue({ code: 'custom', message: 'Must have at most 30 total keys' });
    if (jsonDepth(value) > 5) context.addIssue({ code: 'custom', message: 'Must have depth at most 5' });
    if (jsonByteSize(value) > METADATA_MAX_BYTES) context.addIssue({ code: 'custom', message: 'Must be at most 4096 serialized bytes' });
  });
}

function uniqueTextArray(maximum: number, itemMaximum = 200, minimum = 0) {
  return z.array(z.string().trim().min(1).max(itemMaximum)).min(minimum).max(maximum).superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) context.addIssue({ code: 'custom', path: [index], message: 'Exact duplicate values are not allowed' });
      seen.add(value);
    });
  });
}

function limitedProfile<T extends z.ZodType>(schema: T) {
  return schema.superRefine((value, context) => {
    if (jsonByteSize(value) > PROFILE_MAX_BYTES) context.addIssue({ code: 'custom', message: 'Must be at most 2048 serialized bytes' });
  });
}

export const actorTypeSchema = z.enum(['character', 'npc', 'creature', 'companion', 'spirit']);
export const actorStatusSchema = z.enum(['active', 'inactive', 'defeated', 'dead', 'archived']);
export const contentStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);
export const actorContentStateSchema = z.enum(['locked', 'learning', 'known', 'mastered']);

export const appearanceSchema = limitedProfile(z.strictObject({
  summary: shortText.optional(), apparentAge: shortText.optional(), build: shortText.optional(), height: shortText.optional(),
  hair: shortText.optional(), eyes: shortText.optional(), skin: shortText.optional(), clothing: shortText.optional(),
  distinctiveFeatures: uniqueTextArray(8, 300).optional(),
}));

export const personalitySchema = limitedProfile(z.strictObject({
  summary: shortText.optional(), traits: uniqueTextArray(8, 300).optional(), values: uniqueTextArray(8, 300).optional(),
  motivations: uniqueTextArray(8, 300).optional(), fears: uniqueTextArray(8, 300).optional(), habits: uniqueTextArray(8, 300).optional(),
}));

const originSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1_000),
});

const levelSchema = z.strictObject({
  grade: z.enum(['none', 'primitive', 'preindustrial', 'industrial', 'modern', 'advanced', 'posthuman', 'custom']),
  notes: z.string().trim().min(1).max(1_000).optional(),
});

const magicLevelSchema = z.strictObject({
  grade: z.enum(['none', 'latent', 'rare', 'common', 'high', 'ubiquitous', 'custom']),
  notes: z.string().trim().min(1).max(1_000).optional(),
});

export const worldConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  genres: uniqueTextArray(5, 100, 1),
  setting: z.string().trim().min(1).max(500),
  era: z.string().trim().min(1).max(200),
  technologyLevel: levelSchema,
  magicLevel: magicLevelSchema,
  worldTone: uniqueTextArray(5, 100, 1),
  peoples: uniqueTextArray(20, 100).optional(),
  creatures: uniqueTextArray(20, 100).optional(),
  threats: uniqueTextArray(20, 100).optional(),
  cosmology: z.string().trim().min(1).max(1_500).optional(),
  worldRules: uniqueTextArray(12, 500).optional(),
  customPremise: z.string().trim().min(1).max(2_000).optional(),
});

const difficultyDimensions = {
  errorTolerance: z.number().int().min(1).max(5),
  opponentCunning: z.number().int().min(1).max(5),
  resourceAvailability: z.number().int().min(1).max(5),
  lethality: z.number().int().min(1).max(5),
  failureSeverity: z.number().int().min(1).max(5),
  narrativeSafetyNet: z.number().int().min(1).max(5),
};

export const difficultySchema = z.strictObject({
  preset: z.enum(['story', 'easy', 'standard', 'hard', 'brutal', 'custom']),
  overrides: z.strictObject(difficultyDimensions).partial().optional(),
}).superRefine((value, context) => {
  if (value.preset === 'custom') {
    if (value.overrides === undefined) {
      context.addIssue({ code: 'custom', path: ['overrides'], message: 'Required for custom difficulty' });
      return;
    }
    for (const dimension of Object.keys(difficultyPresets.standard)) {
      if (value.overrides[dimension as keyof typeof value.overrides] === undefined) {
        context.addIssue({ code: 'custom', path: ['overrides', dimension], message: 'Required for custom difficulty' });
      }
    }
  }
});

const classModelSchema = z.strictObject({
  mode: z.enum(['none', 'identity', 'mechanical']),
  startingClass: z.enum(['required', 'optional', 'unassigned']),
  progressionBasis: uniqueTextArray(8, 100, 1),
  description: z.string().trim().min(1).max(1_000),
});

export const campaignConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  difficulty: difficultySchema,
  progressionPace: z.enum(['very_fast', 'fast', 'standard', 'slow', 'very_slow', 'custom']),
  narrativeTone: uniqueTextArray(5, 100, 1),
  focus: uniqueTextArray(8, 100, 1),
  playerFreedom: z.enum(['guided', 'open', 'sandbox', 'custom']),
  consequenceLevel: z.enum(['forgiving', 'moderate', 'serious', 'lasting', 'severe', 'custom']),
  classModel: classModelSchema,
  themes: uniqueTextArray(20, 100).optional(),
  excludedThemes: uniqueTextArray(20, 100).optional(),
  customRules: uniqueTextArray(12, 500).optional(),
});

export const loadGameSchema = z.strictObject(scopeFields);
export const listPlayerWorldsSchema = z.strictObject({ playerRef: codeSchema });
export const listWorldCampaignsSchema = z.strictObject({ playerRef: codeSchema, worldRef: codeSchema });
export const listCampaignActorsSchema = z.strictObject({ playerRef: codeSchema, worldRef: codeSchema, campaignRef: codeSchema });

const actorMechanicsFields = {
  role: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().trim().min(1).max(5_000).nullable().optional(),
  level: z.number().int().min(1).max(10_000).optional(),
  xp: z.number().int().min(0).optional(), gold: z.number().int().min(0).optional(),
  health: z.number().int().min(0).optional(), maxHealth: z.number().int().min(1).optional(),
  mana: z.number().int().min(0).optional(), maxMana: z.number().int().min(0).optional(),
  attributes: limitedJsonObject(20).optional(), resistances: limitedJsonObject(20).optional(), affinities: limitedJsonObject(20).optional(),
  appearance: appearanceSchema.optional(), personality: personalitySchema.optional(), metadata: limitedJsonObject().optional(),
  status: actorStatusSchema.optional(),
};

const initialProtagonistSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  actorType: z.literal('character'),
  species: z.string().trim().min(1).max(100).nullable().optional(),
  className: z.string().trim().min(1).max(100).nullable().optional(),
  ...actorMechanicsFields,
  description: z.string().trim().min(1).max(3_000).nullable().optional(),
  status: z.literal('active').optional(),
  origin: originSchema.optional(),
}).superRefine((value, context) => {
  if (value.health !== undefined && value.maxHealth !== undefined && value.health > value.maxHealth) {
    context.addIssue({ code: 'custom', path: ['health'], message: 'Must not exceed maxHealth' });
  }
  if (value.mana !== undefined && value.maxMana !== undefined && value.mana > value.maxMana) {
    context.addIssue({ code: 'custom', path: ['mana'], message: 'Must not exceed maxMana' });
  }
  if (value.metadata !== undefined && Object.hasOwn(value.metadata, 'origin')) {
    context.addIssue({ code: 'custom', path: ['metadata', 'origin'], message: 'Use protagonist.origin instead of metadata.origin' });
  }
});

const initialLinkSchema = z.strictObject({
  state: actorContentStateSchema,
  rank: z.number().int().min(0), progress: z.number().int().min(0), mastery: z.number().int().min(0),
  equipped: z.boolean(), quantity: z.number().int().min(1).max(999),
  notes: z.string().trim().max(2_000).nullable().optional(), metadata: limitedJsonObject().optional(),
});

const initialDefinitionSchema = z.strictObject({
  mode: z.enum(['create', 'reuse']),
  scope: z.enum(['world', 'campaign']),
  code: codeSchema,
  contentType: contentTypeSchema,
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(2_000).optional(),
  mechanics: jsonObjectSchema.optional(), requirements: jsonObjectSchema.optional(), presentation: jsonObjectSchema.optional(),
  tags: uniqueTextArray(12, 50).optional(), schemaVersion: z.number().int().min(1).max(10_000).optional(),
  status: contentStatusSchema.optional(), metadata: limitedJsonObject().optional(), overridesWorldDefinition: z.boolean().optional(),
}).superRefine((value, context) => {
  const createFields = ['name', 'description', 'mechanics', 'requirements', 'presentation', 'tags', 'schemaVersion', 'status'] as const;
  if (value.mode === 'create') {
    createFields.forEach((field) => {
      if (value[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: 'Required when mode is create' });
    });
    if (value.status !== undefined && value.status !== 'active') context.addIssue({ code: 'custom', path: ['status'], message: 'Initial content must be active' });
    if (value.overridesWorldDefinition === true && value.scope !== 'campaign') {
      context.addIssue({ code: 'custom', path: ['overridesWorldDefinition'], message: 'Only campaign definitions can override World content' });
    }
  } else {
    if (value.scope !== 'world') context.addIssue({ code: 'custom', path: ['scope'], message: 'Reused content must have world scope' });
    [...createFields, 'metadata', 'overridesWorldDefinition'].forEach((field) => {
      if (value[field as keyof typeof value] !== undefined) context.addIssue({ code: 'custom', path: [field], message: 'Not allowed when mode is reuse' });
    });
  }
});

const initialContentPackageSchema = z.strictObject({
  definition: initialDefinitionSchema,
  protagonistLink: initialLinkSchema.optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInitiallyKnown(state: unknown): boolean {
  return state === 'known' || state === 'mastered';
}

function validateStartingClassLink(
  value: z.infer<typeof initialContentPackageSchema> | undefined, context: z.RefinementCtx,
) {
  const link = value?.protagonistLink;
  if (link !== undefined && (!isInitiallyKnown(link.state) || link.equipped)) {
    context.addIssue({ code: 'custom', path: ['initialContentPackages'], message: 'Starting class must be known or mastered and not equipped' });
  }
}

function validateKnownRequirements(
  value: z.infer<typeof initialContentPackageSchema>, index: number, linkedKnown: Set<string>, attributes: Record<string, unknown>,
  context: z.RefinementCtx,
) {
  const requirements = value.definition.requirements;
  if (!isRecord(requirements)) return;
  if ('requiredContent' in requirements) {
    if (!Array.isArray(requirements.requiredContent)) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'requirements', 'requiredContent'], message: 'Must be an array' });
    } else {
      requirements.requiredContent.forEach((required, requiredIndex) => {
        const path = ['initialContentPackages', index, 'definition', 'requirements', 'requiredContent', requiredIndex];
        if (!isRecord(required) || Object.keys(required).some((key) => !['contentType', 'code'].includes(key))) {
          context.addIssue({ code: 'custom', path, message: 'Must contain only contentType and code' });
          return;
        }
        const parsedType = contentTypeSchema.safeParse(required.contentType);
        const parsedCode = codeSchema.safeParse(required.code);
        if (!parsedType.success || !parsedCode.success) {
          context.addIssue({ code: 'custom', path, message: 'Must contain a valid contentType and code' });
          return;
        }
        if (!linkedKnown.has(`${parsedType.data}:${parsedCode.data}`)) {
          context.addIssue({ code: 'custom', path, message: 'Required content must be initially known or mastered by the protagonist' });
        }
      });
    }
  }
  if ('minimumAttributes' in requirements) {
    if (!isRecord(requirements.minimumAttributes)) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'requirements', 'minimumAttributes'], message: 'Must be an object' });
    } else {
      Object.entries(requirements.minimumAttributes).forEach(([attribute, minimum]) => {
        const actual = attributes[attribute];
        if (typeof minimum !== 'number' || !Number.isFinite(minimum)) {
          context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'requirements', 'minimumAttributes', attribute], message: 'Must be a finite number' });
        } else if (typeof actual !== 'number' || actual < minimum) {
          context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'requirements', 'minimumAttributes', attribute], message: 'Protagonist does not meet the minimum attribute' });
        }
      });
    }
  }
}

function validateEquipped(value: z.infer<typeof initialContentPackageSchema>, index: number, context: z.RefinementCtx) {
  if (value.protagonistLink?.equipped !== true || value.definition.mode !== 'create') return;
  const mechanics = value.definition.mechanics ?? {};
  const behavior = mechanics.equipBehavior;
  const type = value.definition.contentType;
  const path = ['initialContentPackages', index, 'protagonistLink', 'equipped'];
  if (type === 'race' || type === 'class' || (type === 'status_effect' && mechanics.permanence === 'permanent') || mechanics.passive === true || behavior === 'none') {
    context.addIssue({ code: 'custom', path, message: 'This content cannot be equipped' });
    return;
  }
  const allowed: Partial<Record<z.infer<typeof contentTypeSchema>, string[]>> = {
    weapon: ['wieldable'], armor: ['wearable'], shield: ['wieldable', 'wearable'], item: ['readied', 'activatable'],
    spell: ['prepared', 'activatable'], talent: ['activatable'], skill: ['activatable'],
  };
  if (typeof behavior !== 'string' || !(allowed[type]?.includes(behavior) ?? false)) context.addIssue({ code: 'custom', path, message: 'equipBehavior is incompatible with contentType' });
}

export const startGameSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  playerMode: z.enum(['create', 'reuse']), playerRef: codeSchema, playerDisplayName: z.string().trim().min(1).max(200).optional(),
  worldMode: z.enum(['create', 'reuse']), worldRef: codeSchema, worldName: z.string().trim().min(1).max(200).optional(),
  worldDescription: z.string().trim().min(1).max(3_000).nullable().optional(), worldConfiguration: worldConfigurationSchema.optional(),
  campaignRef: codeSchema, campaignName: z.string().trim().min(1).max(200), campaignConfiguration: campaignConfigurationSchema,
  protagonist: initialProtagonistSchema,
  initialContentPackages: z.array(initialContentPackageSchema).max(24),
  initialPremise: z.string().trim().min(1).max(1_000),
}).superRefine((value, context) => {
  if (jsonByteSize(value) > START_GAME_MAX_BYTES) context.addIssue({ code: 'custom', message: 'Serialized startGame payload must be at most 81920 bytes' });
  if (value.playerMode === 'create' && value.playerDisplayName === undefined) context.addIssue({ code: 'custom', path: ['playerDisplayName'], message: 'Required when playerMode is create' });
  if (value.worldMode === 'create') {
    if (value.worldName === undefined) context.addIssue({ code: 'custom', path: ['worldName'], message: 'Required when worldMode is create' });
    if (value.worldConfiguration === undefined) context.addIssue({ code: 'custom', path: ['worldConfiguration'], message: 'Required when worldMode is create' });
  }
  if (value.protagonist.code !== value.playerRef) context.addIssue({ code: 'custom', path: ['protagonist', 'code'], message: 'Must match playerRef' });

  const classModel = value.campaignConfiguration.classModel;
  if (classModel.mode === 'none') {
    if (value.protagonist.className !== undefined && value.protagonist.className !== null) context.addIssue({ code: 'custom', path: ['protagonist', 'className'], message: 'Must be null or absent when classes do not exist' });
    if (classModel.progressionBasis.includes('class')) context.addIssue({ code: 'custom', path: ['campaignConfiguration', 'classModel', 'progressionBasis'], message: 'Must not include class when mode is none' });
  }

  const seen = new Set<string>();
  const linkedKnown = new Set(value.initialContentPackages.filter((item) => isInitiallyKnown(item.protagonistLink?.state))
    .map((item) => `${item.definition.contentType}:${item.definition.code}`));
  const initialClasses = value.initialContentPackages.filter((item) => item.definition.contentType === 'class' && item.protagonistLink !== undefined);
  value.initialContentPackages.forEach((item, index) => {
    const definition = item.definition;
    const key = `${definition.scope}:${definition.contentType}:${definition.code}`;
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'code'], message: 'Duplicate scope, contentType and code in payload' });
    seen.add(key);
    if (['none', 'identity'].includes(classModel.mode) && isRecord(definition.requirements) && 'className' in definition.requirements) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition', 'requirements', 'className'], message: 'className requirements require a mechanical class model' });
    }
    if (classModel.mode === 'none' && definition.contentType === 'class' && item.protagonistLink !== undefined) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'protagonistLink'], message: 'Class content cannot be linked when classModel.mode is none' });
    }
    if (definition.mode === 'create' && definition.contentType === 'race' && definition.name === value.protagonist.species
      && Object.keys(definition.mechanics ?? {}).length === 0 && Object.keys(definition.requirements ?? {}).length === 0) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition'], message: 'Do not create race content only to repeat protagonist.species' });
    }
    if (definition.mode === 'create' && definition.contentType === 'status_effect') {
      const condition = definition.metadata?.category === 'condition';
      const permanent = definition.mechanics?.permanence === 'permanent';
      if (condition !== permanent) context.addIssue({ code: 'custom', path: ['initialContentPackages', index, 'definition'], message: 'Permanent conditions require metadata.category=condition and mechanics.permanence=permanent' });
    }
    validateEquipped(item, index, context);
    if (isInitiallyKnown(item.protagonistLink?.state)) validateKnownRequirements(item, index, linkedKnown, value.protagonist.attributes ?? {}, context);
  });

  if (classModel.mode === 'mechanical' && classModel.startingClass === 'required') {
    if (value.protagonist.className === undefined || value.protagonist.className === null) context.addIssue({ code: 'custom', path: ['protagonist', 'className'], message: 'Required for a required mechanical starting class' });
    if (initialClasses.length !== 1) context.addIssue({ code: 'custom', path: ['initialContentPackages'], message: 'Exactly one linked class package is required' });
    validateStartingClassLink(initialClasses[0], context);
  }
  if (classModel.mode === 'mechanical' && classModel.startingClass === 'optional') {
    const hasClassName = value.protagonist.className !== undefined && value.protagonist.className !== null;
    if (hasClassName !== (initialClasses.length > 0) || initialClasses.length > 1) {
      context.addIssue({ code: 'custom', path: ['initialContentPackages'], message: 'Optional mechanical class requires className and exactly one linked class package together' });
    }
    if (hasClassName && initialClasses.length === 1) validateStartingClassLink(initialClasses[0], context);
  }
  if (classModel.mode === 'mechanical' && classModel.startingClass === 'unassigned'
    && ((value.protagonist.className !== undefined && value.protagonist.className !== null) || initialClasses.length > 0)) {
    context.addIssue({ code: 'custom', path: ['initialContentPackages'], message: 'Unassigned mechanical class cannot include className or a linked class package' });
  }
  if (classModel.mode === 'mechanical' && ['required', 'optional'].includes(classModel.startingClass)
    && initialClasses.length === 1 && value.protagonist.className !== undefined && value.protagonist.className !== null) {
    const definition = initialClasses[0]?.definition;
    if (definition?.mode === 'create' && definition.name !== value.protagonist.className) {
      context.addIssue({
        code: 'custom', path: ['protagonist', 'className'],
        message: 'Must exactly match the public name of the linked mechanical class',
      });
    }
  }

  const metadataValues = [value.protagonist.metadata, ...value.initialContentPackages.flatMap((item) => [item.definition.metadata, item.protagonistLink?.metadata])]
    .filter((item) => item !== undefined);
  if (metadataValues.reduce((total, item) => total + jsonByteSize(item), 0) > METADATA_TOTAL_MAX_BYTES) {
    context.addIssue({ code: 'custom', path: ['initialContentPackages'], message: 'Total metadata must be at most 20480 serialized bytes' });
  }
});

export const upsertActorSchema = z.strictObject({
  ...scopeFields, idempotencyKey: idempotencyKeySchema, code: codeSchema, name: z.string().trim().min(1).max(200), actorType: actorTypeSchema,
  species: z.string().trim().min(1).max(100).nullable().optional(), className: z.string().trim().min(1).max(100).nullable().optional(), ...actorMechanicsFields,
});

export const patchActorSchema = z.strictObject({ ...scopeFields, idempotencyKey: idempotencyKeySchema, ...actorMechanicsFields }).refine(
  (value) => Object.keys(value).some((key) => !['playerRef', 'worldRef', 'campaignRef', 'idempotencyKey'].includes(key)),
  { message: 'At least one approved actor field is required' },
);

export const upsertContentSchema = z.strictObject({
  ...scopeFields, campaignRef: codeSchema.nullable(), idempotencyKey: idempotencyKeySchema, contentType: contentTypeSchema,
  code: codeSchema, name: z.string().trim().min(1).max(200), description: z.string().trim().min(1).max(10_000),
  mechanics: jsonObjectSchema, requirements: jsonObjectSchema, presentation: jsonObjectSchema,
  tags: z.array(z.string().trim().min(1).max(100)).max(50), schemaVersion: z.number().int().min(1).max(10_000),
  status: contentStatusSchema, metadata: limitedJsonObject().optional(),
});

const actorContentChangesSchema = z.strictObject({
  state: actorContentStateSchema.optional(), rank: z.number().int().min(0).optional(), progress: z.number().int().min(0).optional(),
  mastery: z.number().int().min(0).optional(), equipped: z.boolean().optional(), quantity: z.number().int().min(0).optional(),
  notes: z.string().trim().max(2_000).nullable().optional(), metadata: limitedJsonObject().optional(),
}).optional();

export const manageActorContentSchema = z.strictObject({
  ...scopeFields, operation: z.enum(['get', 'list', 'learn', 'grant', 'update', 'equip', 'unequip', 'remove']),
  contentRef: codeSchema.optional(), contentType: contentTypeSchema.optional(), idempotencyKey: idempotencyKeySchema.optional(), changes: actorContentChangesSchema,
}).superRefine((value, context) => {
  if (value.operation !== 'list' && (value.contentRef === undefined || value.contentType === undefined)) context.addIssue({ code: 'custom', path: ['contentRef'], message: 'contentRef and contentType are required' });
  if (!['get', 'list'].includes(value.operation) && value.idempotencyKey === undefined) context.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'Required for write operations' });
  if (value.operation === 'update' && value.changes === undefined) context.addIssue({ code: 'custom', path: ['changes'], message: 'Required for update' });
});

export const createEventSchema = z.strictObject({
  ...scopeFields, actorRef: codeSchema.optional(), eventType: codeSchema, title: z.string().trim().min(1).max(300),
  payload: jsonObjectSchema, idempotencyKey: idempotencyKeySchema,
});

export type LoadGameInput = z.infer<typeof loadGameSchema>;
export type ListPlayerWorldsInput = z.infer<typeof listPlayerWorldsSchema>;
export type ListWorldCampaignsInput = z.infer<typeof listWorldCampaignsSchema>;
export type StartGameInput = z.infer<typeof startGameSchema>;
export type ListCampaignActorsInput = z.infer<typeof listCampaignActorsSchema>;
export type UpsertActorInput = z.infer<typeof upsertActorSchema>;
export type PatchActorInput = z.infer<typeof patchActorSchema>;
export type UpsertContentInput = z.infer<typeof upsertContentSchema>;
export type ManageActorContentInput = z.infer<typeof manageActorContentSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
