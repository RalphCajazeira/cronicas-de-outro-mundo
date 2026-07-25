import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { gameContextSchema, type GameContext } from './game-context.js';

export type GameContextToolResultErrorCode = 'TOOL_ERROR' | 'MISSING_STRUCTURED_CONTENT' | 'INVALID_STRUCTURED_CONTENT';

export class GameContextToolResultError extends Error {
  constructor(
    readonly code: GameContextToolResultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function parseGameContextToolResult(result: CallToolResult): GameContext {
  if (result.isError === true) {
    throw new GameContextToolResultError(
      'TOOL_ERROR',
      'A ferramenta informou que não foi possível carregar o contexto público.',
    );
  }

  if (result.structuredContent === undefined) {
    throw new GameContextToolResultError(
      'MISSING_STRUCTURED_CONTENT',
      'A ferramenta não incluiu o contexto público estruturado.',
    );
  }

  const parsed = gameContextSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    throw new GameContextToolResultError(
      'INVALID_STRUCTURED_CONTENT',
      'O contexto público retornado pela ferramenta não corresponde ao contrato esperado.',
    );
  }

  return parsed.data;
}
