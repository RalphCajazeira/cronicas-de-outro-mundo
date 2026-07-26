import { z } from 'zod';

const selectionRefSchema = z.string().regex(/^sel_[A-Za-z0-9_-]{43}$/u);
const resourceSchema = z.object({
  code: z.enum(['hp', 'mana', 'sp']),
  current: z.number().int().min(0),
  maximum: z.number().int().min(1).nullable(),
}).strict();
const characterSchema = z.object({
  selectionRef: selectionRefSchema,
  displayName: z.string().min(1).max(200),
  level: z.number().int().min(1),
  accessLabel: z.enum(['Somente consulta', 'Jogável']),
}).strict();
const campaignSchema = z.object({
  selectionRef: selectionRefSchema,
  displayName: z.string().min(1).max(200),
  worldName: z.string().min(1).max(200),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']),
  sessionVersion: z.number().int().min(0),
  characters: z.array(characterSchema).max(100),
}).strict();

export const authenticatedContextSchema = z.object({
  authState: z.enum(['AUTHENTICATED_NO_PLAYER', 'AUTHENTICATED', 'AUTHORIZATION_ERROR']),
  player: z.object({ displayName: z.string().min(1).max(200) }).strict().nullable(),
  narrativeContext: z.object({
    campaignName: z.string().min(1).max(200),
    characterName: z.string().min(1).max(200).nullable(),
    publicLocation: z.string().min(1).max(300).nullable(),
    continuitySummary: z.string().min(1).max(500),
    pendingDecision: z.string().min(1).max(300).nullable(),
    criticalResources: z.array(resourceSchema).max(3),
    narrationClassification: z.enum([
      'NONE',
      'COMPACT',
      'STANDARD',
      'IMPORTANT',
      'CRITICAL',
      'PLAYER_DECISION_REQUIRED',
    ]),
  }).strict().nullable(),
  widgetContext: z.object({
    banner: z.string().min(1).max(100),
    connectedPlayer: z.string().min(1).max(200).nullable(),
    campaigns: z.array(campaignSchema).max(20),
    activeContext: z.object({
      campaign: campaignSchema.omit({ characters: true }),
      character: characterSchema.nullable(),
      resources: z.array(resourceSchema).max(3),
      readOnly: z.literal(true),
    }).strict().nullable(),
    gameSession: z.object({
      status: z.enum(['NONE', 'ACTIVE', 'UNAVAILABLE']),
      stateVersion: z.number().int().min(0),
      canContinue: z.boolean(),
      selection: z.object({
        campaignSelectionRef: selectionRefSchema,
        characterSelectionRef: selectionRefSchema,
      }).strict().nullable(),
    }).strict(),
    sessionState: z.enum([
      'NO_PLAYER',
      'NO_CAMPAIGN',
      'CAMPAIGN_SELECTION_REQUIRED',
      'CHARACTER_SELECTION_REQUIRED',
      'READ_ONLY_READY',
      'AUTHORIZATION_ERROR',
    ]),
    navigation: z.object({
      canSelectCampaign: z.boolean(),
      canSelectCharacter: z.boolean(),
      canViewContext: z.boolean(),
      canMutate: z.literal(false),
      canPersistSelection: z.boolean(),
      canContinue: z.boolean(),
    }).strict(),
    cta: z.object({
      kind: z.enum([
        'LINK_PLAYER',
        'WAIT_FOR_CAMPAIGN',
        'SELECT_CAMPAIGN',
        'SELECT_CHARACTER',
        'VIEW_CONTEXT',
        'CONFIRM_SELECTION',
        'CONTINUE',
        'RECONNECT',
      ]),
      label: z.string().min(1).max(100),
    }).strict(),
  }).strict(),
  environment: z.object({
    appEnvironment: z.enum(['local', 'test', 'staging', 'production']),
    runtimeMode: z.enum(['development', 'test', 'production']),
    syntheticAccount: z.boolean(),
  }).strict(),
}).strict();

export type AuthenticatedContext = z.infer<typeof authenticatedContextSchema>;
