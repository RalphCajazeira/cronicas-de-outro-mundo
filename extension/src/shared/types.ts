export const SHELL_TABS = ['summary', 'sheet', 'inventory', 'equipment', 'abilities', 'map', 'combat'] as const;

export type ShellTab = (typeof SHELL_TABS)[number];
export type DisplayMode = 'minimized' | 'overlay' | 'page';

export interface ExtensionPreferences {
  readonly buttonPosition: {
    readonly right: number;
    readonly bottom: number;
  };
  readonly lastMode: DisplayMode;
  readonly activeTab: ShellTab;
  readonly reducedMotion: boolean;
}
