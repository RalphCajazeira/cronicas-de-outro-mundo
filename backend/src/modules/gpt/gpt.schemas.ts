import { z } from 'zod';
import { actorRefSchema } from '../actors/actors.schemas.js';

const codeSchema = actorRefSchema;
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const jsonObjectSchema = z.record(z.string(), z.json());
const scopeFields = {
  playerRef: codeSchema.default('ralph'),
  worldRef: codeSchema.default('elarion'),
  campaignRef: codeSchema.default('main-campaign'),
};

export const actorTypeSchema = z.enum(['character', 'npc', 'creature', 'companion', 'spirit']);
export const actorStatusSchema = z.enum(['active', 'inactive', 'defeated', 'dead', 'archived']);
export const contentTypeSchema = z.enum([
  'skill', 'spell', 'weapon', 'armor', 'shield', 'item', 'talent', 'material', 'class', 'race',
  'location', 'faction', 'quest_template', 'status_effect', 'recipe', 'creature_template', 'other',
]);
export const contentStatusSchema = z.enum(['draft', 'active', 'inactive', 'archived']);
export const actorContentStateSchema = z.enum(['locked', 'learning', 'known', 'mastered']);

export const loadGameSchema = z.strictObject(scopeFields);

export const listCampaignActorsSchema = z.strictObject({
  playerRef: scopeFields.playerRef,
  worldRef: scopeFields.worldRef,
  campaignRef: codeSchema,
});

const actorChangesFields = {
  role: z.string().trim().min(1).max(100).nullable().optional(),
  description: z.string().trim().min(1).max(5_000).nullable().optional(),
  level: z.number().int().min(1).max(10_000).optional(),
  xp: z.number().int().min(0).optional(),
  gold: z.number().int().min(0).optional(),
  health: z.number().int().min(0).optional(),
  maxHealth: z.number().int().min(1).optional(),
  mana: z.number().int().min(0).optional(),
  maxMana: z.number().int().min(0).optional(),
  attributes: jsonObjectSchema.optional(),
  resistances: jsonObjectSchema.optional(),
  affinities: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  status: actorStatusSchema.optional(),
};

const initialProtagonistSchema = z.strictObject({
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  actorType: z.literal('character'),
  species: z.string().trim().min(1).max(100).nullable().optional(),
  className: z.string().trim().min(1).max(100).nullable().optional(),
  ...actorChangesFields,
});

export const startGameSchema = z.strictObject({
  idempotencyKey: idempotencyKeySchema,
  playerRef: codeSchema.default('ralph'),
  playerDisplayName: z.string().trim().min(1).max(200),
  worldRef: codeSchema.default('elarion'),
  worldName: z.string().trim().min(1).max(200),
  worldDescription: z.string().trim().min(1).max(5_000).nullable().optional(),
  worldMetadata: jsonObjectSchema.default({}),
  campaignRef: codeSchema.default('main-campaign'),
  campaignName: z.string().trim().min(1).max(200),
  campaignMetadata: jsonObjectSchema.default({}),
  protagonist: initialProtagonistSchema,
}).superRefine((value, context) => {
  if (value.protagonist.code !== value.playerRef) {
    context.addIssue({ code: 'custom', path: ['protagonist', 'code'], message: 'Must match playerRef' });
  }
});

export const upsertActorSchema = z.strictObject({
  ...scopeFields,
  idempotencyKey: idempotencyKeySchema,
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  actorType: actorTypeSchema,
  species: z.string().trim().min(1).max(100).nullable().optional(),
  className: z.string().trim().min(1).max(100).nullable().optional(),
  ...actorChangesFields,
});

export const patchActorSchema = z.strictObject({
  ...scopeFields,
  idempotencyKey: idempotencyKeySchema,
  ...actorChangesFields,
}).refine((value) => Object.keys(value).some((key) => !['playerRef', 'worldRef', 'campaignRef', 'idempotencyKey'].includes(key)), {
  message: 'At least one approved actor field is required',
});

export const upsertContentSchema = z.strictObject({
  ...scopeFields,
  campaignRef: codeSchema.nullable().default('main-campaign'),
  idempotencyKey: idempotencyKeySchema,
  contentType: contentTypeSchema,
  code: codeSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  mechanics: jsonObjectSchema,
  requirements: jsonObjectSchema,
  presentation: jsonObjectSchema,
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  schemaVersion: z.number().int().min(1).max(10_000),
  status: contentStatusSchema,
  metadata: jsonObjectSchema.optional(),
});

const actorContentChangesSchema = z.strictObject({
  state: actorContentStateSchema.optional(),
  rank: z.number().int().min(0).optional(),
  progress: z.number().int().min(0).optional(),
  mastery: z.number().int().min(0).optional(),
  equipped: z.boolean().optional(),
  quantity: z.number().int().min(0).optional(),
  notes: z.string().trim().max(2_000).nullable().optional(),
  metadata: jsonObjectSchema.optional(),
}).optional();

export const manageActorContentSchema = z.strictObject({
  ...scopeFields,
  operation: z.enum(['get', 'list', 'learn', 'grant', 'update', 'equip', 'unequip', 'remove']),
  contentRef: codeSchema.optional(),
  contentType: contentTypeSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
  changes: actorContentChangesSchema,
}).superRefine((value, context) => {
  if (value.operation !== 'list' && (value.contentRef === undefined || value.contentType === undefined)) {
    context.addIssue({ code: 'custom', path: ['contentRef'], message: 'contentRef and contentType are required' });
  }
  if (!['get', 'list'].includes(value.operation) && value.idempotencyKey === undefined) {
    context.addIssue({ code: 'custom', path: ['idempotencyKey'], message: 'Required for write operations' });
  }
  if (value.operation === 'update' && value.changes === undefined) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'Required for update' });
  }
});

export const createEventSchema = z.strictObject({
  ...scopeFields,
  actorRef: codeSchema.optional(),
  eventType: codeSchema,
  title: z.string().trim().min(1).max(300),
  payload: jsonObjectSchema,
  idempotencyKey: idempotencyKeySchema,
});

export type LoadGameInput = z.infer<typeof loadGameSchema>;
export type StartGameInput = z.infer<typeof startGameSchema>;
export type ListCampaignActorsInput = z.infer<typeof listCampaignActorsSchema>;
export type UpsertActorInput = z.infer<typeof upsertActorSchema>;
export type PatchActorInput = z.infer<typeof patchActorSchema>;
export type UpsertContentInput = z.infer<typeof upsertContentSchema>;
export type ManageActorContentInput = z.infer<typeof manageActorContentSchema>;
export type CreateEventInput = z.infer<typeof createEventSchema>;
