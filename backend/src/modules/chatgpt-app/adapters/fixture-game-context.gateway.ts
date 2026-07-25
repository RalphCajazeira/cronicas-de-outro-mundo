import type { AppConfig } from '../../../config/env.js';
import type { GameContextGateway } from './game-context.gateway.js';
import type { GameContextDto } from '../dto/game-context.dto.js';
import type { SessionIdentity } from '../auth/session-identity.js';

const FIXTURE_UPDATED_AT = '2026-07-25T18:00:00.000Z';

export class FixtureGameContextGateway implements GameContextGateway {
  private readonly nonProduction: boolean;

  constructor(environment: AppConfig['NODE_ENV'], proofMode: boolean) {
    if (environment === 'production' && !proofMode) {
      throw new Error('Fixture game context is unavailable in production');
    }
    this.nonProduction = environment !== 'production';
  }

  loadGameContext(identity: SessionIdentity): Promise<GameContextDto> {
    const withResume = identity.scenario === 'WITH_RESUME';
    return Promise.resolve({
      authState: 'CONNECTED_FIXTURE',
      player: {
        displayName: 'Ralph, viajante de Elarion',
      },
      resume: withResume ? {
        canContinue: true,
        characterName: 'Kael',
        characterLevel: 7,
        worldName: 'Elarion',
        campaignName: 'As Cinzas do Primeiro Sol',
        campaignStatus: 'Em andamento',
        lastKnownStateLabel: 'Acampamento diante das Ruínas de Vhal',
        activeSessionType: 'Exploração',
        updatedAt: FIXTURE_UPDATED_AT,
      } : null,
      capabilities: {
        canStartNewGame: true,
        canContinue: withResume,
      },
      environment: {
        fixtureMode: true,
        nonProduction: this.nonProduction,
      },
    });
  }
}
