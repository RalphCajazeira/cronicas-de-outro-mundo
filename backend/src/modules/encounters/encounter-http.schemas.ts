import { z } from 'zod';
import { codeSchema } from '../actors/actors.schemas.js';

export const ENCOUNTER_HTTP_MAX_PARTICIPANTS = 64;
export const ENCOUNTER_HTTP_MAX_RELATION_OVERRIDES = 128;
export const ENCOUNTER_HTTP_MAX_TARGETS = 16;
export const ENCOUNTER_HTTP_MAX_BEAT_COMPONENTS = 3;
export const ENCOUNTER_HTTP_MAX_NPC_DIRECTIVES = 16;
export const ENCOUNTER_HTTP_MAX_AUTOMATIC_BEATS = 12;
export const ENCOUNTER_HTTP_DEFAULT_AUTOMATIC_BEATS = 6;
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

const actorRefsSchema = z.array(codeSchema).min(1).max(ENCOUNTER_HTTP_MAX_PARTICIPANTS).superRefine((refs, context) => {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    if (seen.has(ref)) context.addIssue({ code: 'custom', path: [index], message: 'Actor references must be unique' });
    seen.add(ref);
  });
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

const beatTargetRefsSchema = z.array(codeSchema).min(1).max(ENCOUNTER_HTTP_MAX_TARGETS).superRefine((refs, context) => {
  const seen = new Set<string>();
  refs.forEach((ref, index) => {
    if (seen.has(ref)) context.addIssue({ code: 'custom', path: [index], message: 'Target references must be unique' });
    seen.add(ref);
  });
});

const beatConditionSchema = z.strictObject({
  actorRef: codeSchema.optional(),
  resource: z.enum(['hp', 'mana', 'sp']),
  operator: z.enum(['at_or_below_percent', 'at_or_above_percent']),
  percent: z.number().int().min(0).max(100),
});

const beatComponentFields = {
  essential: z.boolean().optional(),
  when: beatConditionSchema.optional(),
  fallback: z.enum(['skip', 'defend']).optional(),
};

const beatComponentSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...beatComponentFields,
    type: z.literal('move'), destination: zoneSchema,
    movementKind: z.enum(['approach', 'retreat', 'run', 'disengage']).optional(),
  }),
  z.strictObject({ ...beatComponentFields, type: z.literal('defend') }),
  z.strictObject({ ...beatComponentFields, type: z.literal('protect'), targetRef: codeSchema }),
  z.strictObject({
    ...beatComponentFields,
    type: z.literal('prepare'), contentRef: contentReferenceSchema,
    trigger: z.enum(['enemy_advances', 'enemy_attacks', 'ally_attacked']),
    targetRefs: beatTargetRefsSchema.optional(),
  }),
  z.strictObject({ ...beatComponentFields, type: z.literal('intercept'), targetRef: codeSchema }),
  z.strictObject({ ...beatComponentFields, type: z.literal('assist'), targetRef: codeSchema }),
  z.strictObject({ ...beatComponentFields, type: z.literal('flee'), destination: z.enum(['far', 'out_of_range']).optional() }),
  z.strictObject({ ...beatComponentFields, type: z.literal('observe'), targetRef: codeSchema.optional() }),
  z.strictObject({ ...beatComponentFields, type: z.literal('interact'), targetRef: codeSchema, description: z.string().trim().min(1).max(500).optional() }),
  z.strictObject({ ...beatComponentFields, type: z.literal('improvise'), description: z.string().trim().min(1).max(500), targetRef: codeSchema.optional() }),
  z.strictObject({ ...beatComponentFields, type: z.literal('use_item'), inventoryEntryRef: codeSchema, targetRefs: beatTargetRefsSchema.optional() }),
  z.strictObject({
    ...beatComponentFields,
    type: z.literal('attack'), inventoryEntryRef: codeSchema, targetRefs: beatTargetRefsSchema,
    versatileMode: z.enum(['one_handed', 'two_handed']).optional(),
  }),
  z.strictObject({ ...beatComponentFields, type: z.literal('cast'), contentRef: contentReferenceSchema, targetRefs: beatTargetRefsSchema.optional() }),
]);

const beatComponentsSchema = z.array(beatComponentSchema).min(1).max(64).superRefine((components, context) => {
  if (components.length > ENCOUNTER_HTTP_MAX_BEAT_COMPONENTS) {
    context.addIssue({
      code: 'custom',
      message: `A beat accepts at most 3 components; received ${String(Math.min(components.length, 64))}. Split the intention into separate decisions.`,
    });
  }
  components.forEach((component, index) => {
    if (component.fallback !== undefined && component.when === undefined) {
      context.addIssue({
        code: 'custom',
        path: [index, 'fallback'],
        message: 'Fallback is allowed only for a bounded resource condition',
      });
    }
  });
});

const npcDirectiveSchema = z.strictObject({
  actorRef: codeSchema,
  strategy: z.enum(['aggressive', 'defensive', 'protect_ally', 'attack_vulnerable', 'flee_if_hurt', 'prioritize_caster']),
  targetRef: codeSchema.optional(),
});

const resolveBeatSchema = z.strictObject({
  operation: z.literal('resolve_beat'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
  intent: z.strictObject({
    actorRef: codeSchema,
    objective: z.string().trim().min(1).max(120),
    narrative: z.string().trim().min(1).max(1_000),
    resolutionPolicy: z.enum(['atomic', 'allow_partial']),
    components: beatComponentsSchema,
  }),
  npcDirectives: z.array(npcDirectiveSchema).max(ENCOUNTER_HTTP_MAX_NPC_DIRECTIVES).optional(),
}).superRefine((input, context) => {
  const directed = new Set<string>();
  input.npcDirectives?.forEach((directive, index) => {
    if (directed.has(directive.actorRef)) {
      context.addIssue({ code: 'custom', path: ['npcDirectives', index, 'actorRef'], message: 'NPC directives must use unique actor references' });
    }
    if (directive.actorRef === input.intent.actorRef) {
      context.addIssue({ code: 'custom', path: ['npcDirectives', index, 'actorRef'], message: 'The primary actor cannot also be an NPC directive' });
    }
    directed.add(directive.actorRef);
  });
});

const automaticResourcePolicySchema = z.strictObject({
  allowCommonConsumables: z.boolean().default(false),
  allowRareConsumables: z.boolean().default(false),
  allowLimitedAbilities: z.boolean().default(false),
  preserveManaPercent: z.number().int().min(0).max(100).default(50),
  preserveSpPercent: z.number().int().min(0).max(100).default(50),
  stopBelowHpPercent: z.number().int().min(1).max(100).default(25),
  stopIfProtectedActorBelowHpPercent: z.number().int().min(1).max(100).default(30),
  allowFlee: z.boolean().default(false),
  allowTargetSwitch: z.boolean().default(true),
  allowEnvironmentalInteraction: z.boolean().default(false),
});

const automaticPolicySchema = z.strictObject({
  actorRef: codeSchema,
  mode: z.enum(['until_decision', 'until_terminal', 'bounded']),
  strategy: z.enum(['aggressive', 'balanced', 'defensive', 'support', 'protect_target', 'escape']),
  objective: z.string().trim().min(1).max(120),
  targetPriority: z.enum(['nearest_hostile', 'lowest_hp_hostile', 'explicit']).default('nearest_hostile'),
  targetRefs: beatTargetRefsSchema.optional(),
  protectedActorRefs: z.array(codeSchema).max(16).optional(),
  maximumBeats: z.number().int().min(1).max(ENCOUNTER_HTTP_MAX_AUTOMATIC_BEATS)
    .default(ENCOUNTER_HTTP_DEFAULT_AUTOMATIC_BEATS),
  resourcePolicy: automaticResourcePolicySchema.default({
    allowCommonConsumables: false,
    allowRareConsumables: false,
    allowLimitedAbilities: false,
    preserveManaPercent: 50,
    preserveSpPercent: 50,
    stopBelowHpPercent: 25,
    stopIfProtectedActorBelowHpPercent: 30,
    allowFlee: false,
    allowTargetSwitch: true,
    allowEnvironmentalInteraction: false,
  }),
}).superRefine((policy, context) => {
  if (policy.targetPriority === 'explicit' && policy.targetRefs === undefined) {
    context.addIssue({ code: 'custom', path: ['targetRefs'], message: 'Required when targetPriority is explicit' });
  }
  if (policy.targetPriority !== 'explicit' && policy.targetRefs !== undefined) {
    context.addIssue({ code: 'custom', path: ['targetRefs'], message: 'Allowed only when targetPriority is explicit' });
  }
  const protectedRefs = policy.protectedActorRefs ?? [];
  if (new Set(protectedRefs).size !== protectedRefs.length) {
    context.addIssue({ code: 'custom', path: ['protectedActorRefs'], message: 'Protected actor references must be unique' });
  }
});

const resolveAutomaticBeatSchema = z.strictObject({
  operation: z.literal('resolve_beat'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
  policy: automaticPolicySchema,
});

const createExplicitSchema = z.strictObject({
  operation: z.literal('create'),
  ...scopeFields,
  idempotencyKey: idempotencyKeySchema,
  setupMode: z.literal('explicit').optional(),
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

const createAssistedSchema = z.strictObject({
  operation: z.literal('create'),
  ...scopeFields,
  idempotencyKey: idempotencyKeySchema,
  setupMode: z.literal('assisted'),
  encounterKind: z.literal('combat'),
  partyActorRefs: actorRefsSchema,
  hostileActorRefs: actorRefsSchema,
  neutralActorRefs: z.array(codeSchema).max(ENCOUNTER_HTTP_MAX_PARTICIPANTS).optional(),
  objective: z.string().trim().min(1).max(240),
  engagementPreference: z.enum(['immediate', 'close', 'ranged', 'ambush', 'safe_distance']),
  protectedActorRefs: z.array(codeSchema).max(16).optional(),
  environmentalContext: z.strictObject({
    summary: z.string().trim().min(1).max(500),
    tags: z.array(codeSchema).max(12).optional(),
  }).optional(),
}).superRefine((input, context) => {
  const groups = [
    ['partyActorRefs', input.partyActorRefs],
    ['hostileActorRefs', input.hostileActorRefs],
    ['neutralActorRefs', input.neutralActorRefs ?? []],
  ] as const;
  const assigned = new Map<string, string>();
  for (const [field, refs] of groups) {
    refs.forEach((ref, index) => {
      const previous = assigned.get(ref);
      if (previous !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [field, index],
          message: `Actor is already assigned to ${previous}`,
        });
      }
      assigned.set(ref, field);
    });
  }
  const protectedRefs = input.protectedActorRefs ?? [];
  if (new Set(protectedRefs).size !== protectedRefs.length) {
    context.addIssue({ code: 'custom', path: ['protectedActorRefs'], message: 'Protected actor references must be unique' });
  }
  protectedRefs.forEach((ref, index) => {
    if (!input.partyActorRefs.includes(ref)) {
      context.addIssue({
        code: 'custom',
        path: ['protectedActorRefs', index],
        message: 'Protected actors must belong to the party',
      });
    }
  });
});

const createSchema = z.union([createAssistedSchema, createExplicitSchema]);

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
const abandonSchema = z.strictObject({
  operation: z.literal('abandon'), ...scopeFields,
  idempotencyKey: idempotencyKeySchema, expectedStateVersion: expectedStateVersionSchema,
  confirmAuthorityDrift: z.literal(true),
});

const manageEncounterOperationSchema = z.union([
  createSchema, loadSchema, submitIntentSchema, resolveReactionSchema,
  continueSchema, confirmCompletionSchema, cancelSchema, abandonSchema, resolveBeatSchema, resolveAutomaticBeatSchema,
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
export type CreateExplicitEncounterHttpInput = z.infer<typeof createExplicitSchema>;
export type CreateAssistedEncounterHttpInput = z.infer<typeof createAssistedSchema>;
export type SubmitIntentHttpInput = z.infer<typeof submitIntentSchema>;
export type ResolveBeatHttpInput = z.infer<typeof resolveBeatSchema>;
export type ResolveAutomaticBeatHttpInput = z.infer<typeof resolveAutomaticBeatSchema>;
