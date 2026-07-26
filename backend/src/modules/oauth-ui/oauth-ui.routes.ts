import { Router, type Response } from 'express';
import type { OAuthUiConfig } from '../../config/env.js';
import type { OAuthUiAssets } from './oauth-ui.assets.js';

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function setSecurityHeaders(response: Response, config: OAuthUiConfig): void {
  const supabaseOrigin = new URL(config.supabaseUrl).origin;
  response.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': [
      "default-src 'none'",
      "base-uri 'none'",
      `connect-src ${supabaseOrigin}`,
      "font-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data:",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

function renderHtml(template: string, config: OAuthUiConfig): string {
  return template
    .replaceAll('__SUPABASE_URL__', escapeHtmlAttribute(config.supabaseUrl))
    .replaceAll('__SUPABASE_PUBLISHABLE_KEY__', escapeHtmlAttribute(config.supabasePublishableKey))
    .replaceAll('__ENVIRONMENT__', escapeHtmlAttribute(config.environment))
    .replaceAll('__BASE_PATH__', escapeHtmlAttribute(config.basePath));
}

export function createOAuthUiRouter(config: OAuthUiConfig, assets: OAuthUiAssets) {
  const router = Router();
  router.use((_request, response, next) => {
    setSecurityHeaders(response, config);
    next();
  });
  const page = async (_request: unknown, response: Response, next: (error?: unknown) => void) => {
    try {
      response.type('html').send(renderHtml(await assets.readHtml(), config));
    } catch (error) {
      next(error);
    }
  };
  router.get('/login', page);
  router.get('/consent', page);
  router.get('/assets/app.js', async (_request, response, next) => {
    try {
      response.type('application/javascript').send(await assets.readScript());
    } catch (error) {
      next(error);
    }
  });
  router.get('/assets/styles.css', async (_request, response, next) => {
    try {
      response.type('text/css').send(await assets.readStyles());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
