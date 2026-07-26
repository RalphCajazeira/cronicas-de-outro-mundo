import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const ZERO_SHA = /^0{40}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const MIGRATION_PATH = /^backend\/prisma\/migrations\/[^/]+\/migration\.sql$/u;

export type MigrationRisk = 'none' | 'low' | 'high';

export interface MigrationClassification {
  changedMigrations: string[];
  risk: MigrationRisk;
  reasons: string[];
}

interface ChangedMigration {
  path: string;
  status: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function stripSqlCommentsAndStrings(sql: string): string {
  let output = '';
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error('migration contains an unterminated block comment');
      output += ' ';
      continue;
    }

    if (current === '\'') {
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '\'' && sql[index + 1] === '\'') {
          index += 2;
        } else if (sql[index] === '\'') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error('migration contains an unterminated string');
      output += '\'\'';
      continue;
    }

    if (current === '"') {
      let closed = false;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error('migration contains an unterminated quoted identifier');
      output += '"identifier"';
      continue;
    }

    if (current === '$') {
      const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (delimiter !== undefined) {
        const closingIndex = sql.indexOf(delimiter, index + delimiter.length);
        if (closingIndex === -1) throw new Error('migration contains an unterminated dollar-quoted string');
        index = closingIndex + delimiter.length;
        output += '\'\'';
        continue;
      }
    }

    output += current;
    index += 1;
  }

  return output;
}

function classifyStatement(statement: string): string[] {
  const normalized = statement.replace(/\s+/gu, ' ').trim().toUpperCase();
  if (normalized.length === 0) return [];

  const mandatoryHighRisk: Array<[RegExp, string]> = [
    [/\bDROP\b/u, 'destructive_drop'],
    [/^(?:TRUNCATE|DELETE|UPDATE|INSERT)\b/u, 'data_change'],
    [/\bALTER\s+TYPE\b/u, 'enum_or_type_change'],
    [/\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\b(?:TYPE|SET\s+DATA\s+TYPE)\b/u, 'column_type_change'],
    [/\bSET\s+NOT\s+NULL\b/u, 'set_not_null'],
    [/\bRENAME\b/u, 'rename'],
    [/\bOWNER\s+TO\b/u, 'ownership_change'],
    [/^(?:GRANT|REVOKE)\b/u, 'privilege_change'],
    [/\bROW\s+LEVEL\s+SECURITY\b/u, 'row_level_security'],
    [/^(?:CREATE|ALTER|DROP)\s+POLICY\b/u, 'policy_change'],
    [/^(?:DO|CALL)\b/u, 'procedural_sql'],
    [/\b(?:CREATE|ALTER|DROP)(?:\s+OR\s+REPLACE)?\s+(?:FUNCTION|PROCEDURE)\b/u, 'procedural_sql'],
    [/\bEXECUTE\b/u, 'dynamic_sql'],
    [/^LOCK(?:\s+TABLE)?\b/u, 'explicit_lock'],
    [/^(?:VACUUM|ANALYZE|REINDEX|CLUSTER|COPY|DISCARD|CHECKPOINT)\b/u, 'administrative_command'],
    [/^CREATE\s+UNIQUE\s+INDEX\b/u, 'unique_index'],
  ];

  const highReasons = mandatoryHighRisk
    .filter(([pattern]) => pattern.test(normalized))
    .map(([, reason]) => reason);
  if (highReasons.length > 0) return highReasons;

  if (/^(?:BEGIN|COMMIT)\b/u.test(normalized)) return [];
  if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/u.test(normalized)) {
    return /\bAS\s+SELECT\b/u.test(normalized) ? ['table_created_from_query'] : [];
  }
  if (/^CREATE\s+TYPE\b/u.test(normalized)) return [];
  if (/^CREATE\s+INDEX\b/u.test(normalized)) return [];
  if (/^ALTER\s+TABLE\b/u.test(normalized)) {
    if (/\bADD\s+COLUMN\b/u.test(normalized)) {
      if (/\b(?:DEFAULT|GENERATED|IDENTITY)\b/u.test(normalized)) return ['nontrivial_column_addition'];
      return [];
    }
    if (/\bADD\s+CONSTRAINT\b/u.test(normalized) && /\b(?:FOREIGN\s+KEY|CHECK)\b/u.test(normalized)) {
      return [];
    }
  }

  return ['unknown_statement'];
}

export function classifyMigrationSql(sql: string): { risk: 'low' | 'high'; reasons: string[] } {
  let sanitized: string;
  try {
    sanitized = stripSqlCommentsAndStrings(sql);
  } catch {
    return { risk: 'high', reasons: ['unparseable_sql'] };
  }

  const statements = sanitized.split(';').map((statement) => statement.trim()).filter(Boolean);
  if (statements.length === 0) return { risk: 'high', reasons: ['no_executable_statement'] };
  const reasons = unique(statements.flatMap(classifyStatement));
  return reasons.length === 0 ? { risk: 'low', reasons: [] } : { risk: 'high', reasons };
}

export function parseChangedMigrationEntries(nameStatus: string): ChangedMigration[] {
  const entries: ChangedMigration[] = [];
  for (const line of nameStatus.split(/\r?\n/u).filter(Boolean)) {
    const fields = line.split('\t');
    const status = fields[0] ?? '';
    const paths = status.startsWith('R') || status.startsWith('C') ? fields.slice(1, 3) : fields.slice(1, 2);
    for (const path of paths) {
      if (path !== undefined && (MIGRATION_PATH.test(path) || path === 'backend/prisma/migrations/migration_lock.toml')) {
        entries.push({ path, status });
      }
    }
  }
  return entries;
}

export function resolveRequestedBase(base: string): { base: string; fallback: 'none' | 'empty-tree' } {
  const normalized = base.trim().toLowerCase();
  if (ZERO_SHA.test(normalized)) return { base: EMPTY_TREE_SHA, fallback: 'empty-tree' };
  if (!COMMIT_SHA.test(normalized)) throw new Error('base SHA must be a full commit SHA');
  return { base: normalized, fallback: 'none' };
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function verifyCommit(sha: string): void {
  git(['cat-file', '-e', `${sha}^{commit}`]);
}

function classifyChangedMigrations(entries: ChangedMigration[]): MigrationClassification {
  if (entries.length === 0) return { changedMigrations: [], risk: 'none', reasons: [] };

  const changedMigrations = unique(entries.map(({ path }) => path)).sort();
  const reasons: string[] = [];

  for (const entry of entries) {
    if (
      entry.path === 'backend/prisma/migrations/migration_lock.toml'
      || entry.status.startsWith('D')
      || entry.status.startsWith('R')
      || entry.status.startsWith('C')
      || !existsSync(entry.path)
    ) {
      reasons.push(`${entry.path}:migration_history_change`);
      continue;
    }
    const result = classifyMigrationSql(readFileSync(entry.path, 'utf8'));
    reasons.push(...result.reasons.map((reason) => `${entry.path}:${reason}`));
  }

  return {
    changedMigrations,
    risk: reasons.length === 0 ? 'low' : 'high',
    reasons: unique(reasons).sort(),
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function writeGitHubMetadata(
  classification: MigrationClassification,
  base: string,
  head: string,
  fallback: string,
): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output !== undefined) {
    appendFileSync(output, [
      `risk=${classification.risk}`,
      `base=${base}`,
      `head=${head}`,
      `fallback=${fallback}`,
      `changed_migrations=${JSON.stringify(classification.changedMigrations)}`,
    ].join('\n') + '\n');
  }

  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined) {
    appendFileSync(summary, [
      '## Migration classification',
      '',
      `- Base: \`${base}\``,
      `- Head: \`${head}\``,
      `- Range fallback: \`${fallback}\``,
      `- Changed migrations: ${classification.changedMigrations.length}`,
      `- Risk: **${classification.risk}**`,
      ...(classification.changedMigrations.map((path) => `  - \`${path}\``)),
      ...(classification.reasons.map((reason) => `  - Reason: \`${reason}\``)),
      '',
    ].join('\n'));
  }
}

export function classifyGitRange(baseInput: string, headInput: string): MigrationClassification {
  const head = headInput.trim().toLowerCase();
  if (!COMMIT_SHA.test(head)) throw new Error('head SHA must be a full commit SHA');
  const range = resolveRequestedBase(baseInput);
  verifyCommit(head);
  if (range.fallback === 'none') {
    verifyCommit(range.base);
    execFileSync('git', ['merge-base', '--is-ancestor', range.base, head], { stdio: 'ignore' });
  }
  const nameStatus = git(['diff', '--name-status', '--find-renames', range.base, head, '--', 'backend/prisma/migrations']);
  return classifyChangedMigrations(parseChangedMigrationEntries(nameStatus));
}

function main(): void {
  const baseInput = argument('--base');
  const head = argument('--head')?.trim().toLowerCase();
  const outputPath = argument('--output');
  if (baseInput === undefined || head === undefined) throw new Error('--base and --head are required');

  const range = resolveRequestedBase(baseInput);
  const classification = classifyGitRange(baseInput, head);
  const payload = `${JSON.stringify(classification, null, 2)}\n`;
  if (outputPath !== undefined) writeFileSync(outputPath, payload, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(payload);
  writeGitHubMetadata(classification, range.base, head, range.fallback);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error('Migration classification failed closed');
    process.exitCode = 1;
  }
}
