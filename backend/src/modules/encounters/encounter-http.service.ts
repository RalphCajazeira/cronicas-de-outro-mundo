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
          return toEncounterPublicDto(await internal.create({
            playerRef: input.playerRef,
            worldRef: input.worldRef,
            campaignRef: input.campaignRef,
            encounterRef: input.encounterRef,
            idempotencyKey: input.idempotencyKey,
            ...(input.partySideRef === undefined ? {} : { partySideRef: input.partySideRef }),
            participants: input.participants.map((participant) => ({
              bindingKind: 'persisted_actor' as const,
              actorRef: participant.actorRef,
              sideRef: participant.sideRef,
              zone: participant.zone,
              ...(participant.surprised === undefined ? {} : { surprised: participant.surprised }),
            })),
            relations: buildEncounterRelations(input),
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
