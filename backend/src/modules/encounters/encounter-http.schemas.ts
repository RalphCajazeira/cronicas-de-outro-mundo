import { z } from 'zod';
import { codeSchema } from '../actors/actors.schemas.js';

export const ENCOUNTER_HTTP_MAX_PARTICIPANTS = 64;
export const ENCOUNTER_HTTP_MAX_RELATION_OVERRIDES = 128;
export const ENCOUNTER_HTTP_MAX_TARGETS = 16;
export const ENCOUNTER_HTTP_JSON_LIMIT_BYTES = 100 * 1024;

const scopeFields = {
  playerRef: codeSchema,
  worldRef: codeSchema,
  campaignRef: codeSchema,
  encounterRef: codeSchema,
};
const idempotencyKeySchema = z.string().trim().min(8).max(200);
const expectedStateVersionSchema = z.number().int().min(1).max(2_147_483_647);
const zoneSchema = z.enum(['engaged', 'near', 'medium', 'far', 'out_of_range']);
const reactionKindSchema = z.enum(['block', 'active_dodge', 'interrupt', 'counter_attack']);

function hasOnlyPlainObjectPrototypes(value: unknown, visited = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (visited.has(value)) return true;
  visited.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return false;
    return value.every((item) => hasOnlyPlainObjectPrototypes(item, visited));
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((item) => hasOnlyPlainObjectPrototypes(item, visited));
}

const participantSchema = z.strictObject({
  actorRef: codeSchema,
  sideRef: codeSchema,
  zone: zoneSchema,
  surprised: z.boolean().optional(),
});

const relationOverrideSchema = z.strictObject({
  leftActorRef: codeSchema,
  rightActorRef: codeSchema,
  relation: z.enum(['ally', 'hostile', 'neutral']),
});

const contentReferenceSchema = z.strictObject({
  scope: z.enum(['world', 'campaign']),
  contentType: z.enum([
    'skill', 'spell', 'weapon', 'armor', 'shield', 'clothing', 'item', 'consumable',
    'talent', 'status_effect',
  ]),
  code: codeSchema,
  versionNumber: z.number().int().min(1).max(2_147_483_647),
});

const targetRefsSchema = z.array(codeSchema).min(1).max(ENCOUNTER_HTTP_MAX_TARGETS).superRefine((refs, context) => {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    if (seen.has(ref)) context.addIssue({ code: 'custom', path: [index], message: 'Target references must be unique' });
    seen.add(ref);
  });
});

const intentSchema = z.strictObject({
  actorRef: codeSchema,
  slotRef: codeSchema,
  actionSource: z.enum(['content', 'consumable', 'basic_weapon_attack']),
  targetSelector: z.enum(['self', 'explicit', 'nearest_hostile', 'lowest_hp_hostile', 'nearest_ally']),
  targetRefs: targetRefsSchema.optional(),
  contentRef: contentReferenceSchema.optional(),
  inventoryEntryRef: codeSchema.optional(),
  versatileMode: z.enum(['one_handed', 'two_handed']).optional(),
}).superRefine((intent, context) => {
  if (intent.targetSelector === 'explicit' && intent.targetRefs === undefined) {
    context.addIssue({ code: 'custom', path: ['targetRefs'], message: 'Required when targetSelector is explicit' });
  }
  if (intent.targetSelector !== 'explicit' && intent.targetRefs !== undefined) {
    context.addIssue({ code: 'custom', path: ['targetRefs'], message: 'Allowed only when targetSelector is explicit' });
  }
  if (intent.actionSource === 'content') {
    if (intent.contentRef === undefined) context.addIssue({ code: 'custom', path: ['contentRef'], message: 'Required for content actions' });
    if (intent.inventoryEntryRef !== undefined) context.addIssue({ code: 'custom', path: ['inventoryEntryRef'], message: 'Not allowed for content actions' });
    if (intent.versatileMode !== undefined) context.addIssue({ code: 'custom', path: ['versatileMode'], message: 'Not allowed for content actions' });
  }
  if (intent.actionSource === 'consumable') {
    if (intent.inventoryEntryRef === undefined) context.addIssue({ code: 'custom', path: ['inventoryEntryRef'], message: 'Required for consumable actions' });
    if (intent.contentRef !== undefined) context.addIssue({ code: 'custom', path: ['contentRef'], message: 'Not allowed for consumable actions' });
    if (intent.versatileMode !== undefined) context.addIssue({ code: 'custom', path: ['versatileMode'], message: 'Not allowed for consumable actions' });
  }
  if (intent.actionSource === 'basic_weapon_attack') {
    if (intent.inventoryEntryRef === undefined) context.addIssue({ code: 'custom', path: ['inventoryEntryRef'], message: 'Required for basic weapon attacks' });
    if (intent.contentRef !== undefined) context.addIssue({ code: 'custom', path: ['contentRef'], message: 'Not allowed for basic weapon attacks' });
  }
});

const createSchema = z.strictObject({
  operation: z.literal('create'),
  ...scopeFields,
  idempotencyKey: idempotencyKeySchema,
  partySideRef: codeSchema.optional(),
  participants: z.array(participantSchema).min(1).max(ENCOUNTER_HTTP_MAX_PARTICIPANTS),
  relationOverrides: z.array(relationOverrideSchema).max(ENCOUNTER_HTTP_MAX_RELATION_OVERRIDES).optional(),
}).superRefine((input, context) => {
  const participantRefs = new Set<string>();
  const sideRefs = new Set<string>();
  input.participants.forEach((participant, index) => {
    if (participantRefs.has(participant.actorRef)) {
      context.addIssue({ code: 'custom', path: ['participants', index, 'actorRef'], message: 'Participant references must be unique' });
    }
    participantRefs.add(participant.actorRef);
    sideRefs.add(participant.sideRef);
  });
  if (input.partySideRef !== undefined && !sideRefs.has(input.partySideRef)) {
    context.addIssue({ code: 'custom', path: ['partySideRef'], message: 'Party side must belong to a participant' });
  }
  const overridePairs = new Set<string>();
  input.relationOverrides?.forEach((override, index) => {
    if (override.leftActorRef === override.rightActorRef) {
      context.addIssue({ code: 'custom', path: ['relationOverrides', index], message: 'Self relations cannot be overridden' });
    }
    for (const field of ['leftActorRef', 'rightActorRef'] as const) {
      if (!participantRefs.has(override[field])) {
        context.addIssue({ code: 'custom', path: ['relationOverrides', index, field], message: 'Relation reference must identify a participant' });
      }
    }
    const pair = [override.leftActorRef, override.rightActorRef].sort().join('\u0000');
    if (overridePairs.has(pair)) {
      context.addIssue({ code: 'custom', path: ['relationOverrides', index], message: 'Relation override pairs must be unique' });
    }
    overridePairs.add(pair);
  });
});

const loadSchema = z.strictObject({ operation: z.literal('load'), ...scopeFields });
const submitIntentSchema = z.strictObject({
  operation: z.literal('submit_intent'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
  intent: intentSchema,
});
const resolveReactionSchema = z.strictObject({
  operation: z.literal('resolve_reaction'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
  reactorRef: codeSchema, reactionKind: reactionKindSchema,
});
const continueSchema = z.strictObject({
  operation: z.literal('continue'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
});
const confirmCompletionSchema = z.strictObject({
  operation: z.literal('confirm_completion'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
});
const cancelSchema = z.strictObject({
  operation: z.literal('cancel'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
});

const manageEncounterOperationSchema = z.discriminatedUnion('operation', [
  createSchema, loadSchema, submitIntentSchema, resolveReactionSchema,
  continueSchema, confirmCompletionSchema, cancelSchema,
]);

export const manageEncounterSchema = z.preprocess((value, context) => {
  if (!hasOnlyPlainObjectPrototypes(value)) {
    context.addIssue({ code: 'custom', message: 'Objects must use a plain prototype' });
    return z.NEVER;
  }
  return value;
}, manageEncounterOperationSchema);

export type ManageEncounterInput = z.infer<typeof manageEncounterSchema>;
export type CreateEncounterHttpInput = z.infer<typeof createSchema>;
export type SubmitIntentHttpInput = z.infer<typeof submitIntentSchema>;
