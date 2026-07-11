import { describe, expect, it } from 'vitest';
import { parseConfig } from './env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3100',
  DATABASE_URL: 'postgresql://user:secret@localhost:5432/game_gpt_test',
  RPG_API_KEY: 'secret-test-key',
};

describe('application configuration', () => {
  it('parses a valid configuration', () => {
    expect(parseConfig(validEnvironment)).toMatchObject({ NODE_ENV: 'test', HOST: '0.0.0.0', PORT: 3100, RPG_API_KEY: 'secret-test-key' });
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = validEnvironment;
    void _databaseUrl;
    expect(() => parseConfig(missingDatabaseUrl)).toThrow('Invalid application configuration');
  });

  it('does not expose a secret in its error', () => {
    const secret = 'must-never-leak';
    expect(() => parseConfig({ ...validEnvironment, DATABASE_URL: secret })).toThrowError(new Error('Invalid application configuration'));
  });

  it('requires a public HTTPS base URL in production', () => {
    expect(() => parseConfig({ ...validEnvironment, NODE_ENV: 'production' })).toThrow('Invalid application configuration');
    expect(parseConfig({ ...validEnvironment, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://rpg.example.com' }).PUBLIC_BASE_URL).toBe('https://rpg.example.com');
  });
});
