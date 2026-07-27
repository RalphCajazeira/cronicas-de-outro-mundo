import { describe, expect, it } from 'vitest';
import {
  projectPublicGameEvent,
  projectPublicGameEventResponse,
} from './gpt-event-public-projection.js';

const occurredAt = '2026-07-27T00:00:00.000Z';

describe('public GameEvent projections', () => {
  it('projects authenticated observations without internal or audit fields', () => {
    const projected = projectPublicGameEvent({
      actorRef: 'hero',
      eventType: 'AUTHENTICATED_OBSERVATION',
      title: 'Observação dos arredores',
      payload: {
        gameSessionId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'private-observation-key',
        MASTER_ONLY: 'private',
        action: { type: 'OBSERVE', focus: 'a trilha', summary: 'Nada novo foi confirmado.', MASTER_ONLY: 'private' },
      },
      createdAt: occurredAt,
    });

    expect(projected).toEqual({
      actorRef: 'hero',
      eventType: 'AUTHENTICATED_OBSERVATION',
      title: 'Observação dos arredores',
      payload: { type: 'OBSERVE', focus: 'a trilha', summary: 'Nada novo foi confirmado.' },
      createdAt: occurredAt,
    });
    expect(JSON.stringify(projected)).not.toMatch(/gameSessionId|userId|playerId|campaignId|actorId|idempotencyKey|MASTER_ONLY/);
  });

  it('keeps the existing campaign-started public payload contract', () => {
    const projected = projectPublicGameEvent({
      actorRef: 'hero', eventType: 'campaign-started', title: 'Campanha iniciada', createdAt: occurredAt,
      payload: {
        schemaVersion: 1, technical: true, difficultyPreset: 'standard',
        difficultyProfile: { errorTolerance: 3, opponentCunning: 3, resourceAvailability: 3, lethality: 3, failureSeverity: 3, narrativeSafetyNet: 3 },
        worldConfigSummary: { schemaVersion: 1, genres: ['fantasy'], technologyGrade: 'medieval', magicGrade: 'high' },
        campaignConfigSummary: { schemaVersion: 1, progressionPace: 'steady', narrativeTone: ['heroic'], focus: ['exploration'], playerFreedom: 'open', consequenceLevel: 'serious', classMode: 'open' },
        initialContent: [{ scope: 'world', contentType: 'skill', code: 'guard', linkedToProtagonist: true }],
        initialPremise: 'A jornada começa.',
        MASTER_ONLY: 'private',
      },
    });

    expect(projected.payload).toMatchObject({ technical: true, initialPremise: 'A jornada começa.' });
    expect(JSON.stringify(projected)).not.toContain('MASTER_ONLY');
  });

  it('fails closed for an event type without a public contract', () => {
    expect(projectPublicGameEvent({
      eventType: 'future-internal-event', title: 'Interno', payload: { public: 'value', gameSessionId: 'private' }, createdAt: occurredAt,
    }).payload).toEqual({});
  });

  it('sanitizes legacy idempotency responses before returning them', () => {
    const projected = projectPublicGameEventResponse({
      campaignRef: 'campaign', actorRef: 'hero', eventType: 'AUTHENTICATED_OBSERVATION', title: 'Observação', createdAt: occurredAt,
      payload: {
        gameSessionId: '11111111-1111-4111-8111-111111111111',
        action: { type: 'OBSERVE', focus: null, summary: 'Nada novo foi confirmado.' },
      },
    });

    expect(projected).toMatchObject({ campaignRef: 'campaign', payload: { type: 'OBSERVE', focus: null } });
    expect(JSON.stringify(projected)).not.toMatch(/gameSessionId|idempotencyKey|MASTER_ONLY/);
  });
});
