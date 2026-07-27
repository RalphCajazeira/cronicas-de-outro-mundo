import { createRoot, type Root } from 'react-dom/client';
import { GameApp } from '../app/GameApp.js';
import { createExtensionPlatform } from '../platform/extension-platform.js';
import shellCss from '../styles/shell.css';

const CONTENT_HOST_ID = 'cronicas-extension-root';

export interface ContentGameController {
  readonly root: HTMLElement;
  destroy(): void;
}

export function mountContentShell(): ContentGameController | undefined {
  const existing = document.getElementById(CONTENT_HOST_ID);
  if (existing?.shadowRoot !== null && existing?.shadowRoot !== undefined) return undefined;
  if (existing !== null || document.documentElement === null) return undefined;
  const host = document.createElement('div');
  host.id = CONTENT_HOST_ID;
  host.setAttribute('data-cronicas-extension', 'root');
  const shadowRoot = host.attachShadow({ mode: 'open' });
  document.documentElement.append(host);
  const style = document.createElement('style');
  style.textContent = shellCss;
  const root = document.createElement('div');
  shadowRoot.append(style, root);
  const reactRoot: Root = createRoot(root);
  reactRoot.render(<GameApp adapter={createExtensionPlatform('overlay')} />);
  return { root, destroy: () => { reactRoot.unmount(); host.remove(); } };
}
