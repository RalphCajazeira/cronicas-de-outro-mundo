import type { GameContextDto } from '../dto/game-context.dto.js';
import type { SessionIdentity } from '../auth/session-identity.js';

export interface GameContextGateway {
  loadGameContext(identity: SessionIdentity): Promise<GameContextDto>;
}
