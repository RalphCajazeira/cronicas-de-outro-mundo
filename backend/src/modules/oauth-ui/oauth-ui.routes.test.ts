import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createOAuthUiRouter } from './oauth-ui.routes.js';
import type { OAuthUiAssets } from './oauth-ui.assets.js';

const config = {
  supabaseUrl: 'https://project-ref.supabase.co',
  supabasePublishableKey: 'sb_publishable_public-test-key',
  environment: 'staging',
  basePath: '/oauth',
} as const;
const assets: OAuthUiAssets = {
  readHtml: () => Promise.resolve(
    '<main data-url="__SUPABASE_URL__" data-key="__SUPABASE_PUBLISHABLE_KEY__" data-env="__ENVIRONMENT__"></main><script src="__BASE_PATH__/assets/app.js"></script>',
  ),
  readScript: () => Promise.resolve(Buffer.from('export {};')),
  readStyles: () => Promise.resolve(Buffer.from(':root{color-scheme:dark}')),
};

function app() {
  const instance = express();
  instance.use('/oauth', createOAuthUiRouter(config, assets));
  return instance;
}

describe('OAuth UI routes', () => {
  it.each(['/oauth/login', '/oauth/consent'])('serves %s with public config and restrictive headers', async (path) => {
    const response = await request(app()).get(path).expect(200);
    expect(response.text).toContain('https://project-ref.supabase.co');
    expect(response.text).toContain('sb_publishable_public-test-key');
    expect(response.text).not.toContain('DATABASE_URL');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; connect-src https://project-ref.supabase.co; font-src 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    );
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
  });

  it('serves only local script and style assets without source maps', async () => {
    const script = await request(app()).get('/oauth/assets/app.js').expect(200);
    const styles = await request(app()).get('/oauth/assets/styles.css').expect(200);
    await request(app()).get('/oauth/assets/app.js.map').expect(404);
    expect(script.headers['content-type']).toMatch(/javascript/u);
    expect(styles.headers['content-type']).toMatch(/css/u);
  });
});
