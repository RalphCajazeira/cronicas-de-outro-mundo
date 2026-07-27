import type { DisplayMode } from './types.js';

const transitions: Readonly<Record<DisplayMode, readonly DisplayMode[]>> = {
  minimized: ['overlay', 'page'],
  overlay: ['minimized', 'page'],
  page: ['minimized', 'overlay'],
};

export function canTransitionMode(from: DisplayMode, to: DisplayMode): boolean {
  return from === to || transitions[from].includes(to);
}
