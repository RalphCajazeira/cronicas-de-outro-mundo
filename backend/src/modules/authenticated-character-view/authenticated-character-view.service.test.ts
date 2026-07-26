import { describe, expect, it } from 'vitest';
import {
  ActorControlPermission,
  ActorStatus,
  ActorType,
  CampaignMembershipRole,
  CampaignMembershipStatus,
  CampaignStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import type { AuthenticatedGameContextRepository } from '../authenticated-game-context/authenticated-game-context.types.js';
import { authenticatedSelectionRef } from '../authenticated-game-context/authenticated-selection-ref.js';
import { loadAuthenticatedCharacterViewInputSchema } from './authenticated-character-view.dto.js';
import { createAuthenticatedCharacterViewService } from './authenticated-character-view.service.js';
import type {
  AuthenticatedCharacterSnapshot,
  AuthenticatedCharacterViewRepository,
} from './authenticated-character-view.types.js';

const userId = 'user-1';
const campaignId = 'campaign-1';
const actorId = 'actor-1';

function accessRepository(
  role: CampaignMembershipRole = CampaignMembershipRole.PLAYER,
  permission: ActorControlPermission = ActorControlPermission.VIEW,
): AuthenticatedGameContextRepository {
  return {
    findGameAccessByUserId: () => Promise.resolve({
      id: userId,
      status: UserStatus.ACTIVE,
      suspendedAt: null,
      deletedAt: null,
      player: { id: 'player-1', displayName: 'Jogador de Teste' },
      campaignMemberships: [{
        campaignId,
        userId,
        role,
        status: CampaignMembershipStatus.ACTIVE,
        revokedAt: null,
        campaign: {
          id: campaignId,
          name: 'Campanha de Teste',
          status: CampaignStatus.ACTIVE,
          world: { name: 'Mundo de Teste' },
        },
      }],
      actorControls: [{
        actorId,
        userId,
        permission,
        revokedAt: null,
        actor: {
          id: actorId,
          campaignId,
          name: 'Aventureira',
          level: 3,
          actorType: ActorType.CHARACTER,
          status: ActorStatus.ACTIVE,
          resources: [],
          derivedSnapshot: null,
        },
      }],
    }),
  };
}

function snapshot(): AuthenticatedCharacterSnapshot {
  const primaryAttributes = {
    strength: 10,
    vitality: 11,
    agility: 12,
    dexterity: 13,
    intelligence: 14,
    wisdom: 15,
    perception: 16,
    willpower: 17,
    luck: 18,
  };
  return {
    actor: {
      id: actorId,
      name: 'Aventureira',
      species: 'Humana',
      className: 'Exploradora',
      role: 'Batedora',
      description: 'Uma personagem sintética para validação.',
      level: 3,
      xp: 75,
      gold: 42,
      status: 'active',
      campaignName: 'Campanha de Teste',
      worldName: 'Mundo de Teste',
      engineTick: 10n,
    },
    storedAttributes: Object.entries(primaryAttributes).map(([code, baseValue]) => ({
      code,
      baseValue,
      earnedValue: 0,
      xp: 0,
    })),
    mechanicalSheet: {
      primaryAttributes,
      resources: {
        hp: { current: 30, max: 40, stateVersion: 1 },
        mana: { current: 20, max: 25, stateVersion: 1 },
        sp: { current: 18, max: 22, stateVersion: 1 },
      },
      secondaryAttributes: {
        actorPhysicalPower: 12,
        actorMagicalPower: 14,
        physicalDefense: 8,
        magicalDefense: 9,
        accuracy: 11,
        evasion: 10,
        stealth: 7,
        detection: 8,
        baseAttackSpeedBps: 10_000,
        baseCastingSpeedBps: 10_000,
        criticalChanceBps: 500,
        criticalDamageBps: 15_000,
        movementSpeed: 6,
        carryingCapacity: 50,
        physicalResistanceBps: 0,
        magicalResistanceBps: 0,
        elementalResistanceBps: {},
        hpRegen: 1,
        manaRegen: 1,
        spRegen: 1,
      },
      mechanicsStateVersion: 2,
      inventoryStateVersion: 2,
      effectsStateVersion: 2,
      ruleset: { code: 'core-v1', revision: '1.2.0' },
    },
    inventory: [{
      name: 'Tônico de treino',
      customName: null,
      description: 'Restaura recursos em um cenário sintético.',
      contentType: 'consumable',
      quantity: 2,
      entryKind: 'stack',
      lifecycle: null,
      profile: null,
      inventorySpec: {
        schemaVersion: 1,
        rulesetCode: 'core-v1',
        inventoryRulesCode: 'core-v1-inventory-v1',
        unitWeight: 1,
        stacking: { mode: 'stackable', maxStack: 10 },
      },
      equippedSlots: [],
    }],
    abilities: [{
      contentVersionId: 'version-quick-step',
      name: 'Passo rápido',
      description: 'Uma técnica pública de treinamento.',
      contentType: 'skill',
      state: 'KNOWN',
      rank: 1,
      progress: 10,
      mastery: 0,
      versionNumber: 1,
      profile: {
        schemaVersion: 1,
        rulesetCode: 'core-v1',
        profileMode: 'mechanical',
        contentKind: 'talent',
        code: 'oauth-test-quick-step',
        name: 'Passo rápido',
        tier: 1,
        rarity: 'common',
        activation: { type: 'passive' },
        cost: { type: 'none' },
        passiveModifiers: [{
          target: 'accuracy',
          amount: 1,
          sourceRule: 'content_intrinsic',
        }],
      },
    }],
    statusEffects: [{
      name: 'Foco',
      description: 'Estado público sintético.',
      stacks: 1,
      durationType: 'ticks',
      expiresAtTick: 15n,
      remainingActions: null,
    }],
  };
}

function service(
  auth = accessRepository(),
  viewRepository: AuthenticatedCharacterViewRepository = {
    loadAuthorizedCharacterSnapshot: () => Promise.resolve(snapshot()),
  },
) {
  return createAuthenticatedCharacterViewService(auth, viewRepository);
}

function input(view: 'SUMMARY' | 'SHEET' | 'INVENTORY' | 'EQUIPMENT' | 'ABILITIES') {
  return {
    view,
    campaignSelectionRef: authenticatedSelectionRef('campaign', userId, campaignId),
    characterSelectionRef: authenticatedSelectionRef('character', userId, actorId),
  };
}

describe('authenticated character view service', () => {
  it.each(['SUMMARY', 'SHEET', 'INVENTORY', 'EQUIPMENT', 'ABILITIES'] as const)(
    'projects the authorized %s view without internal identifiers',
    async (view) => {
      const result = await service().load(userId, input(view));

      expect(result).toMatchObject({ view, readOnly: true });
      expect(JSON.stringify(result)).not.toContain(actorId);
      expect(JSON.stringify(result)).not.toContain(campaignId);
      expect(JSON.stringify(result)).not.toContain('oauth-test-');
    },
  );

  it('does not grant detailed character data to observer memberships', async () => {
    await expect(service(accessRepository(CampaignMembershipRole.OBSERVER)).load(
      userId,
      input('SUMMARY'),
    )).rejects.toMatchObject({
      reasonCode: 'resource_unavailable',
    });
  });

  it('accepts an active CONTROL grant without changing the read-only projection', async () => {
    const result = await service(accessRepository(
      CampaignMembershipRole.PLAYER,
      ActorControlPermission.CONTROL,
    )).load(userId, input('SUMMARY'));

    expect(result).toMatchObject({ view: 'SUMMARY', readOnly: true });
  });

  it('paginates inventory with an opaque cursor and rejects an altered cursor', async () => {
    const firstSnapshot = snapshot();
    const manyItems = Array.from({ length: 21 }, (_, index) => ({
      ...firstSnapshot.inventory[0]!,
      name: `Item ${index + 1}`,
    }));
    const viewService = service(accessRepository(), {
      loadAuthorizedCharacterSnapshot: () => Promise.resolve({
        ...firstSnapshot,
        inventory: manyItems,
      }),
    });

    const first = await viewService.load(userId, input('INVENTORY'));
    if (first.view !== 'INVENTORY') throw new Error('Inventory projection missing');
    expect(first.data.items).toHaveLength(20);
    expect(first.data.page.nextCursor).toMatch(/^cur_[A-Za-z0-9_-]{43}$/u);

    const nextCursor = first.data.page.nextCursor;
    if (nextCursor === null) throw new Error('Inventory cursor missing');
    const second = await viewService.load(userId, { ...input('INVENTORY'), cursor: nextCursor });
    if (second.view !== 'INVENTORY') throw new Error('Inventory projection missing');
    expect(second.data.items.map((item) => item.name)).toEqual(['Item 21']);
    expect(second.data.page.nextCursor).toBeNull();

    await expect(viewService.load(userId, {
      ...input('INVENTORY'),
      cursor: `${nextCursor.slice(0, -1)}${nextCursor.endsWith('a') ? 'b' : 'a'}`,
    })).rejects.toMatchObject({ reasonCode: 'resource_unavailable' });
  });

  it('projects empty lists, zero currency, and explicit unavailable future fields', async () => {
    const emptySnapshot = snapshot();
    const projectedSnapshot = {
      ...emptySnapshot,
      actor: { ...emptySnapshot.actor, xp: 0, gold: 0 },
      mechanicalSheet: {
        ...emptySnapshot.mechanicalSheet,
        resources: {
          ...emptySnapshot.mechanicalSheet.resources,
          hp: { ...emptySnapshot.mechanicalSheet.resources.hp, current: 0 },
        },
      },
      inventory: [],
      abilities: [],
      statusEffects: [],
    };
    const viewService = service(accessRepository(), {
      loadAuthorizedCharacterSnapshot: () => Promise.resolve(projectedSnapshot),
    });
    const result = await viewService.load(userId, input('INVENTORY'));

    if (result.view !== 'INVENTORY') throw new Error('Inventory projection missing');
    expect(result.data.currency.amount).toBe(0);
    expect(result.data.items).toEqual([]);
    expect(result.data.unavailable.map((field) => field.code)).toEqual([
      'quality',
      'durability',
      'charges',
    ]);

    const summaryResult = await viewService.load(userId, input('SUMMARY'));
    if (summaryResult.view !== 'SUMMARY') throw new Error('Summary projection missing');
    expect(summaryResult.data.resources.find((resource) => resource.code === 'hp')?.current).toBe(0);
  });

  it('fails closed when persisted mechanics are inconsistent', async () => {
    const inconsistent = snapshot();
    await expect(service(accessRepository(), {
      loadAuthorizedCharacterSnapshot: () => Promise.resolve({
        ...inconsistent,
        storedAttributes: inconsistent.storedAttributes.slice(1),
      }),
    }).load(userId, input('SHEET'))).rejects.toThrow(
      'Actor attributes failed public projection integrity validation',
    );
  });

  it('fails closed when final transactional authorization no longer exists', async () => {
    await expect(service(accessRepository(), {
      loadAuthorizedCharacterSnapshot: () => Promise.resolve(null),
    }).load(userId, input('SHEET'))).rejects.toMatchObject({
      reasonCode: 'resource_unavailable',
    });
  });

  it('rejects raw identifiers and unexpected input fields at the public boundary', () => {
    expect(loadAuthenticatedCharacterViewInputSchema.safeParse({
      view: 'SUMMARY',
      actorId,
      campaignId,
    }).success).toBe(false);
  });

  it('rejects cursors on non-paginated views', async () => {
    await expect(service().load(userId, {
      ...input('SUMMARY'),
      cursor: `cur_${'a'.repeat(43)}`,
    })).rejects.toMatchObject({
      reasonCode: 'resource_unavailable',
    });
  });
});
