import type { GameContext } from './game-context.js';

export type Screen = 'DISCONNECTED' | 'HOME' | 'CONTINUE_PREVIEW' | 'NEW_GAME_OPTIONS' | 'ERROR';

export interface AppState {
  context: GameContext | null;
  screen: Screen;
  errorMessage: string | null;
}

export type AppAction =
  | { type: 'APPLY_CONTEXT'; context: GameContext }
  | { type: 'OPEN_CONTINUE' }
  | { type: 'OPEN_NEW_GAME' }
  | { type: 'BACK_HOME' }
  | { type: 'FAIL'; message: string };

export function createInitialState(context: GameContext): AppState {
  return {
    context,
    screen: context.authState === 'DISCONNECTED' ? 'DISCONNECTED' : 'HOME',
    errorMessage: null,
  };
}

export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'APPLY_CONTEXT':
      return createInitialState(action.context);
    case 'OPEN_CONTINUE':
      if (
        state.context?.authState !== 'CONNECTED_FIXTURE'
        || state.context.resume === null
        || !state.context.capabilities.canContinue
      ) return state;
      return { ...state, screen: 'CONTINUE_PREVIEW' };
    case 'OPEN_NEW_GAME':
      if (state.context?.authState !== 'CONNECTED_FIXTURE' || !state.context.capabilities.canStartNewGame) return state;
      return { ...state, screen: 'NEW_GAME_OPTIONS' };
    case 'BACK_HOME':
      if (state.context?.authState !== 'CONNECTED_FIXTURE') return state;
      return { ...state, screen: 'HOME', errorMessage: null };
    case 'FAIL':
      return { ...state, screen: 'ERROR', errorMessage: action.message };
  }
}
