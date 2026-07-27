import { z } from 'zod';

export const observedActionReferenceSchema = z.object({
  type: z.literal('OBSERVE'),
  status: z.literal('RESOLVED'),
  summary: z.string().trim().min(1).max(500),
  focus: z.string().trim().min(1).max(300).nullable(),
  occurredAt: z.string().datetime(),
  discoveredFacts: z.array(z.string().trim().min(1).max(240)).max(15),
}).strict();

export const authorizedSelectionRefSchema = z.string()
  .regex(/^sel_[A-Za-z0-9_-]{43}$/u);

const publicResourceSchema = z.object({
  code: z.enum(['hp', 'mana', 'sp']),
  current: z.number().int().min(0),
  maximum: z.number().int().min(1).nullable(),
}).strict();

const authorizedCharacterOptionSchema = z.object({
  selectionRef: authorizedSelectionRefSchema,
  displayName: z.string().trim().min(1).max(200),
  level: z.number().int().min(1),
  accessLabel: z.enum(['Somente consulta', 'Jogável']),
}).strict();

const authorizedCampaignOptionSchema = z.object({
  selectionRef: authorizedSelectionRefSchema,
  displayName: z.string().trim().min(1).max(200),
  worldName: z.string().trim().min(1).max(200),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'archived']),
  sessionVersion: z.number().int().min(0),
  characters: z.array(authorizedCharacterOptionSchema).max(100),
}).strict();

export const narrativeContextSchema = z.object({
  campaignName: z.string().trim().min(1).max(200),
  characterName: z.string().trim().min(1).max(200).nullable(),
  publicLocation: z.string().trim().min(1).max(300).nullable(),
  continuitySummary: z.string().trim().min(1).max(500),
  pendingDecision: z.string().trim().min(1).max(300).nullable(),
  criticalResources: z.array(publicResourceSchema).max(3),
  narrationClassification: z.enum([
    'NONE',
    'COMPACT',
    'STANDARD',
    'IMPORTANT',
    'CRITICAL',
    'PLAYER_DECISION_REQUIRED',
  ]),
}).strict();

const widgetActiveContextSchema = z.object({
  campaign: authorizedCampaignOptionSchema.omit({ characters: true }),
  character: authorizedCharacterOptionSchema.nullable(),
  resources: z.array(publicResourceSchema).max(3),
  readOnly: z.literal(true),
}).strict();

const persistedGameSessionSchema = z.object({
  status: z.enum(['NONE', 'ACTIVE', 'UNAVAILABLE']),
  stateVersion: z.number().int().min(0),
  canContinue: z.boolean(),
  selection: z.object({
    campaignSelectionRef: authorizedSelectionRefSchema,
    characterSelectionRef: authorizedSelectionRefSchema,
  }).strict().nullable(),
  lastAction: observedActionReferenceSchema.nullable(),
}).strict();

export const widgetContextSchema = z.object({
  banner: z.string().trim().min(1).max(100),
  connectedPlayer: z.string().trim().min(1).max(200).nullable(),
  campaigns: z.array(authorizedCampaignOptionSchema).max(20),
  activeContext: widgetActiveContextSchema.nullable(),
  gameSession: persistedGameSessionSchema,
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
      canMutate: z.boolean(),
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
    label: z.string().trim().min(1).max(100),
  }).strict(),
}).strict();

const publicEnvironmentSchema = z.object({
  appEnvironment: z.enum(['local', 'test', 'staging', 'production']),
  runtimeMode: z.enum(['development', 'test', 'production']),
  syntheticAccount: z.boolean(),
}).strict();

export const authenticatedGameContextSchema = z.object({
  authState: z.enum([
    'AUTHENTICATED_NO_PLAYER',
    'AUTHENTICATED',
    'AUTHORIZATION_ERROR',
  ]),
  player: z.object({
    displayName: z.string().trim().min(1).max(200),
  }).strict().nullable(),
  narrativeContext: narrativeContextSchema.nullable(),
  widgetContext: widgetContextSchema,
  environment: publicEnvironmentSchema,
}).strict();

export const loadAuthenticatedGameContextInputSchema = z.object({
  campaignSelectionRef: authorizedSelectionRefSchema.optional(),
  characterSelectionRef: authorizedSelectionRefSchema.optional(),
}).strict();

export type AuthenticatedGameContextDto = z.infer<typeof authenticatedGameContextSchema>;
export type LoadAuthenticatedGameContextInput = z.infer<typeof loadAuthenticatedGameContextInputSchema>;

export function authorizationErrorContext(
  appEnvironment: z.infer<typeof publicEnvironmentSchema>['appEnvironment'],
  runtimeMode: z.infer<typeof publicEnvironmentSchema>['runtimeMode'],
): AuthenticatedGameContextDto {
  return authenticatedGameContextSchema.parse({
    authState: 'AUTHORIZATION_ERROR',
    player: null,
    narrativeContext: null,
    widgetContext: {
      banner: appEnvironment === 'staging'
        ? 'STAGING — CONTA SINTÉTICA'
        : `${appEnvironment.toUpperCase()} — CONTEXTO AUTENTICADO`,
      connectedPlayer: null,
      campaigns: [],
      activeContext: null,
      sessionState: 'AUTHORIZATION_ERROR',
      navigation: {
        canSelectCampaign: false,
        canSelectCharacter: false,
        canViewContext: false,
        canMutate: false,
        canPersistSelection: false,
        canContinue: false,
      },
      cta: {
        kind: 'RECONNECT',
        label: 'Reconectar com segurança',
      },
      gameSession: {
        status: 'NONE',
        stateVersion: 0,
        canContinue: false,
        selection: null,
        lastAction: null,
      },
    },
    environment: {
      appEnvironment,
      runtimeMode,
      syntheticAccount: appEnvironment === 'staging',
    },
  });
}
