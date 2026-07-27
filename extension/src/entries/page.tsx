import { createRoot } from 'react-dom/client';
import { GameApp } from '../app/GameApp.js';
import { createExtensionPlatform } from '../platform/extension-platform.js';
import shellCss from '../styles/shell.css';

const host = document.getElementById('app');
if (host !== null) {
  const style = document.createElement('style');
  style.textContent = shellCss;
  document.head.append(style);
  createRoot(host).render(<GameApp adapter={createExtensionPlatform('extension-page')} />);
}
