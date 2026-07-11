import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApiKeyAuth } from './api-key-auth.js';

function protectedApp() {
  const app = express();
  app.get('/private', createApiKeyAuth('expected-secret'), (_request, response) => response.json({ reached: true }));
  return app;
}

describe('x-rpg-key authentication', () => {
  it('rejects an absent key', async () => expect((await request(protectedApp()).get('/private')).status).toBe(401));
  it('rejects an incorrect key', async () => expect((await request(protectedApp()).get('/private').set('x-rpg-key', 'wrong-secret')).status).toBe(401));
  it('allows the correct key', async () => expect((await request(protectedApp()).get('/private').set('x-rpg-key', 'expected-secret')).body).toEqual({ reached: true }));
  it('does not expose either key in the error body', async () => {
    const response = await request(protectedApp()).get('/private').set('x-rpg-key', 'wrong-secret');
    expect(JSON.stringify(response.body)).not.toMatch(/wrong-secret|expected-secret/);
  });
});
