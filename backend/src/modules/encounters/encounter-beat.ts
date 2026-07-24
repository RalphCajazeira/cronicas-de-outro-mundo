import {
  calculateMovement,
  resolveCoreV1DeterministicReactionOutcome,
  zoneDistance,
  type CoreV1EncounterActionDefinition,
  type CoreV1EncounterActionIntent,
  type CoreV1EncounterBatchResult,
  type CoreV1EncounterState,
  type CoreV1EncounterTargetingContext,
  type CombatZone,
  type ReactionOutcomeResolver,
} from '../rules/core-v1/index.js';
import type { PersistedEncounterAuthority } from './encounter-state-loader.js';
import {
  ENCOUNTER_MAX_DETAILED_ACTIONS_PER_CATEGORY,
  ENCOUNTER_MAX_PROJECTED_ACTIONS,
  type EncounterActionCatalog,
} from './encounter-action-loader.js';
import { EncounterError } from './encounter.errors.js';
import { ENCOUNTER_TRANSACTION_OPTIONS } from './encounter.repository.js';
import { observeOperationStageSync } from '../../shared/observability/operation-observability.js';
import type {
  EncounterBeatComponent,
  EncounterContextV1,
  EncounterGenericAction,
  EncounterNpcDirective,
  EncounterScenePackageDto,
} from './encounter.types.js';

export const ENCOUNTER_GENERIC_ACTIONS: readonly EncounterGenericAction[] = [
  'move', 'defend', 'protect', 'prepare', 'intercept', 'assist', 'flee',
  'observe', 'interact', 'improvise', 'use_item', 'attack', 'cast',
];
export const ENCOUNTER_COMMON_SCENE_TARGET_BYTES = 65_536;
export const ENCOUNTER_GROUP_SCENE_TARGET_BYTES = 131_072;
export const ENCOUNTER_MAX_SCENE_RESPONSE_BYTES = 262_144;

const encounterZoneOrder = ['engaged', 'near', 'medium', 'far', 'out_of_range'] as const;

export type EncounterFleeDestination = 'far' | 'out_of_range';

export type EncounterFleeStep =
  | {
    readonly status: 'completed';
    readonly from: CombatZone;
    readonly desiredDestination: EncounterFleeDestination;
  }
  | {
    readonly status: 'step';
    readonly from: CombatZone;
    readonly to: CombatZone;
    readonly desiredDestination: EncounterFleeDestination;
    readonly movementKind: 'run' | 'disengage';
    readonly transitions: number;
    readonly reachesDestination: boolean;
  };

export function deriveEncounterFleeStep(
  currentZone: CombatZone,
  desiredDestination: EncounterFleeDestination = 'out_of_range',
): EncounterFleeStep {
  const currentIndex = encounterZoneOrder.indexOf(currentZone);
  const desiredIndex = encounterZoneOrder.indexOf(desiredDestination);
  if (currentIndex >= desiredIndex) {
    return { status: 'completed', from: currentZone, desiredDestination };
  }
  const destinationIndex = currentZone === 'engaged'
    ? encounterZoneOrder.indexOf('near')
    : Math.min(currentIndex + 2, desiredIndex);
  const to = encounterZoneOrder[destinationIndex];
  if (to === undefined) throw new TypeError('Flee destination is outside the encounter zone model');
  return {
    status: 'step',
    from: currentZone,
    to,
    desiredDestination,
    movementKind: currentZone === 'engaged' ? 'disengage' : 'run',
    transitions: zoneDistance(currentZone, to),
    reachesDestination: to === desiredDestination,
  };
}

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
  options: {
    readonly lifecycleStatus?: string;
    readonly context?: EncounterContextV1;
    readonly actionCatalog?: ReadonlyMap<string, EncounterActionCatalog>;
  } = {},
): EncounterScenePackageDto {
  return observeOperationStageSync('encounter_capsule_assembly', () => {
    const context = options.context;
    const emptyCatalog: EncounterActionCatalog = { attacks: [], abilities: [], items: [] };
    const catalogByActor = new Map(state.participants.map((participant) => [
      participant.actorRef,
      options.actionCatalog?.get(participant.actorRef) ?? emptyCatalog,
    ]));
    const controlledActorRefs = new Set(state.participants
      .filter((participant, index) => state.partySideRef === null
        ? index === 0 : participant.sideRef === state.partySideRef)
      .map((participant) => participant.actorRef));
    const categories = ['attacks', 'abilities', 'items'] as const;
    const sourceActionCount = [...catalogByActor.values()].reduce((total, catalog) => (
      total + categories.reduce((actorTotal, category) => actorTotal + catalog[category].length, 0)
    ), 0);
    const usableDetailedCount = [...catalogByActor].reduce((total, [actorRef, catalog]) => (
      controlledActorRefs.has(actorRef)
        ? total + categories.reduce((actorTotal, category) => (
          actorTotal + catalog[category].filter((action) => action.canUse).length
        ), 0)
        : total
    ), 0);
    let remainingBlockedBudget = Math.max(0, ENCOUNTER_MAX_PROJECTED_ACTIONS - usableDetailedCount);
    let omittedBlockedActionCount = 0;
    const detailedCatalogs = new Map<string, EncounterActionCatalog>();
    const summarizedActorRefs: string[] = [];
    const summarizedCategories = new Set<(typeof categories)[number]>();
    for (const participant of state.participants) {
      const catalog = catalogByActor.get(participant.actorRef) ?? emptyCatalog;
      if (!controlledActorRefs.has(participant.actorRef)) {
        summarizedActorRefs.push(participant.actorRef);
        for (const category of categories) {
          if (catalog[category].length > 0) summarizedCategories.add(category);
        }
        continue;
      }
      const selected = Object.fromEntries(categories.map((category) => {
        const usable = catalog[category].filter((action) => action.canUse);
        const blocked = catalog[category].filter((action) => !action.canUse);
        const categoryBudget = Math.max(0, ENCOUNTER_MAX_DETAILED_ACTIONS_PER_CATEGORY[category] - usable.length);
        const allowedBlocked = Math.min(blocked.length, categoryBudget, remainingBlockedBudget);
        remainingBlockedBudget -= allowedBlocked;
        omittedBlockedActionCount += blocked.length - allowedBlocked;
        if (allowedBlocked < blocked.length) summarizedCategories.add(category);
        return [category, [...usable, ...blocked.slice(0, allowedBlocked)]];
      })) as unknown as EncounterActionCatalog;
      detailedCatalogs.set(participant.actorRef, selected);
    }
    const detailedActionCount = [...detailedCatalogs.values()].reduce((total, catalog) => (
      total + categories.reduce((actorTotal, category) => actorTotal + catalog[category].length, 0)
    ), 0);
    const scene: EncounterScenePackageDto = {
    schemaVersion: 2,
    encounterRef: state.encounterRef,
    stateVersion: state.stateVersion,
    lifecycleStatus: options.lifecycleStatus ?? state.status,
    objective: context?.objective ?? null,
    genericActions: [...ENCOUNTER_GENERIC_ACTIONS],
    processingLimits: {
      maximumBeatsPerCall: 12,
      maximumComponentsPerBeat: 3,
      maximumNpcActionsPerBeat: 4,
      maximumEventsPerCheckpoint: 32,
      maximumProjectedActions: ENCOUNTER_MAX_PROJECTED_ACTIONS,
      maximumSceneBytes: ENCOUNTER_MAX_SCENE_RESPONSE_BYTES,
      maximumTransactionDurationMs: ENCOUNTER_TRANSACTION_OPTIONS.timeout,
    },
    mandatoryStopConditions: [
      'terminal_candidate',
      'actor_incapacitated',
      'hp_policy_threshold',
      'protected_actor_at_risk',
      'rare_or_irreversible_resource_required',
      'new_threat_or_participant',
      'objective_changed',
      'no_valid_action',
      'material_narrative_choice',
      'authority_or_version_conflict',
      'processing_budget',
    ],
    catalogProjection: {
      status: summarizedActorRefs.length > 0 || omittedBlockedActionCount > 0 ? 'partial' : 'complete',
      sourceActionCount,
      detailedActionCount,
      omittedBlockedActionCount,
      summarizedActorRefs: summarizedActorRefs.sort(),
      summarizedCategories: [...summarizedCategories].sort(),
    },
    environment: {
      zoneModel: 'abstract_bands',
      summary: context?.environment.summary ?? null,
      tags: [...(context?.environment.tags ?? [])],
      notes: [
        'Positions use engaged, near, medium, far and out_of_range bands.',
        'Exact geometry and scene objects are not inferred; use explicit target references.',
      ],
    },
    participants: state.participants.map((participant) => {
      const authority = authorities.get(participant.actorRef);
      const metadata = record(authority?.actor.metadata);
      const personality = authority?.actor.personality;
      const actionCatalog = options.actionCatalog?.get(participant.actorRef)
        ?? { attacks: [], abilities: [], items: [] };
      const detailedCatalog = detailedCatalogs.get(participant.actorRef);
      const fullCatalog = detailedCatalog !== undefined;
      const relationRows = state.participants.filter((target) => target.actorRef !== participant.actorRef).map((target) => ({
        actorRef: target.actorRef,
        relation: relation(state, participant.actorRef, target.actorRef),
      })).sort((left, right) => left.actorRef.localeCompare(right.actorRef));
      const relations = {
        allies: relationRows.filter((entry) => entry.relation === 'ally').map((entry) => entry.actorRef),
        hostiles: relationRows.filter((entry) => entry.relation === 'hostile').map((entry) => entry.actorRef),
        neutrals: relationRows.filter((entry) => entry.relation === 'neutral').map((entry) => entry.actorRef),
      };
      const movements = encounterZoneOrder.filter((zone) => zone !== participant.zone).map((destination) => {
        const fleeStep = destination === 'far' || destination === 'out_of_range'
          ? deriveEncounterFleeStep(participant.zone, destination)
          : undefined;
        const kind = fleeStep?.status === 'step' && fleeStep.to === destination
          ? fleeStep.movementKind
          : movementKind(participant.zone, destination);
        const distance = zoneDistance(participant.zone, destination);
        const maximum = kind === 'run' ? 2 : 1;
        const movement = distance <= maximum
          ? calculateMovement(participant.zone, destination, kind, 'normal')
          : undefined;
        const blockers = [
          ...(distance <= maximum ? [] : ['destination_too_far_for_one_movement']),
          ...(movement !== undefined && participant.resources.sp.current < movement.conceptualSpCost
            ? ['insufficient_sp'] : []),
        ];
        return {
          destination,
          movementKind: kind,
          canUse: blockers.length === 0,
          ...(blockers.length === 0 ? {} : { blockers }),
        };
      });
      const equippedEntryRefs = participant.equipmentContext.loadout.slots
        .flatMap((slot) => slot.entryRef === null ? [] : [slot.entryRef])
        .filter((entryRef, index, refs) => refs.indexOf(entryRef) === index).sort();
      const knownContentRefs = participant.equipmentContext.requirements.knownContentRefs
        .map((content) => ({ contentType: content.contentKind, code: content.code }))
        .sort((left, right) => `${left.contentType}:${left.code}`.localeCompare(`${right.contentType}:${right.code}`));
      const activeEffects = participant.activeEffects.map((effect) => ({
        effectRef: effect.effectRef,
        kind: effect.kind,
        stacks: effect.stacks,
        durationType: effect.durationState.type,
      })).sort((left, right) => left.effectRef.localeCompare(right.effectRef));
      const preparedActionRefs = state.actionPlans
        .filter((plan) => plan.actorRef === participant.actorRef && plan.planRef.startsWith('prepared-'))
        .map((plan) => plan.planRef).sort();
      const tacticalStrategy = text(metadata.tactic) ?? text(metadata.strategy);
      const tacticalObjective = text(metadata.objective);
      const tacticalFaction = text(metadata.faction);
      const tacticalTraits = traits(personality);
      const tacticalProfile = {
        ...(tacticalStrategy === null ? {} : { strategy: tacticalStrategy }),
        ...(tacticalObjective === null ? {} : { objective: tacticalObjective }),
        ...(tacticalFaction === null ? {} : { faction: tacticalFaction }),
        ...(tacticalTraits.length === 0 ? {} : { traits: tacticalTraits }),
      };
      const counts = (category: (typeof categories)[number]) => ({
        total: actionCatalog[category].length,
        usable: actionCatalog[category].filter((action) => action.canUse).length,
      });
      return {
        actorRef: participant.actorRef,
        role: authority?.actor.role ?? null,
        sideRef: participant.sideRef,
        relations,
        zone: participant.zone,
        combatState: participant.combatState,
        resources: {
          hp: { ...participant.resources.hp },
          mana: { ...participant.resources.mana },
          sp: { ...participant.resources.sp },
        },
        ...(equippedEntryRefs.length === 0 ? {} : { equippedEntryRefs }),
        ...(knownContentRefs.length === 0 ? {} : { knownContentRefs }),
        ...(activeEffects.length === 0 ? {} : { activeEffects }),
        ...(preparedActionRefs.length === 0 ? {} : { preparedActionRefs }),
        validThreatRefs: [...relations.hostiles],
        usableActions: {
          catalogMode: fullCatalog ? 'full' : 'summary',
          attacks: (detailedCatalog?.attacks ?? []).map((action) => structuredClone(action)),
          abilities: (detailedCatalog?.abilities ?? []).map((action) => structuredClone(action)),
          items: (detailedCatalog?.items ?? []).map((action) => structuredClone(action)),
          ...(fullCatalog ? {} : { summary: {
            attacks: counts('attacks'),
            abilities: counts('abilities'),
            items: counts('items'),
          } }),
          movements,
          reactions: participant.reactionCapabilities.map((capability) => ({
            kind: capability.kind,
            cost: capability.cost.type === 'active_defense'
              ? { type: 'sp' as const, amount: capability.cost.sp }
              : { type: 'unsupported' as const },
            canUse: capability.cost.type !== 'active_defense'
              || participant.resources.sp.current >= capability.cost.sp,
            ...(capability.cost.type === 'active_defense'
              && participant.resources.sp.current < capability.cost.sp
              ? { blockers: ['insufficient_sp'] } : {}),
          })),
        },
        ...(Object.keys(tacticalProfile).length === 0 ? {} : { tacticalProfile }),
      };
    }),
  };
  const sceneBytes = Buffer.byteLength(JSON.stringify(scene), 'utf8');
  if (sceneBytes > ENCOUNTER_MAX_SCENE_RESPONSE_BYTES) {
    throw new EncounterError('ENCOUNTER_CORE_REJECTED', {
      issues: [{
        path: 'scene',
        code: 'SCENE_RESPONSE_LIMIT',
        message: `The authoritative encounter capsule is ${String(sceneBytes)} UTF-8 bytes and exceeds the ${String(ENCOUNTER_MAX_SCENE_RESPONSE_BYTES)}-byte hard cap.`,
      }],
    });
  }
  return scene;
  });
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
  return encounterZoneOrder.indexOf(to) > encounterZoneOrder.indexOf(from) ? 'retreat' : 'approach';
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
  let destination: CombatZone;
  let kind: 'approach' | 'retreat' | 'run' | 'disengage';
  if (component.type === 'flee') {
    const step = deriveEncounterFleeStep(actor.zone, component.destination ?? 'out_of_range');
    if (step.status === 'completed') return fallback;
    destination = step.to;
    kind = step.movementKind;
  } else {
    destination = component.destination;
    kind = component.movementKind ?? movementKind(actor.zone, destination);
  }
  try {
    const movement = calculateMovement(actor.zone, destination, kind, 'normal');
    return actor.resources.sp.current < movement.conceptualSpCost
      ? 'resource_below_required'
      : fallback;
  } catch {
    return 'distance_incompatible';
  }
}

export function normalizeBeatComponent(
  state: CoreV1EncounterState,
  actorRef: string,
  component: EncounterBeatComponent,
): {
  readonly component: EncounterBeatComponent;
  readonly modification?: { readonly code: string; readonly reason: string; readonly field: string };
  readonly completedFlee?: true;
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
  if (component.type === 'flee') {
    const desiredDestination = component.destination ?? 'out_of_range';
    const step = deriveEncounterFleeStep(actor.zone, desiredDestination);
    if (step.status === 'completed') {
      return {
        component: { ...component, destination: desiredDestination },
        completedFlee: true,
        modification: {
          code: 'FLEE_ALREADY_COMPLETE',
          reason: `The actor is already at or beyond the requested ${desiredDestination} escape destination.`,
          field: 'destination',
        },
      };
    }
    const applied: EncounterBeatComponent = {
      type: 'move',
      destination: step.to,
      movementKind: step.movementKind,
      ...(component.essential === undefined ? {} : { essential: component.essential }),
      ...(component.when === undefined ? {} : { when: component.when }),
      ...(component.fallback === undefined ? {} : { fallback: component.fallback }),
    };
    if (!step.reachesDestination) {
      return {
        component: applied,
        modification: {
          code: 'FLEE_STAGED',
          reason: `Flee toward ${desiredDestination} was staged as a legal ${step.movementKind} step to ${step.to}.`,
          field: 'destination',
        },
      };
    }
    if (component.destination === undefined) {
      return {
        component: applied,
        modification: {
          code: 'FLEE_DESTINATION_DEFAULTED',
          reason: 'Flee destination was defaulted to out_of_range.',
          field: 'destination',
        },
      };
    }
    return {
      component: applied,
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
