import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/json/canonical-json.js';
import type { CoreV1EncounterParticipantRelation } from '../rules/core-v1/index.js';
import { mapEncounterHttpError } from './encounter-http.errors.js';
import { toEncounterPublicDto, type EncounterPublicDto } from './encounter-http.dto.js';
import type {
  AbandonEncounterInput, CancelEncounterInput, ConfirmEncounterCompletionInput, ContinueEncounterInput, CreateEncounterInput,
  EncounterBeatComponent, EncounterNpcDirective,
  EncounterDto, LoadEncounterInput, ResolveEncounterBeatInput, ResolveEncounterReactionInput, SubmitEncounterIntentInput,
} from './encounter.types.js';
import type {
  CreateEncounterHttpInput,
  CreateAssistedEncounterHttpInput,
  ManageEncounterInput,
  SubmitIntentHttpInput,
} from './encounter-http.schemas.js';

export interface EncounterApplicationService {
  create(input: CreateEncounterInput): Promise<EncounterDto>;
  load(input: LoadEncounterInput): Promise<EncounterDto>;
  submitIntent(input: SubmitEncounterIntentInput): Promise<EncounterDto>;
  resolveReaction(input: ResolveEncounterReactionInput): Promise<EncounterDto>;
  continue(input: ContinueEncounterInput): Promise<EncounterDto>;
  confirmCompletion(input: ConfirmEncounterCompletionInput): Promise<EncounterDto>;
  cancel(input: CancelEncounterInput): Promise<EncounterDto>;
  abandon(input: AbandonEncounterInput): Promise<EncounterDto>;
  resolveBeat(input: ResolveEncounterBeatInput): Promise<EncounterDto>;
}

export interface EncounterHttpService {
  manage(input: ManageEncounterInput): Promise<EncounterPublicDto>;
}

function canonicalPair(left: string, right: string): readonly [string, string] {
  return left <= right ? [left, right] : [right, left];
}

export function buildEncounterRelations(input: CreateEncounterHttpInput): CoreV1EncounterParticipantRelation[] {
  if (!('participants' in input)) throw new TypeError('Explicit Encounter participants are required');
  if (Object.keys(input.participants).length !== input.participants.length
    || (input.relationOverrides !== undefined
      && Object.keys(input.relationOverrides).length !== input.relationOverrides.length)) {
    throw new TypeError('Encounter relation input arrays must be dense');
  }
  const overrides = new Map((input.relationOverrides ?? []).map((override) => [
    canonicalPair(override.leftActorRef, override.rightActorRef).join('\u0000'),
    override.relation,
  ]));
  const participants = [...input.participants].sort((left, right) => left.actorRef.localeCompare(right.actorRef));
  const relations: CoreV1EncounterParticipantRelation[] = [];
  for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < participants.length; rightIndex += 1) {
      const left = participants[leftIndex];
      const right = participants[rightIndex];
      if (left === undefined || right === undefined) throw new TypeError('Encounter relation input is invalid');
      const [leftActorRef, rightActorRef] = canonicalPair(left.actorRef, right.actorRef);
      const pair = `${leftActorRef}\u0000${rightActorRef}`;
      relations.push({
        leftActorRef,
        rightActorRef,
        relation: leftIndex === rightIndex ? 'self' : overrides.get(pair)
          ?? (left.sideRef === right.sideRef ? 'ally' : 'hostile'),
      });
    }
  }
  return relations.sort((left, right) => `${left.leftActorRef}\u0000${left.rightActorRef}`
    .localeCompare(`${right.leftActorRef}\u0000${right.rightActorRef}`));
}

export function buildAssistedEncounterCreateInput(
  input: CreateAssistedEncounterHttpInput,
): CreateEncounterInput {
  const zoneByPreference = {
    immediate: 'engaged',
    close: 'near',
    ranged: 'medium',
    ambush: 'engaged',
    safe_distance: 'far',
  } as const;
  const participantGroups = [
    { sideRef: 'party', actorRefs: input.partyActorRefs },
    { sideRef: 'hostile', actorRefs: input.hostileActorRefs },
    { sideRef: 'neutral', actorRefs: input.neutralActorRefs ?? [] },
  ] as const;
  const participants = participantGroups.flatMap(({ sideRef, actorRefs }) => actorRefs.map((actorRef) => ({
    bindingKind: 'persisted_actor' as const,
    actorRef,
    sideRef,
    zone: sideRef === 'neutral' ? 'far' as const : zoneByPreference[input.engagementPreference],
    ...(input.engagementPreference === 'ambush' && sideRef === 'hostile' ? { surprised: true } : {}),
  }))).sort((left, right) => left.actorRef.localeCompare(right.actorRef));
  const relations: CoreV1EncounterParticipantRelation[] = [];
  for (let leftIndex = 0; leftIndex < participants.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < participants.length; rightIndex += 1) {
      const left = participants[leftIndex];
      const right = participants[rightIndex];
      if (left === undefined || right === undefined) throw new TypeError('Assisted Encounter participant derivation failed');
      const relation = leftIndex === rightIndex ? 'self' as const
        : left.sideRef === 'neutral' || right.sideRef === 'neutral' ? 'neutral' as const
          : left.sideRef === right.sideRef ? 'ally' as const : 'hostile' as const;
      relations.push({
        leftActorRef: left.actorRef,
        rightActorRef: right.actorRef,
        relation,
      });
    }
  }
  const protectedActorRefs = [...(input.protectedActorRefs ?? [])].sort();
  const context = {
    schemaVersion: 1 as const,
    setupMode: 'assisted' as const,
    encounterKind: 'combat' as const,
    objective: input.objective,
    engagementPreference: input.engagementPreference,
    protectedActorRefs,
    environment: {
      summary: input.environmentalContext?.summary ?? null,
      tags: [...(input.environmentalContext?.tags ?? [])].sort(),
    },
  };
  return {
    playerRef: input.playerRef,
    worldRef: input.worldRef,
    campaignRef: input.campaignRef,
    encounterRef: input.encounterRef,
    idempotencyKey: input.idempotencyKey,
    setupMode: 'assisted',
    partySideRef: 'party',
    participants,
    relations,
    context,
    setupSummary: {
      setupMode: 'assisted',
      sides: participantGroups.map((group) => ({
        sideRef: group.sideRef,
        actorRefs: [...group.actorRefs].sort(),
      })).filter((group) => group.actorRefs.length > 0),
      relations,
      zones: participants.map((participant) => ({ actorRef: participant.actorRef, zone: participant.zone })),
      objective: input.objective,
      normalizations: [
        `engagement_preference:${input.engagementPreference}`,
        'bilateral_relations_canonicalized',
        'neutral_relations_preserved',
      ],
      warnings: [],
      firstAvailableActions: [],
      blockers: [],
    },
  };
}

export function deriveEncounterIntentRef(input: SubmitIntentHttpInput): string {
  const semanticInput = {
    operation: input.operation,
    playerRef: input.playerRef,
    worldRef: input.worldRef,
    campaignRef: input.campaignRef,
    encounterRef: input.encounterRef,
    idempotencyKey: input.idempotencyKey,
    expectedStateVersion: input.expectedStateVersion,
    intent: input.intent,
  };
  const digest = createHash('sha256')
    .update('encounter-http-intent-v1\u0000')
    .update(canonicalJson(semanticInput))
    .digest('hex');
  return `intent-${digest}`;
}

export function createEncounterHttpService(internal: EncounterApplicationService): EncounterHttpService {
  return {
    async manage(input) {
      try {
        if (input.operation === 'create') {
          if (input.setupMode === 'assisted') {
            return toEncounterPublicDto(await internal.create(buildAssistedEncounterCreateInput(input)));
          }
          return toEncounterPublicDto(await internal.create({
            playerRef: input.playerRef,
            worldRef: input.worldRef,
            campaignRef: input.campaignRef,
            encounterRef: input.encounterRef,
            idempotencyKey: input.idempotencyKey,
            setupMode: 'explicit',
            ...(input.partySideRef === undefined ? {} : { partySideRef: input.partySideRef }),
            participants: input.participants.map((participant) => ({
              bindingKind: 'persisted_actor' as const,
              actorRef: participant.actorRef,
              sideRef: participant.sideRef,
              zone: participant.zone,
              ...(participant.surprised === undefined ? {} : { surprised: participant.surprised }),
            })),
            relations: buildEncounterRelations(input),
            context: {
              schemaVersion: 1,
              setupMode: 'explicit',
              encounterKind: 'combat',
              objective: null,
              engagementPreference: 'explicit',
              protectedActorRefs: [],
              environment: { summary: null, tags: [] },
            },
          }));
        }
        if (input.operation === 'load') {
          return toEncounterPublicDto(await internal.load({
            playerRef: input.playerRef, worldRef: input.worldRef,
            campaignRef: input.campaignRef, encounterRef: input.encounterRef,
          }));
        }
        const reference = {
          playerRef: input.playerRef,
          worldRef: input.worldRef,
          campaignRef: input.campaignRef,
          encounterRef: input.encounterRef,
          idempotencyKey: input.idempotencyKey,
          expectedStateVersion: input.expectedStateVersion,
        };
        if (input.operation === 'resolve_beat') {
          if ('policy' in input) {
            return toEncounterPublicDto(await internal.resolveBeat({
              ...reference,
              policy: {
                actorRef: input.policy.actorRef,
                mode: input.policy.mode,
                strategy: input.policy.strategy,
                objective: input.policy.objective,
                targetPriority: input.policy.targetPriority,
                ...(input.policy.targetRefs === undefined ? {} : { targetRefs: input.policy.targetRefs }),
                protectedActorRefs: input.policy.protectedActorRefs ?? [],
                maximumBeats: input.policy.maximumBeats,
                resourcePolicy: input.policy.resourcePolicy ?? {
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
                },
              },
            }));
          }
          return toEncounterPublicDto(await internal.resolveBeat({
            ...reference,
            intent: {
              actorRef: input.intent.actorRef,
              objective: input.intent.objective,
              narrative: input.intent.narrative,
              resolutionPolicy: input.intent.resolutionPolicy,
              components: input.intent.components.map((component) => Object.fromEntries(
                Object.entries(component).filter(([, value]) => value !== undefined),
              ) as unknown as EncounterBeatComponent),
            },
            npcDirectives: input.npcDirectives?.map((directive) => Object.fromEntries(
              Object.entries(directive).filter(([, value]) => value !== undefined),
            ) as unknown as EncounterNpcDirective) ?? [],
          }));
        }
        if (input.operation === 'submit_intent') {
          return toEncounterPublicDto(await internal.submitIntent({
            ...reference,
            intent: {
              intentRef: deriveEncounterIntentRef(input),
              sourceActorRef: input.intent.actorRef,
              slotRef: input.intent.slotRef,
              actionSource: input.intent.actionSource,
              targetSelector: input.intent.targetSelector,
              requestedTargetRefs: input.intent.targetRefs ?? [],
              ...(input.intent.contentRef === undefined ? {} : { contentRef: input.intent.contentRef }),
              ...(input.intent.inventoryEntryRef === undefined ? {} : { weaponEntryRef: input.intent.inventoryEntryRef }),
              ...(input.intent.versatileMode === undefined ? {} : { versatileMode: input.intent.versatileMode }),
            },
          }));
        }
        if (input.operation === 'resolve_reaction') {
          return toEncounterPublicDto(await internal.resolveReaction({
            ...reference, reactorActorRef: input.reactorRef, reactionKind: input.reactionKind,
          }));
        }
        if (input.operation === 'continue') return toEncounterPublicDto(await internal.continue(reference));
        if (input.operation === 'confirm_completion') {
          return toEncounterPublicDto(await internal.confirmCompletion(reference));
        }
        if (input.operation === 'abandon') {
          return toEncounterPublicDto(await internal.abandon({ ...reference, confirmAuthorityDrift: true }));
        }
        return toEncounterPublicDto(await internal.cancel(reference));
      } catch (error) {
        throw mapEncounterHttpError(error);
      }
    },
  };
}
