import {
  resolveCoreV1DeterministicReactionOutcome,
  type CoreV1EncounterActionDefinition,
  type CoreV1EncounterActionIntent,
  type CoreV1EncounterBatchResult,
  type CoreV1EncounterState,
  type CoreV1EncounterTargetingContext,
  type ReactionOutcomeResolver,
} from '../rules/core-v1/index.js';
import type { PersistedEncounterAuthority } from './encounter-state-loader.js';
import type {
  EncounterBeatComponent,
  EncounterGenericAction,
  EncounterNpcDirective,
  EncounterScenePackageDto,
} from './encounter.types.js';

export const ENCOUNTER_GENERIC_ACTIONS: readonly EncounterGenericAction[] = [
  'move', 'defend', 'protect', 'prepare', 'intercept', 'assist', 'flee',
  'observe', 'interact', 'improvise', 'use_item', 'attack', 'cast',
];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

function traits(value: unknown): string[] {
  const values = record(value).traits;
  return Array.isArray(values)
    ? values.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= 160).slice(0, 16)
    : [];
}

export function encounterScenePackage(
  state: CoreV1EncounterState,
  authorities: ReadonlyMap<string, PersistedEncounterAuthority>,
): EncounterScenePackageDto {
  return {
    schemaVersion: 1,
    stateVersion: state.stateVersion,
    genericActions: [...ENCOUNTER_GENERIC_ACTIONS],
    environment: {
      zoneModel: 'abstract_bands',
      notes: [
        'Positions use engaged, near, medium, far and out_of_range bands.',
        'Exact geometry and scene objects are not inferred; use explicit target references.',
      ],
    },
    participants: state.participants.map((participant) => {
      const authority = authorities.get(participant.actorRef);
      const metadata = record(authority?.actor.metadata);
      const personality = authority?.actor.personality;
      return {
        actorRef: participant.actorRef,
        role: authority?.actor.role ?? null,
        zone: participant.zone,
        equippedEntryRefs: participant.equipmentContext.loadout.slots
          .flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef]).filter((entryRef, index, refs) => refs.indexOf(entryRef) === index).sort(),
        knownContentRefs: participant.equipmentContext.requirements.knownContentRefs
          .map((content) => ({ contentType: content.contentKind, code: content.code }))
          .sort((left, right) => `${left.contentType}:${left.code}`.localeCompare(`${right.contentType}:${right.code}`)),
        activeEffectRefs: participant.activeEffects.map((effect) => effect.effectRef).sort(),
        preparedActionRefs: state.actionPlans.filter((plan) => plan.actorRef === participant.actorRef).map((plan) => plan.planRef).sort(),
        tacticalProfile: {
          strategy: text(metadata.tactic) ?? text(metadata.strategy),
          objective: text(metadata.objective),
          faction: text(metadata.faction),
          traits: traits(personality),
        },
      };
    }),
  };
}

function relation(state: CoreV1EncounterState, sourceActorRef: string, targetActorRef: string) {
  if (sourceActorRef === targetActorRef) return 'self' as const;
  return state.relations.find((entry) => (
    entry.leftActorRef === sourceActorRef && entry.rightActorRef === targetActorRef
  ) || (
    entry.rightActorRef === sourceActorRef && entry.leftActorRef === targetActorRef
  ))?.relation ?? 'neutral';
}

export function encounterTargetingContext(
  state: CoreV1EncounterState,
  sourceActorRef: string,
): CoreV1EncounterTargetingContext {
  return {
    candidates: state.participants.map((participant, stableOrder) => ({
      actorRef: participant.actorRef,
      relation: relation(state, sourceActorRef, participant.actorRef),
      rangeBand: participant.zone,
      targetable: participant.combatState !== 'removed',
      active: participant.combatState !== 'removed' && participant.resources.hp.current > 0,
      hpCurrent: participant.resources.hp.current,
      hpMaximum: participant.resources.hp.maximum,
      stableOrder,
    })),
  };
}

function movementKind(
  from: CoreV1EncounterState['participants'][number]['zone'],
  to: CoreV1EncounterState['participants'][number]['zone'],
): 'approach' | 'retreat' | 'run' | 'disengage' {
  if (from === 'engaged' && to !== 'engaged') return 'disengage';
  if (to === 'out_of_range') return 'run';
  const order = ['engaged', 'near', 'medium', 'far', 'out_of_range'];
  return order.indexOf(to) > order.indexOf(from) ? 'retreat' : 'approach';
}

export function beatComponentRejectionReason(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
  fallback: string,
): string {
  if (component.type !== 'move' && component.type !== 'flee') return fallback;
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) return fallback;
  const destination = component.type === 'move' ? component.destination : component.destination ?? 'out_of_range';
  const order = ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const;
  const transitions = Math.abs(order.indexOf(actor.zone) - order.indexOf(destination));
  const kind = component.type === 'move' && component.movementKind !== undefined
    ? component.movementKind : movementKind(actor.zone, destination);
  const maximumTransitions = kind === 'run' ? 2 : 1;
  return transitions < 1 || transitions > maximumTransitions ? 'distance_incompatible' : fallback;
}

export function normalizeBeatComponent(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
): {
  readonly component: EncounterBeatComponent;
  readonly modification?: { readonly code: string; readonly reason: string; readonly field: string };
} {
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) return { component };
  if (component.type === 'move' && component.movementKind === undefined) {
    const inferred = movementKind(actor.zone, component.destination);
    return {
      component: { ...component, movementKind: inferred },
      modification: {
        code: 'MOVEMENT_KIND_INFERRED',
        reason: `Movement kind was inferred as ${inferred} from the authoritative zones.`,
        field: 'movementKind',
      },
    };
  }
  if (component.type === 'flee' && component.destination === undefined) {
    return {
      component: { ...component, destination: 'out_of_range' },
      modification: {
        code: 'FLEE_DESTINATION_DEFAULTED',
        reason: 'Flee destination was defaulted to out_of_range.',
        field: 'destination',
      },
    };
  }
  return { component };
}

export function genericEncounterAction(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
  intentRef: string,
  slotRef: string,
): {
  readonly intent: CoreV1EncounterActionIntent;
  readonly definition: CoreV1EncounterActionDefinition;
  readonly targetingContext: CoreV1EncounterTargetingContext;
} {
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) throw new TypeError('Beat actor is not an encounter participant');
  const destination = component.type === 'move' ? component.destination
    : component.type === 'flee' ? component.destination ?? 'out_of_range' : undefined;
  const targetRef = 'targetRef' in component ? component.targetRef : undefined;
  const intent: CoreV1EncounterActionIntent = {
    intentRef,
    sourceActorRef: actorRef,
    slotRef,
    actionSource: destination === undefined ? 'wait' : 'movement',
    targetSelector: targetRef === undefined ? 'self' : 'explicit',
    requestedTargetRefs: targetRef === undefined ? [] : [targetRef],
  };
  const definition: CoreV1EncounterActionDefinition = {
    actionSource: intent.actionSource,
    actionKind: destination === undefined ? 'wait' : 'movement',
    actionTags: destination === undefined ? ['minor'] : ['movement'],
    fullPrimaryAction: false,
    allowedRelations: targetRef === undefined ? ['self'] : ['self', 'ally', 'neutral', 'hostile'],
    effectRefs: [],
    defenses: {},
    ...(destination === undefined ? {} : { movement: {
      kind: component.type === 'move' && component.movementKind !== undefined
        ? component.movementKind : movementKind(actor.zone, destination),
      from: actor.zone,
      to: destination,
      terrain: 'normal' as const,
    } }),
    interruptible: false,
    blockable: false,
    dodgeable: false,
    canRetargetBeforeEffect: false,
  };
  return { intent, definition, targetingContext: encounterTargetingContext(state, actorRef) };
}

export function automaticReactionResolver(): ReactionOutcomeResolver {
  return {
    resolve(request) {
      const participant = request.encounter.participants.find((entry) => entry.actorRef === request.reactorActorRef);
      const capability = participant?.reactionCapabilities.find((entry) => entry.kind === request.reactionKind);
      if (capability === undefined) throw new TypeError('Automatic reaction has no authoritative capability');
      return resolveCoreV1DeterministicReactionOutcome(capability);
    },
  };
}

export function applyBeatGuardCapabilities(
  state: CoreV1EncounterState,
  actorRef: string,
  components: readonly EncounterBeatComponent[],
  suffix: string,
): CoreV1EncounterState {
  let changed = false;
  const participants = state.participants.map((participant) => {
    const additions = components.flatMap((component, index) => {
      const targetRef = component.type === 'defend' ? actorRef
        : component.type === 'protect' || component.type === 'intercept' ? component.targetRef : undefined;
      if (participant.actorRef !== targetRef) return [];
      const kind = component.type === 'intercept' ? 'interrupt' as const : 'block' as const;
      const source = state.participants.find((entry) => entry.actorRef === actorRef);
      if (source === undefined) return [];
      changed = true;
      return [{
        capabilityRef: `beat-${component.type}-${suffix}-${index}`,
        kind,
        tier: 1,
        cost: { type: 'active_defense' as const, sp: 2 },
        ...(kind === 'block' ? { blockValue: Math.max(1, source.secondaryAttributes.physicalDefense) } : {}),
      }];
    });
    return additions.length === 0 ? participant : {
      ...participant,
      reactionCapabilities: [
        ...participant.reactionCapabilities.filter((capability) => !capability.capabilityRef.startsWith('beat-')),
        ...additions,
      ].sort((left, right) => left.capabilityRef.localeCompare(right.capabilityRef)),
    };
  });
  return changed ? { ...state, stateVersion: state.stateVersion + 1, participants } : state;
}

export function consumeTriggeredBeatCapabilities(
  state: CoreV1EncounterState,
  batch: CoreV1EncounterBatchResult,
): CoreV1EncounterState {
  const reactors = new Set(batch.processedEvents.flatMap((event) => (
    event.type === 'reaction_resolved' || event.type === 'counter_attack_started'
      ? [event.targetRef ?? event.timelineEvent.actorRef] : []
  )));
  if (reactors.size === 0) return state;
  let changed = false;
  const participants = state.participants.map((participant) => {
    if (!reactors.has(participant.actorRef)) return participant;
    const reactionCapabilities = participant.reactionCapabilities.filter((capability) => !capability.capabilityRef.startsWith('beat-'));
    if (reactionCapabilities.length === participant.reactionCapabilities.length) return participant;
    changed = true;
    return { ...participant, reactionCapabilities };
  });
  return changed ? { ...state, stateVersion: state.stateVersion + 1, participants } : state;
}

function equippedWeaponEntryRef(state: CoreV1EncounterState, actorRef: string): string | undefined {
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) return undefined;
  const equipped = new Set(actor.equipmentContext.loadout.slots.flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef]));
  return actor.equipmentContext.inventory.entries.find((entry) => (
    equipped.has(entry.entryRef) && entry.profile?.contentKind === 'weapon'
  ))?.entryRef;
}

function metadataStrategy(authority: PersistedEncounterAuthority | undefined): string | undefined {
  const metadata = record(authority?.actor.metadata);
  return text(metadata.tactic) ?? text(metadata.strategy) ?? undefined;
}

export function selectNpcBeatComponent(
  state: CoreV1EncounterState,
  actorRef: string,
  primaryActorRef: string,
  authority: PersistedEncounterAuthority | undefined,
  directive?: EncounterNpcDirective,
): { readonly strategy: string; readonly component: EncounterBeatComponent; readonly targetRef?: string } {
  const actor = state.participants.find((participant) => participant.actorRef === actorRef);
  if (actor === undefined) throw new TypeError('NPC is not an encounter participant');
  const hostiles = state.participants.filter((participant) => (
    relation(state, actorRef, participant.actorRef) === 'hostile'
    && participant.combatState !== 'removed' && participant.resources.hp.current > 0
  ));
  const allies = state.participants.filter((participant) => (
    participant.actorRef !== actorRef && relation(state, actorRef, participant.actorRef) === 'ally'
    && participant.combatState !== 'removed' && participant.resources.hp.current > 0
  ));
  const strategy = directive?.strategy ?? metadataStrategy(authority)
    ?? (relation(state, actorRef, primaryActorRef) === 'hostile' ? 'aggressive' : 'defensive');
  const caster = hostiles.find((participant) => participant.equipmentContext.requirements.knownContentRefs
    .some((content) => content.contentKind === 'spell'));
  const target = directive?.targetRef === undefined
    ? strategy === 'prioritize_caster' && caster !== undefined ? caster
      : strategy === 'attack_vulnerable' ? [...hostiles].sort((left, right) => (
        left.resources.hp.current / Math.max(1, left.resources.hp.maximum)
        - right.resources.hp.current / Math.max(1, right.resources.hp.maximum)
      ))[0]
        : hostiles[0]
    : state.participants.find((participant) => participant.actorRef === directive.targetRef);
  if (strategy === 'defensive') return { strategy, component: { type: 'defend' } };
  if (strategy === 'protect_ally') {
    const protectedTarget = directive?.targetRef === undefined
      ? [...allies].sort((left, right) => left.resources.hp.current - right.resources.hp.current)[0]
      : target;
    return protectedTarget === undefined
      ? { strategy: 'defensive', component: { type: 'defend' } }
      : { strategy, component: { type: 'protect', targetRef: protectedTarget.actorRef }, targetRef: protectedTarget.actorRef };
  }
  if (strategy === 'flee_if_hurt' && actor.resources.hp.current * 4 <= actor.resources.hp.maximum) {
    return { strategy, component: { type: 'flee', destination: 'out_of_range' } };
  }
  const weapon = equippedWeaponEntryRef(state, actorRef);
  if (weapon !== undefined && target !== undefined) {
    return {
      strategy,
      component: { type: 'attack', inventoryEntryRef: weapon, targetRefs: [target.actorRef] },
      targetRef: target.actorRef,
    };
  }
  if (target !== undefined && actor.zone !== 'engaged') {
    const destination = actor.zone === 'far' || actor.zone === 'out_of_range' ? 'medium' : 'near';
    return { strategy, component: { type: 'move', destination }, targetRef: target.actorRef };
  }
  return { strategy: 'defensive', component: { type: 'defend' } };
}
