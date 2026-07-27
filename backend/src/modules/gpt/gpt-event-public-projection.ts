import { z } from 'zod';
import { parseEncounterTerminalEventPayload } from '../encounters/encounter-consequence.js';

const publicReference = z.string().trim().min(1).max(200);
const publicAttributeNames = [
  'strength', 'vitality', 'agility', 'dexterity', 'intelligence',
  'wisdom', 'perception', 'willpower', 'luck',
] as const;
const publicPrimaryAttributes = z.strictObject(
  Object.fromEntries(publicAttributeNames.map((name) => [name, z.number().int()])),
);

const campaignStartedPublicPayload = z.object({
  schemaVersion: z.literal(1),
  technical: z.literal(true),
  difficultyPreset: z.enum(['story', 'easy', 'standard', 'hard', 'brutal', 'custom']),
  difficultyProfile: z.strictObject({
    errorTolerance: z.number().int(),
    opponentCunning: z.number().int(),
    resourceAvailability: z.number().int(),
    lethality: z.number().int(),
    failureSeverity: z.number().int(),
    narrativeSafetyNet: z.number().int(),
  }),
  worldConfigSummary: z.strictObject({
    schemaVersion: z.literal(1),
    genres: z.array(z.string().trim().min(1).max(100)).max(20),
    technologyGrade: z.string().trim().max(100).nullable(),
    magicGrade: z.string().trim().max(100).nullable(),
  }),
  campaignConfigSummary: z.strictObject({
    schemaVersion: z.literal(1),
    progressionPace: z.string().trim().min(1).max(100),
    narrativeTone: z.array(z.string().trim().min(1).max(100)).max(20),
    focus: z.array(z.string().trim().min(1).max(100)).max(20),
    playerFreedom: z.string().trim().min(1).max(100),
    consequenceLevel: z.string().trim().min(1).max(100),
    classMode: z.string().trim().min(1).max(100),
  }),
  initialContent: z.array(z.strictObject({
    scope: z.enum(['world', 'campaign']),
    contentType: z.string().trim().min(1).max(100),
    code: publicReference,
    linkedToProtagonist: z.boolean(),
  })).max(100),
  initialPremise: z.string().trim().min(1).max(1_000),
});

const authenticatedObservationPayload = z.object({
  gameSessionId: z.string().uuid(),
  action: z.object({
    type: z.literal('OBSERVE'),
    focus: z.string().trim().min(1).max(300).nullable(),
    summary: z.string().trim().min(1).max(500),
  }),
});

const progressionSnapshot = z.strictObject({
  actorRef: publicReference,
  level: z.number().int().positive(),
  xpCurrent: z.number().int().nonnegative(),
  xpRequiredForNextLevel: z.number().int().nonnegative().nullable(),
  basePrimaryAttributes: publicPrimaryAttributes,
  progressionPrimaryAttributes: publicPrimaryAttributes,
  effectivePrimaryAttributes: publicPrimaryAttributes,
  attributePointsEarned: z.number().int().nonnegative(),
  attributePointsAllocated: z.number().int().nonnegative(),
  attributePointsAvailable: z.number().int().nonnegative(),
  totalAttributeEntitlement: z.number().int().nonnegative(),
  mechanicsStateVersion: z.number().int().positive(),
  canLevelUp: z.boolean(),
});

const actorProgressionPublicPayload = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.enum(['grant_xp', 'level_up', 'allocate_attributes', 'set_progression_state']),
  reason: z.string().trim().min(1).max(500),
  changed: z.boolean(),
  before: progressionSnapshot,
  after: progressionSnapshot,
  resourceChanges: z.array(z.strictObject({
    resource: z.enum(['hp', 'mana', 'sp']),
    before: z.strictObject({ current: z.number().int(), max: z.number().int() }),
    after: z.strictObject({ current: z.number().int(), max: z.number().int() }),
  })).max(3),
});

const effectPublicPayload = z.strictObject({
  schemaVersion: z.literal(1),
  eventType: publicReference,
  sourceActorRef: publicReference,
  targetActorRef: publicReference,
  contentRef: z.strictObject({
    scope: z.enum(['world', 'campaign']),
    contentType: publicReference,
    code: publicReference,
    versionNumber: z.number().int().positive(),
  }),
  resource: z.enum(['hp', 'mana', 'sp']).optional(),
  amountPresent: z.boolean(),
  stacks: z.number().int().optional(),
});

const effectEventTypes = new Set([
  'resource_spent', 'resource_restored', 'damage_applied', 'status_applied',
  'status_refreshed', 'status_stacked', 'status_removed', 'status_expired',
  'modifier_applied', 'reaction_granted', 'movement_requested', 'consumable_consumed',
]);
const encounterEventTypes = new Set([
  'encounter-completed', 'encounter-defeated', 'encounter-stalemate', 'encounter-cancelled',
]);

export interface GameEventPublicProjectionInput {
  readonly actorRef?: string | null;
  readonly eventType: string;
  readonly title: string;
  readonly payload: unknown;
  readonly createdAt: Date | string;
}

function publicPayload(eventType: string, payload: unknown): Record<string, unknown> {
  if (eventType === 'AUTHENTICATED_OBSERVATION') {
    const parsed = authenticatedObservationPayload.safeParse(payload);
    return parsed.success ? parsed.data.action : {};
  }
  if (eventType === 'campaign-started') {
    const parsed = campaignStartedPublicPayload.safeParse(payload);
    return parsed.success ? parsed.data : {};
  }
  if (eventType.startsWith('actor-progression-')) {
    const parsed = actorProgressionPublicPayload.safeParse(payload);
    return parsed.success ? parsed.data : {};
  }
  if (effectEventTypes.has(eventType)) {
    const parsed = effectPublicPayload.safeParse(payload);
    return parsed.success ? parsed.data : {};
  }
  if (encounterEventTypes.has(eventType)) {
    try {
      return { ...parseEncounterTerminalEventPayload(payload) };
    } catch {
      return {};
    }
  }
  // Event types without an explicit public contract fail closed. Their raw
  // payload remains available to internal replay/loaders only.
  return {};
}

export function projectPublicGameEvent(event: GameEventPublicProjectionInput) {
  return {
    ...(event.actorRef === undefined ? {} : { actorRef: event.actorRef }),
    eventType: event.eventType,
    title: event.title,
    payload: publicPayload(event.eventType, event.payload),
    createdAt: typeof event.createdAt === 'string' ? event.createdAt : event.createdAt.toISOString(),
  };
}

const publicEventResponse = z.strictObject({
  campaignRef: publicReference,
  actorRef: publicReference.nullable(),
  eventType: publicReference,
  title: z.string().trim().min(1).max(300),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
});

export function projectPublicGameEventResponse(value: unknown): Record<string, unknown> {
  const parsed = publicEventResponse.safeParse(value);
  if (!parsed.success) return {};
  return {
    campaignRef: parsed.data.campaignRef,
    ...projectPublicGameEvent(parsed.data),
  };
}
