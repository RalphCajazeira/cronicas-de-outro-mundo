const TEST_DATABASE_NAME = 'game_gpt_test';
const FORBIDDEN_DATABASES = new Set(['game_gpt_dev', 'postgres', 'template0', 'template1']);
const REMOTE_HOST_MARKERS = ['supabase', 'render.com', 'render.internal'];

export interface TestDatabaseEnvironment {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  TEST_DATABASE_URL?: string;
  TEST_DIRECT_URL?: string;
  TEST_RPG_API_KEY?: string;
}

export interface TestDatabaseConfig {
  databaseUrl: URL;
  directUrl: URL;
  apiKey: string;
}

function invalidTestDatabase(): never {
  throw new Error('Unsafe test database configuration');
}

function deriveTestUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    url.pathname = `/${TEST_DATABASE_NAME}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateUrl(value: string | undefined): URL {
  if (value === undefined || value.length === 0) return invalidTestDatabase();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidTestDatabase();
  }
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//, '')).toLowerCase();
  if (!['localhost', '127.0.0.1'].includes(host)) return invalidTestDatabase();
  if (REMOTE_HOST_MARKERS.some((marker) => host.includes(marker))) return invalidTestDatabase();
  if (database !== TEST_DATABASE_NAME || FORBIDDEN_DATABASES.has(database)) return invalidTestDatabase();
  return url;
}

export function resolveTestDatabaseConfig(environment: TestDatabaseEnvironment): TestDatabaseConfig {
  if (environment.NODE_ENV === 'production') return invalidTestDatabase();

  const testDatabaseUrl = environment.TEST_DATABASE_URL || deriveTestUrl(environment.DATABASE_URL);
  const testDirectUrl = environment.TEST_DIRECT_URL || deriveTestUrl(environment.DIRECT_URL) || testDatabaseUrl;
  const databaseUrl = validateUrl(testDatabaseUrl);
  const directUrl = validateUrl(testDirectUrl);

  if (environment.DATABASE_URL !== undefined) {
    try {
      if (databaseUrl.toString() === new URL(environment.DATABASE_URL).toString()) return invalidTestDatabase();
    } catch {
      return invalidTestDatabase();
    }
  }

  return { databaseUrl, directUrl, apiKey: environment.TEST_RPG_API_KEY || 'local-integration-test-key' };
}

export function createAdminUrl(testUrl: URL): URL {
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  adminUrl.hash = '';
  return adminUrl;
}
