import { createRoot } from 'react-dom/client';
import { GameApp } from '../app/GameApp.js';
import { createWebPlatform } from '../platform/web-platform.js';
import '../styles/shell.css';

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<GameApp adapter={createWebPlatform()} />);
