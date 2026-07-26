import { describe, expect, it } from 'vitest';
import { inspectMigrationState, validateStagingTarget } from '../../scripts/staging-database.js';

const expected = {
  projectRef: 'udqwzvhlwwfnngiipacj',
  database: 'postgres',
  role: 'cronicas_staging_app',
  schema: 'public',
};

describe('staging database safety gate', () => {
  it('accepts only the allowlisted direct Supabase target with verified TLS', () => {
    expect(validateStagingTarget(
      'postgresql://cronicas_staging_app:secret@db.udqwzvhlwwfnngiipacj.supabase.co:5432/postgres?sslmode=verify-full&schema=public',
      expected,
    )).toMatchObject({
      database: 'postgres',
      role: 'cronicas_staging_app',
      schema: 'public',
      projectRef: 'udqwzvhlwwfnngiipacj',
      port: 5432,
      sslMode: 'verify-full',
    });
  });

  it('accepts the session pooler only when its username proves the project ref', () => {
    expect(validateStagingTarget(
      'postgresql://cronicas_staging_app.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full',
      expected,
    ).hostname).toBe('aws-0-us-east-1.pooler.supabase.com');
  });

  it.each([
    ['wrong project', 'postgresql://cronicas_staging_app.otherprojectrefxxxx:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full'],
    ['wrong role', 'postgresql://postgres.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full'],
    ['wrong database', 'postgresql://cronicas_staging_app.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:5432/production?sslmode=verify-full'],
    ['transaction pooler', 'postgresql://cronicas_staging_app.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full'],
    ['unverified TLS', 'postgresql://cronicas_staging_app.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'],
    ['wrong schema', 'postgresql://cronicas_staging_app.udqwzvhlwwfnngiipacj:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&schema=private'],
    ['non-Supabase host', 'postgresql://cronicas_staging_app:secret@example.com:5432/postgres?sslmode=verify-full'],
  ])('rejects %s', (_name, url) => {
    expect(() => validateStagingTarget(url, expected)).toThrow();
  });

  it('accepts a consistent remote prefix before deploy and reports pending migrations', () => {
    const checksums = new Map([
      ['001_init', 'aaa'],
      ['002_additive', 'bbb'],
    ]);
    const state = inspectMigrationState([{
      migration_name: '001_init',
      checksum: 'aaa',
      finished_at: new Date(),
      rolled_back_at: null,
    }], checksums, false);
    expect(state.appliedMigrations).toEqual(['001_init']);
    expect(state.pendingMigrations).toEqual(['002_additive']);
  });

  it('requires exact synchronization after migrate deploy', () => {
    const checksums = new Map([
      ['001_init', 'aaa'],
      ['002_additive', 'bbb'],
    ]);
    expect(() => inspectMigrationState([{
      migration_name: '001_init',
      checksum: 'aaa',
      finished_at: new Date(),
      rolled_back_at: null,
    }], checksums, true)).toThrow('pending migrations');
  });

  it.each([
    ['changed checksum', [{
      migration_name: '001_init',
      checksum: 'tampered',
      finished_at: new Date(),
      rolled_back_at: null,
    }]],
    ['incomplete migration', [{
      migration_name: '001_init',
      checksum: 'aaa',
      finished_at: null,
      rolled_back_at: null,
    }]],
    ['rolled-back migration', [{
      migration_name: '001_init',
      checksum: 'aaa',
      finished_at: null,
      rolled_back_at: new Date(),
    }]],
    ['unknown remote migration', [{
      migration_name: '999_unknown',
      checksum: 'zzz',
      finished_at: new Date(),
      rolled_back_at: null,
    }]],
  ])('fails closed for %s', (_name, records) => {
    expect(() => inspectMigrationState(records, new Map([['001_init', 'aaa']]), false)).toThrow();
  });

  it('rejects a remote history that is not the committed prefix', () => {
    const records = [{
      migration_name: '002_second',
      checksum: 'bbb',
      finished_at: new Date(),
      rolled_back_at: null,
    }];
    const checksums = new Map([
      ['001_first', 'aaa'],
      ['002_second', 'bbb'],
    ]);
    expect(() => inspectMigrationState(records, checksums, false)).toThrow('not a prefix');
  });
});
