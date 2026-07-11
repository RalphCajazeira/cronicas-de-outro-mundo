import { describe, expect, it } from 'vitest';
import { resolveTestDatabaseConfig } from '../support/test-database.js';

const devUrl = 'postgresql://user:secret@localhost:5432/game_gpt_dev';

function environment(testDatabaseUrl: string, databaseUrl = devUrl) {
  return { NODE_ENV: 'test', DATABASE_URL: databaseUrl, TEST_DATABASE_URL: testDatabaseUrl };
}

describe('test database safety', () => {
  it('accepts localhost and game_gpt_test', () => {
    expect(resolveTestDatabaseConfig(environment('postgresql://user:secret@localhost:5432/game_gpt_test')).databaseUrl.pathname).toBe('/game_gpt_test');
  });

  it('accepts 127.0.0.1 and game_gpt_test', () => {
    expect(resolveTestDatabaseConfig(environment('postgresql://user:secret@127.0.0.1:5432/game_gpt_test')).databaseUrl.hostname).toBe('127.0.0.1');
  });

  it.each([
    'postgresql://user:secret@localhost:5432/game_gpt_dev',
    'postgresql://user:secret@localhost:5432/postgres',
    'postgresql://user:secret@localhost:5432/template0',
    'postgresql://user:secret@localhost:5432/template1',
  ])('rejects forbidden database %s', (url) => {
    expect(() => resolveTestDatabaseConfig(environment(url))).toThrow('Unsafe test database configuration');
  });

  it('rejects a remote host', () => {
    expect(() => resolveTestDatabaseConfig(environment('postgresql://user:secret@example.com:5432/game_gpt_test'))).toThrow('Unsafe test database configuration');
  });

  it('rejects a Supabase host without exposing it', () => {
    const secretUrl = 'postgresql://user:top-secret@project.supabase.co:5432/game_gpt_test';
    expect(() => resolveTestDatabaseConfig(environment(secretUrl))).toThrowError(new Error('Unsafe test database configuration'));
  });

  it('rejects TEST_DATABASE_URL equal to DATABASE_URL', () => {
    const sameUrl = 'postgresql://user:secret@localhost:5432/game_gpt_test';
    expect(() => resolveTestDatabaseConfig(environment(sameUrl, sameUrl))).toThrow('Unsafe test database configuration');
  });

  it('rejects production before database access', () => {
    expect(() => resolveTestDatabaseConfig({ ...environment('postgresql://user:secret@localhost:5432/game_gpt_test'), NODE_ENV: 'production' })).toThrow('Unsafe test database configuration');
  });
});
