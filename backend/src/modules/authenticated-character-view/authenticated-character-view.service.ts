import { createHash } from 'node:crypto';
import {
  ActorControlPermission,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import {
  calculateInventoryEncumbrance,
  validateCoreV1InventorySpec,
} from '../rules/core-v1/index.js';
import { validateCoreV1ContentProfile } from '../rules/core-v1/core-v1.content-mechanics.js';
import type {
  CoreV1ContentProfile,
  CoreV1Effect,
  CoreV1MechanicalContentProfile,
  CoreV1Requirements,
  CoreV1Targeting,
} from '../rules/core-v1/core-v1.content-mechanics.types.js';
import type { CoreV1InventorySpec } from '../rules/core-v1/core-v1.inventory.types.js';
import type { CoreV1Cost } from '../rules/core-v1/core-v1.types.js';
import { AuthenticatedGameContextAccessError } from '../authenticated-game-context/authenticated-game-context.errors.js';
import { authenticatedSelectionRef } from '../authenticated-game-context/authenticated-selection-ref.js';
import type { AuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.types.js';
import {
  authenticatedCharacterViewSchema,
  type AbilitiesView,
  type AuthenticatedCharacterViewDto,
  type AuthenticatedCharacterViewName,
  type CharacterSheetView,
  type EquipmentView,
  type InventoryView,
  type LoadAuthenticatedCharacterViewInput,
} from './authenticated-character-view.dto.js';
import type {
  AuthenticatedCharacterSnapshot,
  AuthenticatedCharacterViewRepository,
} from './authenticated-character-view.types.js';

const pageSize = 20;
const maximumCampaigns = 20;
const maximumActorControls = 100;
const allViews = ['SUMMARY', 'SHEET', 'INVENTORY', 'EQUIPMENT', 'ABILITIES'] as const;
const detailedRoles = new Set<CampaignMembershipRole>([
  CampaignMembershipRole.OWNER,
  CampaignMembershipRole.GM,
  CampaignMembershipRole.PLAYER,
]);

const labels: Readonly<Record<string, string>> = {
  strength: 'Força',
  vitality: 'Vitalidade',
  agility: 'Agilidade',
  dexterity: 'Destreza',
  intelligence: 'Inteligência',
  wisdom: 'Sabedoria',
  perception: 'Percepção',
  willpower: 'Força de vontade',
  luck: 'Sorte',
  actorPhysicalPower: 'Poder físico',
  actorMagicalPower: 'Poder mágico',
  physicalDefense: 'Defesa física',
  magicalDefense: 'Defesa mágica',
  accuracy: 'Precisão',
  evasion: 'Evasão',
  stealth: 'Furtividade',
  detection: 'Detecção',
  baseAttackSpeedBps: 'Velocidade de ataque',
  baseCastingSpeedBps: 'Velocidade de conjuração',
  criticalChanceBps: 'Chance crítica',
  criticalDamageBps: 'Dano crítico',
  movementSpeed: 'Movimento',
  carryingCapacity: 'Capacidade de carga',
  physicalResistanceBps: 'Resistência física',
  magicalResistanceBps: 'Resistência mágica',
  hpRegen: 'Regeneração de HP',
  manaRegen: 'Regeneração de mana',
  spRegen: 'Regeneração de SP',
};

const slotLabels: Readonly<Record<string, string>> = {
  main_hand: 'Mão principal',
  off_hand: 'Mão secundária',
  head: 'Cabeça',
  chest: 'Peitoral',
  hands: 'Mãos',
  legs: 'Pernas',
  feet: 'Pés',
  body: 'Corpo',
  accessory_1: 'Acessório 1',
  accessory_2: 'Acessório 2',
};

const allSlots = Object.keys(slotLabels);

function unavailable(code: string, label: string) {
  return { code, label, reason: 'NOT_PERSISTED_IN_CURRENT_VERSION' as const };
}

const coreUnavailable = [
  unavailable('skills', 'Perícias'),
  unavailable('proficiencies', 'Proficiências'),
  unavailable('professions', 'Profissões'),
  unavailable('fatigue', 'Fadiga'),
  unavailable('sleep', 'Sono'),
];

function bounded(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, maximum);
}

function identity(snapshot: AuthenticatedCharacterSnapshot) {
  return {
    name: snapshot.actor.name,
    species: bounded(snapshot.actor.species, 100),
    className: bounded(snapshot.actor.className, 100),
    role: bounded(snapshot.actor.role, 100),
    description: bounded(snapshot.actor.description, 500),
    level: snapshot.actor.level,
    status: snapshot.actor.status,
    campaignName: snapshot.actor.campaignName,
    worldName: snapshot.actor.worldName,
  };
}

function resources(snapshot: AuthenticatedCharacterSnapshot) {
  const values = snapshot.mechanicalSheet.resources;
  return (['hp', 'mana', 'sp'] as const).map((code) => ({
    code,
    current: values[code].current,
    maximum: values[code].max,
  }));
}

function duration(
  effect: AuthenticatedCharacterSnapshot['statusEffects'][number],
  engineTick: bigint,
): string {
  if (effect.expiresAtTick !== null) {
    const remaining = effect.expiresAtTick > engineTick ? effect.expiresAtTick - engineTick : 0n;
    return `${remaining.toString(10)} tick(s) restante(s)`;
  }
  if (effect.remainingActions !== null) return `${effect.remainingActions} ação(ões) restante(s)`;
  return effect.durationType;
}

function publicStatuses(snapshot: AuthenticatedCharacterSnapshot) {
  return snapshot.statusEffects.map((effect) => ({
    name: effect.name,
    description: bounded(effect.description, 300),
    stacks: effect.stacks,
    duration: duration(effect, snapshot.actor.engineTick),
  }));
}

function parseProfile(value: unknown): CoreV1ContentProfile | null {
  if (value === null) return null;
  const result = validateCoreV1ContentProfile(value);
  if (!result.ok) throw new Error('Published content failed public projection integrity validation');
  return result.value;
}

function parseInventorySpec(value: unknown): CoreV1InventorySpec {
  const result = validateCoreV1InventorySpec(value);
  if (!result.ok) {
    throw new Error('Inventory content failed public projection integrity validation');
  }
  return result.value;
}

function publicCost(cost: CoreV1Cost): string {
  if (cost.type === 'none') return 'Sem custo';
  if (cost.type === 'mana') return `${cost.amount} mana`;
  if (cost.type === 'sp') return `${cost.amount} SP`;
  if (cost.type === 'hp') return `${cost.percentBps / 100}% de HP`;
  if (cost.type === 'hybrid') return `${cost.mana} mana + ${cost.sp} SP`;
  if (cost.type === 'maintenance') return `${cost.amount} ${cost.resource} por manutenção`;
  if (cost.type === 'active_defense') return `${cost.sp} SP (defesa ativa)`;
  if (cost.type === 'special_dodge') return `${cost.sp} SP (esquiva especial)`;
  return `${cost.amount} ${cost.resourceRef}`.slice(0, 160);
}

function publicTargeting(targeting: CoreV1Targeting | undefined): string {
  if (targeting === undefined) return 'Não aplicável';
  const targetCount = targeting.maxTargets === undefined ? '' : `, até ${targeting.maxTargets} alvo(s)`;
  return `${targeting.type} · alcance ${targeting.rangeBand}${targetCount}`.slice(0, 160);
}

function publicEffect(effect: CoreV1Effect): string {
  if (effect.type === 'damage' || effect.type === 'add_damage') {
    const totalBase = effect.damageComponents.reduce((total, component) => total + component.baseDamage, 0);
    return `${effect.type === 'damage' ? 'Dano' : 'Dano adicional'}: base ${totalBase}`;
  }
  if (effect.type === 'restore_resource') return `Restaura ${effect.amount} ${effect.resource.toUpperCase()}`;
  if (effect.type === 'modify_primary_attribute') return `Modifica ${effect.attributeCode} em ${effect.amount}`;
  if (effect.type === 'modify_secondary_attribute') return `Modifica ${effect.secondaryCode} em ${effect.amount}`;
  if (effect.type === 'apply_status') return 'Aplica um estado público';
  if (effect.type === 'remove_status') return 'Remove um estado';
  if (effect.type === 'grant_reaction') return `Concede reação: ${effect.reactionKind}`;
  return `Movimento: ${effect.from} → ${effect.to}`;
}

function publicRequirements(requirements: CoreV1Requirements | undefined): string[] {
  if (requirements === undefined) return [];
  return [
    ...(requirements.minimumLevel === undefined ? [] : [`Nível mínimo ${requirements.minimumLevel}`]),
    ...Object.entries(requirements.minimumPrimaryAttributes ?? {}).map(
      ([attribute, value]) => `${labels[attribute] ?? attribute}: mínimo ${String(value)}`,
    ),
    ...(requirements.requiredWeaponTags ?? []).map((tag) => `Arma: ${tag}`),
    ...(requirements.requiredEquipmentTags ?? []).map((tag) => `Equipamento: ${tag}`),
    ...(requirements.requiredRuleset === undefined ? [] : [`Regras: ${requirements.requiredRuleset}`]),
  ].slice(0, 30);
}

function publicModifiers(profile: CoreV1MechanicalContentProfile | null) {
  if (profile === null) return [];
  const passive = (profile.passiveModifiers ?? []).map((modifier) => ({
    label: labels[modifier.target] ?? modifier.target,
    amount: modifier.amount,
  }));
  const defense = profile.defense === undefined ? [] : [
    ...(profile.defense.physicalFlatDefense === undefined ? [] : [{
      label: 'Defesa física',
      amount: profile.defense.physicalFlatDefense,
    }]),
    ...(profile.defense.magicalFlatDefense === undefined ? [] : [{
      label: 'Defesa mágica',
      amount: profile.defense.magicalFlatDefense,
    }]),
    ...(profile.defense.physicalResistanceBps === undefined ? [] : [{
      label: 'Resistência física',
      amount: profile.defense.physicalResistanceBps,
    }]),
    ...(profile.defense.magicalResistanceBps === undefined ? [] : [{
      label: 'Resistência mágica',
      amount: profile.defense.magicalResistanceBps,
    }]),
  ];
  return [...passive, ...defense].slice(0, 30);
}

function publicAction(profile: CoreV1ContentProfile | null) {
  const mechanical = profile?.profileMode === 'mechanical' ? profile : null;
  if (mechanical === null) {
    return {
      activation: 'narrative',
      actionProfile: null,
      cost: 'Não aplicável',
      targeting: 'Não aplicável',
      effects: [],
    };
  }
  return {
    activation: mechanical.activation.type,
    actionProfile: mechanical.actionProfile ?? null,
    cost: publicCost(mechanical.cost),
    targeting: publicTargeting(mechanical.targeting),
    effects: (mechanical.effects ?? []).map(publicEffect).slice(0, 20),
  };
}

function cursorFor(userId: string, actorId: string, view: AuthenticatedCharacterViewName, offset: number) {
  return `cur_${createHash('sha256')
    .update('authenticated-character-cursor:v1')
    .update('\0')
    .update(userId)
    .update('\0')
    .update(actorId)
    .update('\0')
    .update(view)
    .update('\0')
    .update(String(offset))
    .digest('base64url')}`;
}

function pageOffset(
  cursor: string | undefined,
  userId: string,
  actorId: string,
  view: 'INVENTORY' | 'ABILITIES',
  total: number,
): number {
  if (cursor === undefined) return 0;
  for (let offset = pageSize; offset < total; offset += pageSize) {
    if (cursorFor(userId, actorId, view, offset) === cursor) return offset;
  }
  throw new AuthenticatedGameContextAccessError('resource_unavailable');
}

function inventoryView(
  snapshot: AuthenticatedCharacterSnapshot,
  userId: string,
  cursor: string | undefined,
): InventoryView {
  const offset = pageOffset(cursor, userId, snapshot.actor.id, 'INVENTORY', snapshot.inventory.length);
  const entries = snapshot.inventory.slice(offset, offset + pageSize).map((entry) => {
    const spec = parseInventorySpec(entry.inventorySpec);
    const profile = parseProfile(entry.profile);
    const quantity = entry.entryKind === 'stack' ? entry.quantity : 1;
    return {
      name: bounded(entry.customName, 200) ?? entry.name,
      description: bounded(entry.description, 300),
      category: entry.contentType,
      quantity,
      unitWeight: spec.unitWeight,
      totalWeight: spec.unitWeight * quantity,
      stackable: spec.stacking.mode === 'stackable',
      equipable: (spec.equipmentSlots?.length ?? 0) > 0,
      consumable: entry.contentType === 'consumable'
        || (profile?.profileMode === 'mechanical' && profile.consumable === true),
      equipped: entry.equippedSlots.length > 0,
      equippedSlots: [...entry.equippedSlots],
      state: entry.equippedSlots.length > 0 ? 'equipped' : entry.lifecycle ?? 'available',
    };
  });
  const totalWeight = snapshot.inventory.reduce((total, entry) => {
    const spec = parseInventorySpec(entry.inventorySpec);
    return total + spec.unitWeight * (entry.entryKind === 'stack' ? entry.quantity : 1);
  }, 0);
  const encumbrance = calculateInventoryEncumbrance(
    totalWeight,
    snapshot.mechanicalSheet.secondaryAttributes.carryingCapacity,
  );
  if (!encumbrance.ok) throw new Error('Inventory encumbrance failed public projection integrity validation');
  const nextOffset = offset + entries.length;
  return {
    currency: { code: 'gold', label: 'Ouro', amount: snapshot.actor.gold },
    weight: {
      carried: totalWeight,
      capacity: snapshot.mechanicalSheet.secondaryAttributes.carryingCapacity,
      state: encumbrance.value.state,
    },
    items: entries,
    page: {
      nextCursor: nextOffset < snapshot.inventory.length
        ? cursorFor(userId, snapshot.actor.id, 'INVENTORY', nextOffset)
        : null,
      itemCount: snapshot.inventory.length,
      pageSize,
    },
    unavailable: [
      unavailable('quality', 'Qualidade por instância'),
      unavailable('durability', 'Durabilidade por instância'),
      unavailable('charges', 'Cargas por instância'),
    ],
  };
}

function equipmentView(snapshot: AuthenticatedCharacterSnapshot): EquipmentView {
  const equipped = new Map(snapshot.inventory.flatMap((entry) => entry.equippedSlots.map((slot) => [slot, entry] as const)));
  return {
    slots: allSlots.map((code) => {
      const entry = equipped.get(code);
      if (entry === undefined) return { code, label: slotLabels[code] ?? code, item: null };
      const profile = parseProfile(entry.profile);
      const mechanical = profile?.profileMode === 'mechanical' ? profile : null;
      return {
        code,
        label: slotLabels[code] ?? code,
        item: {
          name: bounded(entry.customName, 200) ?? entry.name,
          category: entry.contentType,
          description: bounded(entry.description, 300),
          bonuses: publicModifiers(mechanical),
          requirements: publicRequirements(mechanical?.requirements),
          action: mechanical === null ? null : publicAction(mechanical),
        },
      };
    }),
    readOnlyNotice: 'Equipamento somente para consulta.',
    unavailable: [
      unavailable('quality', 'Qualidade por instância'),
      unavailable('durability', 'Durabilidade por instância'),
    ],
  };
}

function abilitiesView(
  snapshot: AuthenticatedCharacterSnapshot,
  userId: string,
  cursor: string | undefined,
): AbilitiesView {
  const offset = pageOffset(cursor, userId, snapshot.actor.id, 'ABILITIES', snapshot.abilities.length);
  const abilities = snapshot.abilities.slice(offset, offset + pageSize).map((ability) => {
    const profile = parseProfile(ability.profile);
    const mechanical = profile?.profileMode === 'mechanical' ? profile : null;
    const category = mechanical?.activation.type === 'passive'
      ? 'PASSIVE' as const
      : ability.contentType === 'spell'
        ? 'SPELL' as const
        : ability.contentType === 'talent'
          ? 'TALENT' as const
          : 'SKILL' as const;
    return {
      name: ability.name,
      description: bounded(ability.description, 300),
      category,
      state: ability.state as 'LEARNING' | 'KNOWN' | 'MASTERED',
      rank: ability.rank,
      progress: ability.progress,
      mastery: ability.mastery,
      version: ability.versionNumber,
      action: publicAction(profile),
      bonuses: publicModifiers(mechanical),
    };
  });
  const nextOffset = offset + abilities.length;
  return {
    abilities,
    page: {
      nextCursor: nextOffset < snapshot.abilities.length
        ? cursorFor(userId, snapshot.actor.id, 'ABILITIES', nextOffset)
        : null,
      itemCount: snapshot.abilities.length,
      pageSize,
    },
    unavailable: coreUnavailable.slice(0, 3),
  };
}

function sheetView(snapshot: AuthenticatedCharacterSnapshot): CharacterSheetView {
  const storedByCode = new Map(snapshot.storedAttributes.map((attribute) => [attribute.code, attribute]));
  const attributes = Object.entries(snapshot.mechanicalSheet.primaryAttributes).map(([code, effective]) => {
    const stored = storedByCode.get(code);
    if (stored === undefined) throw new Error('Actor attributes failed public projection integrity validation');
    return {
      code,
      label: labels[code] ?? code,
      base: stored.baseValue,
      progression: stored.earnedValue,
      effective,
      xp: stored.xp,
    };
  });
  const secondary = snapshot.mechanicalSheet.secondaryAttributes;
  const basisPoints = new Set([
    'baseAttackSpeedBps',
    'baseCastingSpeedBps',
    'criticalChanceBps',
    'criticalDamageBps',
    'physicalResistanceBps',
    'magicalResistanceBps',
  ]);
  const secondaryAttributes = Object.entries(secondary).flatMap(([code, value]) => (
    typeof value === 'number'
      ? [{
        code,
        label: labels[code] ?? code,
        value,
        unit: basisPoints.has(code) ? 'BASIS_POINTS' as const : 'POINTS' as const,
      }]
      : []
  ));
  return {
    identity: identity(snapshot),
    attributes,
    resources: resources(snapshot),
    progression: { level: snapshot.actor.level, xp: snapshot.actor.xp },
    secondaryAttributes,
    activeStatusEffects: publicStatuses(snapshot),
    ruleset: snapshot.mechanicalSheet.ruleset,
    unavailable: coreUnavailable,
  };
}

function resolveAuthorizedIds(
  userId: string,
  input: LoadAuthenticatedCharacterViewInput,
  access: Awaited<ReturnType<AuthenticatedGameContextRepository['findGameAccessByUserId']>>,
) {
  if (access === null
    || access.id !== userId
    || access.status !== UserStatus.ACTIVE
    || access.suspendedAt !== null
    || access.deletedAt !== null
    || access.player === null
    || access.campaignMemberships.length > maximumCampaigns
    || access.actorControls.length > maximumActorControls) {
    throw new AuthenticatedGameContextAccessError('resource_unavailable');
  }
  const memberships = access.campaignMemberships.filter((membership) => (
    membership.userId === userId
    && membership.status === CampaignMembershipStatus.ACTIVE
    && membership.revokedAt === null
    && detailedRoles.has(membership.role)
  )).map((membership) => ({
    record: membership,
    selectionRef: authenticatedSelectionRef('campaign', userId, membership.campaignId),
  }));
  const selectedMembership = input.campaignSelectionRef === undefined
    ? memberships.length === 1 ? memberships[0] : undefined
    : memberships.find((membership) => membership.selectionRef === input.campaignSelectionRef);
  if (selectedMembership === undefined) {
    throw new AuthenticatedGameContextAccessError(
      input.campaignSelectionRef === undefined ? 'selection_incomplete' : 'resource_unavailable',
    );
  }
  const controls = access.actorControls.filter((control) => (
    control.userId === userId
    && control.revokedAt === null
    && control.actor.actorType === ActorType.CHARACTER
    && control.actor.campaignId === selectedMembership.record.campaignId
    && [ActorControlPermission.VIEW, ActorControlPermission.CONTROL].includes(control.permission)
  )).map((control) => ({
    record: control,
    selectionRef: authenticatedSelectionRef('character', userId, control.actorId),
  }));
  const selectedControl = input.characterSelectionRef === undefined
    ? controls.length === 1 ? controls[0] : undefined
    : controls.find((control) => control.selectionRef === input.characterSelectionRef);
  if (selectedControl === undefined) {
    throw new AuthenticatedGameContextAccessError(
      input.characterSelectionRef === undefined ? 'selection_incomplete' : 'resource_unavailable',
    );
  }
  return {
    campaignId: selectedMembership.record.campaignId,
    actorId: selectedControl.record.actorId,
  };
}

export function createAuthenticatedCharacterViewService(
  accessRepository: AuthenticatedGameContextRepository,
  repository: AuthenticatedCharacterViewRepository,
) {
  return {
    async load(userId: string, input: LoadAuthenticatedCharacterViewInput): Promise<AuthenticatedCharacterViewDto> {
      if (input.cursor !== undefined && !['INVENTORY', 'ABILITIES'].includes(input.view)) {
        throw new AuthenticatedGameContextAccessError('resource_unavailable');
      }
      const access = await accessRepository.findGameAccessByUserId(userId);
      const { campaignId, actorId } = resolveAuthorizedIds(userId, input, access);
      const snapshot = await repository.loadAuthorizedCharacterSnapshot(userId, campaignId, actorId);
      if (snapshot === null) throw new AuthenticatedGameContextAccessError('resource_unavailable');

      let output: AuthenticatedCharacterViewDto;
      if (input.view === 'SUMMARY') {
        output = {
          view: 'SUMMARY',
          readOnly: true,
          data: {
            identity: identity(snapshot),
            resources: resources(snapshot),
            activeStatusCount: snapshot.statusEffects.length,
            continuitySummary: 'Nenhum checkpoint narrativo público persistido.',
            availableViews: [...allViews],
          },
        };
      } else if (input.view === 'SHEET') {
        output = { view: 'SHEET', readOnly: true, data: sheetView(snapshot) };
      } else if (input.view === 'INVENTORY') {
        output = {
          view: 'INVENTORY',
          readOnly: true,
          data: inventoryView(snapshot, userId, input.cursor),
        };
      } else if (input.view === 'EQUIPMENT') {
        output = { view: 'EQUIPMENT', readOnly: true, data: equipmentView(snapshot) };
      } else {
        output = {
          view: 'ABILITIES',
          readOnly: true,
          data: abilitiesView(snapshot, userId, input.cursor),
        };
      }
      return authenticatedCharacterViewSchema.parse(output);
    },
  };
}
