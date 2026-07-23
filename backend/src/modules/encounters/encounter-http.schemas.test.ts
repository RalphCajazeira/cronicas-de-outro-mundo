import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_HTTP_JSON_LIMIT_BYTES,
  ENCOUNTER_HTTP_MAX_PARTICIPANTS,
  ENCOUNTER_HTTP_MAX_RELATION_OVERRIDES,
  manageEncounterSchema,
} from './encounter-http.schemas.js';

const scope = { playerRef: 'player', worldRef: 'world', campaignRef: 'campaign', encounterRef: 'encounter' };
const mutation = { ...scope, idempotencyKey: 'encounter-key-001', expectedStateVersion: 1 };
const valid = {
  create: { operation: 'create', ...scope, idempotencyKey: 'encounter-create-001', participants: [{ actorRef: 'hero', sideRef: 'party', zone: 'near' }] },
  load: { operation: 'load', ...scope },
  submit_intent: { operation: 'submit_intent', ...mutation, intent: { actorRef: 'hero', slotRef: 'primary', actionSource: 'content', targetSelector: 'explicit', targetRefs: ['enemy'], contentRef: { scope: 'campaign', contentType: 'skill', code: 'slash', versionNumber: 1 } } },
  resolve_reaction: { operation: 'resolve_reaction', ...mutation, reactorRef: 'hero', reactionKind: 'block' },
  continue: { operation: 'continue', ...mutation },
  confirm_completion: { operation: 'confirm_completion', ...mutation },
  cancel: { operation: 'cancel', ...mutation },
  abandon: { operation: 'abandon', ...mutation, confirmAuthorityDrift: true },
  resolve_beat: {
    operation: 'resolve_beat', ...mutation,
    intent: {
      actorRef: 'hero', objective: 'protect_and_prepare', narrative: 'Hero recua, protege Ally e prepara uma reação.',
      resolutionPolicy: 'atomic',
      components: [
        { type: 'move', destination: 'far' },
        { type: 'protect', targetRef: 'ally' },
        { type: 'prepare', trigger: 'enemy_advances', targetRefs: ['enemy'], contentRef: { scope: 'campaign', contentType: 'spell', code: 'spark', versionNumber: 1 } },
      ],
    },
    npcDirectives: [{ actorRef: 'ally', strategy: 'defensive' }],
  },
} as const;

describe('manageEncounter public schemas', () => {
  it.each(Object.entries(valid))('accepts the closed %s operation', (_operation, value) => {
    expect(manageEncounterSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    [{ ...valid.load, idempotencyKey: 'forbidden-key' }, 'load idempotency'],
    [{ ...valid.load, expectedStateVersion: 1 }, 'load expected version'],
    [{ ...valid.create, expectedStateVersion: 1 }, 'create expected version'],
    [{ ...valid.continue, intent: valid.submit_intent.intent }, 'cross-operation intent'],
    [{ ...valid.cancel, rolls: [10] }, 'rolls'],
    [{ ...valid.cancel, snapshot: {} }, 'snapshot'],
    [{ ...valid.cancel, hit: true }, 'mechanical outcome'],
    [{ ...valid.resolve_reaction, success: true }, 'reaction outcome'],
    [{ ...valid.load, playerRef: '087780cd-fa15-45ed-89b1-f7a6304e0f42' }, 'UUID reference'],
    [{ ...valid.load, extra: true }, 'open root object'],
    [{ ...valid.create, participants: [{ ...valid.create.participants[0], mechanicsStateVersion: 1 }] }, 'open participant'],
  ])('rejects %s', (value, _label) => {
    void _label;
    expect(manageEncounterSchema.safeParse(value).success).toBe(false);
  });

  it('enforces idempotency and expectedStateVersion on every mutation', () => {
    for (const operation of ['submit_intent', 'resolve_reaction', 'continue', 'confirm_completion', 'cancel', 'abandon', 'resolve_beat'] as const) {
      const withoutKey = { ...valid[operation] } as Record<string, unknown>;
      delete withoutKey.idempotencyKey;
      const withoutVersion = { ...valid[operation] } as Record<string, unknown>;
      delete withoutVersion.expectedStateVersion;
      expect(manageEncounterSchema.safeParse(withoutKey).success, operation).toBe(false);
      expect(manageEncounterSchema.safeParse(withoutVersion).success, operation).toBe(false);
    }
    expect(manageEncounterSchema.safeParse({ ...valid.create, idempotencyKey: ' short ' }).success).toBe(false);
    const parsed = manageEncounterSchema.parse({ ...valid.create, idempotencyKey: '  encounter-create-001  ' });
    if (parsed.operation !== 'create') throw new Error('fixture');
    expect(parsed.idempotencyKey).toBe('encounter-create-001');
  });

  it('accepts the closed generic action catalog and rejects unlimited or mechanically forged beats', () => {
    const base = valid.resolve_beat;
    for (const component of [
      { type: 'move', destination: 'near' }, { type: 'defend' }, { type: 'protect', targetRef: 'ally' },
      { type: 'intercept', targetRef: 'ally' }, { type: 'assist', targetRef: 'ally' },
      { type: 'flee' }, { type: 'observe' }, { type: 'interact', targetRef: 'gate' },
      { type: 'improvise', description: 'derrubar uma mesa' },
      { type: 'use_item', inventoryEntryRef: 'potion' },
      { type: 'attack', inventoryEntryRef: 'sword', targetRefs: ['enemy'] },
      { type: 'cast', contentRef: { scope: 'campaign', contentType: 'spell', code: 'spark', versionNumber: 1 }, targetRefs: ['enemy'] },
    ]) {
      expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, components: [component] } }).success, component.type).toBe(true);
    }
    const four = manageEncounterSchema.safeParse({
      ...base, intent: { ...base.intent, components: Array.from({ length: 4 }, () => ({ type: 'defend' })) },
    });
    expect(four.success).toBe(false);
    if (four.success) throw new Error('fixture');
    expect(four.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({
      path: ['intent', 'components'],
      message: 'A beat accepts at most 3 components; received 4. Split the intention into separate decisions.',
    })]));
    expect(manageEncounterSchema.safeParse({
      ...base, intent: { ...base.intent, resolutionPolicy: 'allow_partial', components: [{ type: 'defend', essential: true }] },
    }).success).toBe(true);
    expect(manageEncounterSchema.safeParse({
      ...base,
      intent: {
        ...base.intent,
        components: [{
          type: 'use_item',
          inventoryEntryRef: 'potion',
          when: { resource: 'hp', operator: 'at_or_below_percent', percent: 25 },
          fallback: 'defend',
        }],
      },
    }).success).toBe(true);
    expect(manageEncounterSchema.safeParse({
      ...base,
      intent: {
        ...base.intent,
        components: [{ type: 'defend', fallback: 'skip' }],
      },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...base,
      intent: {
        ...base.intent,
        components: [{
          type: 'defend',
          when: { resource: 'hp', operator: 'at_or_below_percent', percent: 25, expression: 'hp < 25' },
        }],
      },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...base,
      intent: {
        ...base.intent,
        components: [{ type: 'defend', repeat: 'forever' }],
      },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...base, intent: { ...base.intent, resolutionPolicy: undefined },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, damage: 99 }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, components: [{ type: 'attack', targetRefs: ['enemy'] }] } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, npcDirectives: [
      { actorRef: 'ally', strategy: 'defensive' }, { actorRef: 'ally', strategy: 'aggressive' },
    ] }).success).toBe(false);
  });

  it('enforces source and targetSelector-specific intent fields without accepting client mechanics', () => {
    const base = valid.submit_intent;
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, targetSelector: 'self', targetRefs: ['hero'] } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, targetSelector: 'explicit', targetRefs: undefined } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, actionSource: 'consumable', contentRef: undefined, inventoryEntryRef: 'potion' } }).success).toBe(true);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, actionSource: 'consumable', inventoryEntryRef: 'potion', versatileMode: 'one_handed' } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, actionSource: 'basic_weapon_attack', contentRef: undefined, inventoryEntryRef: 'sword', versatileMode: 'two_handed' } }).success).toBe(true);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, targetRefs: ['enemy', 'enemy'] } }).success).toBe(false);
    const sparseTargets = ['enemy'];
    sparseTargets.length = 2;
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, targetRefs: sparseTargets } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, contentRef: { ...base.intent.contentRef, contentType: 'creature_template' } } }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...base, intent: { ...base.intent, slotRef: 'a'.repeat(101) } }).success).toBe(false);
  });

  it('rejects invalid and duplicate relation overrides and sparse arrays', () => {
    const participants = [
      { actorRef: 'hero', sideRef: 'party', zone: 'near' },
      { actorRef: 'enemy', sideRef: 'hostile', zone: 'medium' },
    ];
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants, relationOverrides: [{ leftActorRef: 'hero', rightActorRef: 'hero', relation: 'ally' }] }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants, relationOverrides: [{ leftActorRef: 'hero', rightActorRef: 'missing', relation: 'neutral' }] }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants, relationOverrides: [
      { leftActorRef: 'hero', rightActorRef: 'enemy', relation: 'neutral' },
      { leftActorRef: 'enemy', rightActorRef: 'hero', relation: 'ally' },
    ] }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants: [participants[0], participants[0]] }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants, partySideRef: 'missing-side' }).success).toBe(false);
    for (const relation of ['ally', 'hostile', 'neutral'] as const) {
      expect(manageEncounterSchema.safeParse({ ...valid.create, participants, partySideRef: 'party', relationOverrides: [
        { leftActorRef: 'hero', rightActorRef: 'enemy', relation },
      ] }).success).toBe(true);
    }
    const sparse = [participants[0]];
    sparse.length = 2;
    expect(manageEncounterSchema.safeParse({ ...valid.create, participants: sparse }).success).toBe(false);
  });

  it('accepts assisted creation, derives closed inputs only, and rejects incompatible side assignments', () => {
    const assisted = {
      operation: 'create',
      ...scope,
      idempotencyKey: 'assisted-create-001',
      setupMode: 'assisted',
      encounterKind: 'combat',
      partyActorRefs: ['hero', 'ally'],
      hostileActorRefs: ['enemy'],
      neutralActorRefs: ['witness'],
      objective: 'Protect the witness and stop the raiders.',
      engagementPreference: 'immediate',
      protectedActorRefs: ['ally'],
      environmentalContext: { summary: 'A narrow bridge in heavy rain.', tags: ['bridge', 'rain'] },
    } as const;
    expect(manageEncounterSchema.safeParse(assisted).success).toBe(true);
    expect(manageEncounterSchema.safeParse({
      ...assisted,
      hostileActorRefs: ['enemy', 'hero'],
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...assisted,
      protectedActorRefs: ['enemy'],
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...assisted,
      participants: [{ actorRef: 'forged', sideRef: 'party', zone: 'engaged' }],
    }).success).toBe(false);
  });

  it('accepts a bounded automatic policy with safe defaults and rejects outcomes or free loops', () => {
    const automatic = {
      operation: 'resolve_beat',
      ...mutation,
      policy: {
        actorRef: 'hero',
        mode: 'until_terminal',
        strategy: 'balanced',
        objective: 'Defeat the hostile group without wasting resources.',
        targetPriority: 'lowest_hp_hostile',
        protectedActorRefs: ['ally'],
        maximumBeats: 12,
      },
    } as const;
    const parsed = manageEncounterSchema.safeParse(automatic);
    expect(parsed.success).toBe(true);
    if (!parsed.success || !('policy' in parsed.data)) throw new Error('fixture');
    expect(parsed.data.policy.resourcePolicy).toMatchObject({
      allowCommonConsumables: false,
      allowRareConsumables: false,
      allowLimitedAbilities: false,
      preserveManaPercent: 50,
      preserveSpPercent: 50,
      stopBelowHpPercent: 25,
      allowFlee: false,
    });
    const defaulted = manageEncounterSchema.parse({
      ...automatic,
      policy: Object.fromEntries(Object.entries(automatic.policy).filter(([key]) => key !== 'maximumBeats')),
    });
    if (!('policy' in defaulted)) throw new Error('fixture');
    expect(defaulted.policy.maximumBeats).toBe(6);
    expect(manageEncounterSchema.safeParse({
      ...automatic, policy: { ...automatic.policy, maximumBeats: 13 },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...automatic, policy: { ...automatic.policy, loop: 'forever' },
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...automatic, damage: 999, hit: true, rolls: [20],
    }).success).toBe(false);
    expect(manageEncounterSchema.safeParse({
      ...automatic,
      policy: { ...automatic.policy, targetPriority: 'explicit' },
    }).success).toBe(false);
  });

  it('rejects unexpected object prototypes at the root and nested levels without echoing values', () => {
    class RequestBody { operation = 'load'; playerRef = 'player'; worldRef = 'world'; campaignRef = 'campaign'; encounterRef = 'encounter'; }
    class Participant { actorRef = 'hero'; sideRef = 'party'; zone = 'near'; }
    class ParticipantList extends Array<Participant> {}
    for (const value of [
      new RequestBody(),
      { ...valid.create, participants: [new Participant()] },
      { ...valid.create, participants: new ParticipantList(new Participant()) },
    ]) {
      const parsed = manageEncounterSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('fixture');
      expect(JSON.stringify(parsed.error.issues)).not.toContain('hero');
    }
  });

  it('keeps the exact worst-case public create payload safely below the existing 100kb parser limit', () => {
    const ref = (prefix: string, index: number) => `${prefix}-${String(index).padStart(2, '0')}-${'a'.repeat(100 - prefix.length - 4)}`;
    const participants = Array.from({ length: ENCOUNTER_HTTP_MAX_PARTICIPANTS }, (_, index) => ({
      actorRef: ref('actor', index), sideRef: ref('side', index), zone: 'out_of_range' as const, surprised: true,
    }));
    const relationOverrides: Array<{ leftActorRef: string; rightActorRef: string; relation: 'neutral' }> = [];
    outer: for (let left = 0; left < participants.length; left += 1) {
      for (let right = left + 1; right < participants.length; right += 1) {
        const a = participants[left]; const b = participants[right];
        if (a === undefined || b === undefined) throw new Error('fixture');
        relationOverrides.push({ leftActorRef: a.actorRef, rightActorRef: b.actorRef, relation: 'neutral' });
        if (relationOverrides.length === ENCOUNTER_HTTP_MAX_RELATION_OVERRIDES) break outer;
      }
    }
    const payload = { ...valid.create, playerRef: ref('player', 0), worldRef: ref('world', 0), campaignRef: ref('camp', 0), encounterRef: ref('enc', 0), idempotencyKey: 'k'.repeat(200), partySideRef: participants[0]!.sideRef, participants, relationOverrides };
    expect(manageEncounterSchema.safeParse(payload).success).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    const margin = ENCOUNTER_HTTP_JSON_LIMIT_BYTES - bytes;
    expect(bytes).toBe(51_295);
    expect(margin).toBe(51_105);
    expect(bytes).toBeLessThan(ENCOUNTER_HTTP_JSON_LIMIT_BYTES);
  });
});
