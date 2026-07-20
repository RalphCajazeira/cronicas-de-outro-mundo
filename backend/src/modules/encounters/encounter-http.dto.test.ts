import { describe, expect, it } from 'vitest';
import { encounterPublicResult, toEncounterPublicDto } from './encounter-http.dto.js';
import type { EncounterDto } from './encounter.types.js';

function dto(overrides: Partial<EncounterDto> = {}): EncounterDto {
  return {
    operation: 'load', encounterRef: 'encounter', lifecycleStatus: 'awaiting_intent', stateVersion: 2,
    currentTick: '9007199254740993', stopReason: null, completionCandidate: null,
    participants: [{ actorRef: 'hero', bindingKind: 'persisted_actor', sideRef: 'party', combatState: 'ready', zone: 'near', resources: { hp: { current: 9, maximum: 10 }, mana: { current: 5, maximum: 5 }, sp: { current: 4, maximum: 4 } } }],
    nextRequiredAction: { type: 'submit_intent', actors: [{ actorRef: 'hero', readySlotRefs: ['primary'] }] },
    ...overrides,
  };
}

describe('encounter public DTO mapper', () => {
  it.each([
    ['cancelled', 'encounter_cancelled'], ['completed', 'encounter_completed'], ['failed', 'encounter_failed'],
    ['completion_pending', 'completion_confirmation_required'], ['awaiting_reaction', 'reaction_required'],
  ])('gives terminal and required-action lifecycle %s precedence', (lifecycleStatus, result) => {
    expect(encounterPublicResult(dto({ operation: 'load', lifecycleStatus }))).toBe(result);
  });

  it('maps processed boundaries and operation-specific fallbacks without contradiction', () => {
    const transitionSummary = { processedEventCount: 1, events: [{ category: 'action_resolved' as const, actorRef: 'hero' }], changes: [] };
    expect(encounterPublicResult(dto({ operation: 'continue', transitionSummary }))).toBe('new_intent_required');
    expect(encounterPublicResult(dto({ operation: 'continue', lifecycleStatus: 'processing_paused', nextRequiredAction: { type: 'continue' }, transitionSummary }))).toBe('processing_paused');
    expect(encounterPublicResult(dto({ operation: 'create' }))).toBe('encounter_created');
    expect(encounterPublicResult(dto({ operation: 'load' }))).toBe('encounter_loaded');
    expect(encounterPublicResult(dto({ operation: 'submit_intent', lifecycleStatus: 'processing_paused', nextRequiredAction: { type: 'continue' } }))).toBe('intent_accepted');
    expect(encounterPublicResult(dto({ operation: 'resolve_reaction', lifecycleStatus: 'processing_paused', nextRequiredAction: { type: 'continue' } }))).toBe('reaction_resolved');
  });

  it('preserves bigint ticks as canonical decimal strings and allowlists every output field', () => {
    const publicDto = toEncounterPublicDto(dto());
    expect(publicDto.currentTick).toBe('9007199254740993');
    expect(Object.keys(publicDto).sort()).toEqual([
      'completionCandidate', 'currentTick', 'encounterRef', 'lifecycleStatus', 'nextRequiredAction',
      'participants', 'result', 'stateVersion', 'stopReason',
    ]);
    const serialized = JSON.stringify(publicDto);
    expect(serialized).not.toMatch(/"operation"|stateHash|inputHash|adapterState|snapshot|"rolls"|eventRef|actionRef|"id"/);
  });

  it('allowlists nested next-action and transition fields instead of cloning unknown properties', () => {
    const unsafe = dto({
      operation: 'continue',
      lifecycleStatus: 'processing_paused',
      nextRequiredAction: { type: 'continue', queue: 'queue-secret' } as EncounterDto['nextRequiredAction'],
      transitionSummary: {
        processedEventCount: 1,
        events: [{ category: 'action_resolved', actorRef: 'hero', eventRef: 'event-secret' }],
        changes: [{
          actorRef: 'hero', categories: ['resource_changed'],
          resources: { hp: { before: 9, after: 8, delta: -1, roll: 17 } },
          profile: 'profile-secret',
        }],
        scheduledEvents: ['queue-secret'],
      } as unknown as NonNullable<EncounterDto['transitionSummary']>,
    });
    const serialized = JSON.stringify(toEncounterPublicDto(unsafe));
    expect(serialized).not.toMatch(/queue-secret|event-secret|profile-secret|scheduledEvents|eventRef|roll/);
  });

  it('rejects unknown lifecycle/operation combinations instead of selecting a fallback result', () => {
    expect(() => encounterPublicResult(dto({ operation: 'continue', lifecycleStatus: 'unknown' }))).toThrow();
  });
});
