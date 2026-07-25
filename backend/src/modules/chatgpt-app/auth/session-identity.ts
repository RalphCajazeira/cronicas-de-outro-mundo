import type { AppConfig } from '../../../config/env.js';

export type FixtureScenario = 'WITH_RESUME' | 'WITHOUT_RESUME';

export interface SessionIdentity {
  kind: 'CONNECTED_FIXTURE';
  scenario: FixtureScenario;
}

export interface SessionIdentityProvider {
  getIdentity(): Promise<SessionIdentity | null>;
}

export interface FixtureSessionConnector {
  connectFixture(scenario: FixtureScenario): Promise<SessionIdentity>;
}

export class DisconnectedSessionIdentityProvider implements SessionIdentityProvider {
  getIdentity(): Promise<null> {
    return Promise.resolve(null);
  }
}

export class FixtureSessionIdentityProvider implements SessionIdentityProvider, FixtureSessionConnector {
  private identity: SessionIdentity | null = null;

  constructor(environment: AppConfig['NODE_ENV'], proofMode: boolean) {
    if (environment === 'production' && !proofMode) {
      throw new Error('Fixture identity is unavailable in production');
    }
  }

  getIdentity(): Promise<SessionIdentity | null> {
    return Promise.resolve(this.identity);
  }

  connectFixture(scenario: FixtureScenario): Promise<SessionIdentity> {
    this.identity = { kind: 'CONNECTED_FIXTURE', scenario };
    return Promise.resolve(this.identity);
  }
}
