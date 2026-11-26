//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// Materialize the semantic model's schema into SQLite, then answer read-only SQL
// locally. The catalog builder has no agent-supplied DAX input: every remote
// query comes from CATALOG_SOURCES below.
//
// --search, --sql, and --file are repeatable and answered in one process. One
// invocation costs one model round trip, and a round trip re-sends the whole
// conversation, so the batch is the cheap shape. The whole batch shares the
// single-statement byte budget.

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  isFabricGuid,
  resolveAlias,
  resolveIdentity,
  runFabricQuery,
} from './schema.mjs';

const MINIMUM_NODE = Object.freeze({ major: 22, minor: 13, patch: 0 });

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map(Number);
  const supported =
    major > MINIMUM_NODE.major ||
    (major === MINIMUM_NODE.major &&
      (minor > MINIMUM_NODE.minor ||
        (minor === MINIMUM_NODE.minor && patch >= MINIMUM_NODE.patch)));
  if (!supported) {
    throw new Error(
      `The semantic-model catalog requires Node.js >=22.13.0; ` +
        `this process is using ${version}. Upgrade Node.js, reinstall ` +
        'the app dependencies, and retry.'
    );
  }
}

assertSupportedNodeVersion();
const { DatabaseSync } = await import('node:sqlite');

function openReadOnlyDatabase(path) {
  // DatabaseSync readOnly still permits VACUUM INTO; query_only prevents a
  // catalog copy from being written to an arbitrary path.
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

export const CATALOG_FILE = 'catalog.md';
export const DATABASE_FILE = 'model.sqlite';
export const CACHE_ROOT = '.schema';
export const DEFAULT_TTL_MINUTES = 15;

const DEFAULT_PRINT_LIMIT = 200;
export const MAX_RESULT_BYTES = 20_000;
const MAX_OWNED_MEASURE_PREVIEW = 10;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_DELAY_MS = 2_000;
const RATE_LIMIT_MAX_DELAY_MS = 75_000;
const CATALOG_LOCK_DIRECTORY = '.refresh.lock';
const CATALOG_LOCK_POLL_MS = 250;
const CATALOG_LOCK_TIMEOUT_MS = 30 * 60_000;
const CATALOG_LOCK_STALE_MS = 60 * 60_000;
// A rename over a live destination fails with a sharing violation on Windows
// while a concurrent reader still holds the file open. The A4 hard-link backup
// keeps the path visible but does not make the replacement non-exclusive, so a
// completed refresh could still be thrown away because someone was reading.
const PUBLISH_RETRY_ATTEMPTS = 20;
const PUBLISH_RETRY_DELAY_MS = 50;
// A failed automatic refresh must not re-fetch every source on the next
// command: the usual cause is throttling, and retrying immediately extends the
// block it is reacting to. The cooldown is a separate marker, never the
// catalog's mtime - faking freshness would make the catalog lie about its age.
export const REFRESH_COOLDOWN_MINUTES = 15;
const REFRESH_COOLDOWN_FILE = '.refresh-cooldown.json';
const TRUNCATION_REQUIRED_ACTION =
  'Required: rerun with a narrower WHERE clause before using this result to plan DAX; a smaller projection also helps except for automatic table-measure enrichment.';

// This hardcoded list is the schema-only boundary. Do not accept DAX from a
// caller on the catalog-build path.
export const CATALOG_SOURCES = Object.freeze([
  Object.freeze({
    table: 'info_view_tables',
    dax: 'INFO.VIEW.TABLES()',
    grain: 'One row per semantic-model table',
  }),
  Object.freeze({
    table: 'info_view_columns',
    dax: 'INFO.VIEW.COLUMNS()',
    grain: 'One row per model column',
  }),
  Object.freeze({
    table: 'info_view_measures',
    dax: 'INFO.VIEW.MEASURES()',
    grain: 'One row per measure',
  }),
  Object.freeze({
    table: 'info_view_relationships',
    dax: 'INFO.VIEW.RELATIONSHIPS()',
    grain: 'One row per model relationship',
  }),
  Object.freeze({
    // COLUMNSTATISTICS returns real Min/Max values derived from model rows,
    // plus cardinality and maximum text length. BigInt-bearing values are
    // normalized before they cross Rayfin's JSON boundary.
    table: 'column_statistics',
    dax: `SELECTCOLUMNS(
    COLUMNSTATISTICS(),
    "Table Name", [Table Name],
    "Column Name", [Column Name],
    "Min", CONVERT([Min], STRING),
    "Max", CONVERT([Max], STRING),
    "Cardinality", CONVERT([Cardinality], DOUBLE),
    "Max Length", CONVERT([Max Length], DOUBLE)
)`,
    optional: true,
    grain: 'One row per statistically described column',
  }),
]);

export function rawQuery(dax) {
  return `EVALUATE ${dax}`;
}

export function isRateLimited(result) {
  return (
    !result?.ok &&
    /\b429\b|rate limit|too many requests/i.test(String(result?.error || ''))
  );
}

function absoluteRetryDelayMs(error, now) {
  const match =
    /blocked by the upstream service until:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)\s+\(UTC\)/i.exec(
      String(error || '')
    );
  if (!match) {
    return 0;
  }
  let hour = Number(match[4]) % 12;
  if (match[7].toUpperCase() === 'PM') {
    hour += 12;
  }
  const deadline = Date.UTC(
    Number(match[3]),
    Number(match[1]) - 1,
    Number(match[2]),
    hour,
    Number(match[5]),
    Number(match[6])
  );
  return Math.max(0, deadline - now);
}

export function retryDelayMs(
  result,
  attempt,
  {
    base = RATE_LIMIT_BASE_DELAY_MS,
    max = RATE_LIMIT_MAX_DELAY_MS,
    jitter = Math.random,
    now = Date.now,
  } = {}
) {
  const hint = /retry in (\d+)\s*second/i.exec(String(result?.error || ''));
  const backoff = Math.min(base * 2 ** attempt, max);
  const relativeMinimum = hint ? Number(hint[1]) * 1000 : 0;
  const absoluteMinimum = absoluteRetryDelayMs(result?.error, now());
  const minimum = Math.max(relativeMinimum, absoluteMinimum);
  if (minimum > 0) {
    return Math.round(minimum + backoff * jitter());
  }
  return Math.round(backoff * (0.5 + 0.5 * jitter()));
}

export function withRateLimitRetry(
  run,
  {
    retries = RATE_LIMIT_RETRIES,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onRetry = null,
    ...delayOptions
  } = {}
) {
  return async (dax) => {
    let result = await run(dax);
    for (
      let attempt = 0;
      attempt < retries && isRateLimited(result);
      attempt += 1
    ) {
      const wait = retryDelayMs(result, attempt, delayOptions);
      onRetry?.({ attempt, wait, error: result.error });
      await sleep(wait);
      result = await run(dax);
    }
    return result;
  };
}

export function toSqlValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value);
}

export function inferColumnType(values) {
  let seen = false;
  let integral = true;
  for (const value of values) {
    if (value === null || value === undefined || value === '') {
      continue;
    }
    if (typeof value === 'boolean') {
      seen = true;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      seen = true;
      if (typeof value === 'number' && !Number.isInteger(value)) {
        integral = false;
      }
      continue;
    }
    return 'TEXT';
  }
  if (!seen) {
    return 'TEXT';
  }
  return integral ? 'INTEGER' : 'REAL';
}

export function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function jsonWithoutNullFields(value) {
  return JSON.stringify(value, (_key, item) =>
    item === null ? undefined : item
  );
}

function isTsvScalar(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  );
}

function canFormatRowsAsTsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return false;
  }
  const columns = Object.keys(rows[0]);
  return rows.every((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return false;
    }
    const rowColumns = Object.keys(row);
    if (
      rowColumns.length !== columns.length ||
      rowColumns.some((column, index) => column !== columns[index])
    ) {
      return false;
    }
    return columns.every((column) => {
      const value = row[column];
      return (
        isTsvScalar(value) &&
        !/[\t\r\n]/.test(value == null ? '' : String(value))
      );
    });
  });
}

export function formatResult(result) {
  if (!result?.ok || !canFormatRowsAsTsv(result.rows)) {
    return `${jsonWithoutNullFields(result)}\n`;
  }
  const columns = Object.keys(result.rows[0]);
  const metadata = {
    ok: true,
    totalRows: result.totalRows,
    returnedRows: result.returnedRows,
    truncated: result.truncated,
    ...(result.truncation ? { truncation: result.truncation } : {}),
    ...(result.notes?.length ? { notes: result.notes } : {}),
    encoding: 'tsv',
  };
  const lines = [
    `# ${JSON.stringify(metadata)}`,
    columns.join('\t'),
    ...result.rows.map((row) =>
      columns
        .map((column) => (row[column] == null ? '' : String(row[column])))
        .join('\t')
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function columnNamesOf(rows) {
  const names = [];
  const seen = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  return names;
}

function sourceColumnType(dataType) {
  const normalized = String(dataType ?? '').toLocaleLowerCase();
  if (
    normalized.includes('int') ||
    normalized.includes('boolean') ||
    normalized.includes('whole')
  ) {
    return 'INTEGER';
  }
  if (
    normalized.includes('double') ||
    normalized.includes('decimal') ||
    normalized.includes('single') ||
    normalized.includes('currency') ||
    normalized.includes('number')
  ) {
    return 'REAL';
  }
  if (normalized.includes('binary')) {
    return 'BLOB';
  }
  return 'TEXT';
}

export function createTable(db, table, rows, sourceColumns = []) {
  const names = [];
  const seen = new Set();
  for (const column of sourceColumns) {
    if (
      typeof column?.name === 'string' &&
      column.name.length > 0 &&
      !seen.has(column.name)
    ) {
      seen.add(column.name);
      names.push(column.name);
    }
  }
  for (const name of columnNamesOf(rows)) {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  if (names.length === 0) {
    return { table, columns: [], rowCount: 0 };
  }
  const sourceTypes = new Map(
    sourceColumns.map((column) => [column.name, column.dataType])
  );
  const columns = names.map((name) => ({
    name,
    type: rows.some(
      (row) => row[name] !== null && row[name] !== undefined && row[name] !== ''
    )
      ? inferColumnType(rows.map((row) => row[name]))
      : sourceColumnType(sourceTypes.get(name)),
  }));
  const ddl = columns
    .map((column) => `${quoteIdentifier(column.name)} ${column.type}`)
    .join(', ');
  db.exec('BEGIN');
  try {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table)}`);
    db.exec(`CREATE TABLE ${quoteIdentifier(table)} (${ddl})`);

    const placeholders = names.map(() => '?').join(', ');
    const insert = db.prepare(
      `INSERT INTO ${quoteIdentifier(table)} VALUES (${placeholders})`
    );
    for (const row of rows) {
      insert.run(...names.map((name) => toSqlValue(row[name])));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { table, columns, rowCount: rows.length };
}

function textField(row, names) {
  for (const name of names) {
    if (typeof row?.[name] === 'string' && row[name].length > 0) {
      return row[name];
    }
  }
  return '';
}

export function semanticSearchRows(resultSets) {
  const rows = [];
  for (const resultSet of resultSets ?? []) {
    for (const row of resultSet.rows ?? []) {
      let entity;
      if (resultSet.table === 'info_view_tables') {
        const name = textField(row, ['Name']);
        entity = {
          kind: 'table',
          parent_name: name,
          object_name: name,
          description: textField(row, ['Description']),
          expression: textField(row, ['Expression']),
          display_folder: '',
          data_type: '',
          synonyms: textField(row, ['Synonyms']),
        };
      } else if (resultSet.table === 'info_view_measures') {
        entity = {
          kind: 'measure',
          parent_name: textField(row, ['Table']),
          object_name: textField(row, ['Name']),
          description: textField(row, ['Description']),
          expression: textField(row, ['Expression']),
          display_folder: textField(row, ['DisplayFolder']),
          data_type: '',
          synonyms: textField(row, ['Synonyms']),
        };
      } else if (resultSet.table === 'info_view_columns') {
        entity = {
          kind: 'column',
          parent_name: textField(row, ['Table']),
          object_name: textField(row, ['Name']),
          description: textField(row, ['Description']),
          expression: textField(row, ['Expression']),
          display_folder: textField(row, ['DisplayFolder']),
          data_type: textField(row, ['DataType']),
          synonyms: textField(row, ['Synonyms']),
        };
      } else if (resultSet.table === 'info_view_relationships') {
        const fromTable = textField(row, ['FromTable']);
        const fromColumn = textField(row, ['FromColumn']);
        const toTable = textField(row, ['ToTable']);
        const toColumn = textField(row, ['ToColumn']);
        entity = {
          kind: 'relationship',
          parent_name: fromTable,
          object_name:
            `${fromTable}.${fromColumn} -> ` + `${toTable}.${toColumn}`,
          description: '',
          expression: '',
          display_folder: '',
          data_type: '',
          synonyms: '',
        };
      } else {
        continue;
      }
      if (!entity.object_name) {
        continue;
      }
      rows.push({
        ...entity,
        search_text: Object.values(entity).join(' ').toLocaleLowerCase(),
      });
    }
  }
  return rows;
}

function createSemanticSearchTable(db, rows) {
  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS "semantic_search"');
    db.exec(
      'CREATE TABLE "semantic_search" (' +
        '"kind" TEXT, "parent_name" TEXT, "object_name" TEXT, ' +
        '"description" TEXT, "expression" TEXT, "display_folder" TEXT, ' +
        '"data_type" TEXT, "synonyms" TEXT, "search_text" TEXT)'
    );
    const insert = db.prepare(
      'INSERT INTO "semantic_search" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const row of rows) {
      insert.run(
        row.kind,
        row.parent_name,
        row.object_name,
        row.description,
        row.expression,
        row.display_folder,
        row.data_type,
        row.synonyms,
        row.search_text
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    table: 'semantic_search',
    columns: [
      'kind',
      'parent_name',
      'object_name',
      'description',
      'expression',
      'display_folder',
      'data_type',
      'synonyms',
      'search_text',
    ].map((name) => ({ name, type: 'TEXT' })),
    rowCount: rows.length,
    grain: 'One row per searchable model entity',
    dax: 'Derived from the native metadata tables',
    note: 'Use --search for ranked retrieval across this table.',
  };
}

function populateDatabase(resultSets, path) {
  const db = new DatabaseSync(path);
  const built = [];
  try {
    const searchable = semanticSearchRows(resultSets);
    for (const { table, rows, columns, grain, dax, note } of resultSets) {
      const info = createTable(db, table, rows || [], columns || []);
      built.push({
        ...info,
        grain,
        dax,
        note: note ?? null,
      });
    }
    built.push(createSemanticSearchTable(db, searchable));
    return built;
  } finally {
    db.close();
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Replace `to` with `from`, retrying a sharing violation.
 *
 * Only a concurrent reader produces these codes here; the destination is ours
 * and the source is a temporary file we just wrote. Retrying briefly is enough
 * because a reader holds the catalog open for the length of one query.
 */
function renameWithRetry(
  rename,
  from,
  to,
  {
    attempts = PUBLISH_RETRY_ATTEMPTS,
    delayMs = PUBLISH_RETRY_DELAY_MS,
    sleep = sleepSync,
  } = {}
) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const sharingViolation =
        error?.code === 'EPERM' ||
        error?.code === 'EBUSY' ||
        error?.code === 'EACCES';
      if (!sharingViolation || attempt >= attempts) {
        throw error;
      }
      sleep(delayMs);
    }
  }
}

/**
 * Publish one or more completed files without deleting the previous generation.
 * If any rename fails, every prior destination is restored from its backup.
 */
export function publishFiles(
  files,
  {
    exists = existsSync,
    rename = renameSync,
    remove = rmSync,
    link = linkSync,
    uuid = randomUUID,
    retry = {},
  } = {}
) {
  const entries = files.map(({ temporaryPath, destinationPath }) => ({
    temporaryPath,
    destinationPath,
    backupPath: `${destinationPath}.${process.pid}.${uuid()}.previous`,
    hadPrevious: false,
    linked: false,
    published: false,
  }));

  try {
    for (const entry of entries) {
      if (!exists(entry.destinationPath)) {
        continue;
      }
      // Back the previous generation up by hard-linking rather than renaming,
      // so the destination never stops existing. Renaming it away first left a
      // window in which a concurrent reader saw no database at all, and with
      // batching one such reader discarded up to eight statements of work.
      try {
        link(entry.destinationPath, entry.backupPath);
        entry.linked = true;
      } catch {
        // A filesystem without hard links still gets the old guarantee: the
        // previous generation is preserved and rollback works. What it does
        // NOT get is the gap-free publication above - the destination briefly
        // stops existing again, and this fallback is silent about it. Verified
        // supported on NTFS, which is where scaffolded apps live; an exotic
        // filesystem would degrade here without any signal.
        rename(entry.destinationPath, entry.backupPath);
      }
      entry.hadPrevious = true;
    }

    for (const entry of entries) {
      // rename() replaces an existing destination atomically, so a reader sees
      // either the whole previous generation or the whole new one. On Windows
      // it still needs exclusive access, so a reader mid-query is waited out
      // rather than being allowed to discard a completed refresh.
      renameWithRetry(
        rename,
        entry.temporaryPath,
        entry.destinationPath,
        retry
      );
      entry.published = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.published) {
          remove(entry.destinationPath, { force: true });
        }
        if (entry.hadPrevious) {
          if (entry.linked && !entry.published) {
            // The destination was never replaced; drop the extra link only.
            remove(entry.backupPath, { force: true });
          } else {
            rename(entry.backupPath, entry.destinationPath);
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Catalog publication failed and the previous generation could not be fully restored.'
      );
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.hadPrevious) {
      remove(entry.backupPath, { force: true });
    }
  }
}

export function buildDatabase(resultSets, dbPath) {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const temporaryPath = `${dbPath}.${process.pid}.${randomUUID()}.tmp`;
  rmSync(temporaryPath, { force: true });
  try {
    const built = populateDatabase(resultSets, temporaryPath);
    publishFiles([
      {
        temporaryPath,
        destinationPath: dbPath,
      },
    ]);
    return built;
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export async function withCatalogLock(
  dir,
  action,
  {
    now = Date.now,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pollMs = CATALOG_LOCK_POLL_MS,
    timeoutMs = CATALOG_LOCK_TIMEOUT_MS,
    staleMs = CATALOG_LOCK_STALE_MS,
    jitter = Math.random,
    processAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error?.code === 'ESRCH') {
          return false;
        }
        if (error?.code === 'EPERM') {
          return true;
        }
        throw error;
      }
    },
  } = {}
) {
  mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, CATALOG_LOCK_DIRECTORY);
  // A per-acquisition token, not just a pid: pids are reused, and two reclaimers
  // that both decided a lock was abandoned would otherwise each remove whatever
  // lock happens to be there when they get round to it - including a live one
  // created in between. Every removal below is conditional on the token that
  // was observed when the decision was made.
  const ownerToken = randomUUID();
  const waitStartedAt = now();
  let acquired = false;
  let waited = false;

  const readOwner = () => {
    try {
      return JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    } catch (ownerError) {
      if (ownerError?.code === 'ENOENT' || ownerError instanceof SyntaxError) {
        return null;
      }
      throw ownerError;
    }
  };

  // Remove the lock only if it is still the one the caller decided about.
  const removeIfUnchanged = (expected) => {
    const current = readOwner();
    if (current?.token !== expected?.token) {
      return false;
    }
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  };

  while (!acquired) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          join(lockPath, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            token: ownerToken,
            startedAt: new Date(now()).toISOString(),
          }),
          'utf8'
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      acquired = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      waited = true;
      let age;
      try {
        age = now() - statSync(lockPath).mtimeMs;
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          continue;
        }
        throw statError;
      }
      const owner = readOwner();
      if (
        Number.isInteger(owner?.pid) &&
        owner.pid > 0 &&
        owner.pid !== process.pid &&
        !processAlive(owner.pid)
      ) {
        // Re-read before removing: the owner we judged dead may already have
        // been cleared and replaced by a live holder.
        removeIfUnchanged(owner);
        continue;
      }
      if (age > staleMs) {
        removeIfUnchanged(owner);
        continue;
      }
      if (now() - waitStartedAt >= timeoutMs) {
        throw new Error(
          `Timed out waiting for another catalog refresh to finish after ` +
            `${Math.round(timeoutMs / 1000)} seconds.`
        );
      }
      await sleep(Math.round(pollMs * (0.75 + 0.5 * jitter())));
    }
  }

  try {
    return await action({ waited });
  } finally {
    // Release only our own lock. If another process reclaimed it while we were
    // working, its lock is live and removing it would let a third process run
    // concurrently with it; the staleness path reclaims a genuinely orphaned
    // one instead.
    removeIfUnchanged({ token: ownerToken });
  }
}

export function renderCatalog(
  built,
  { datasetId, notes = [], incomplete = false } = {}
) {
  const lines = [];
  lines.push('# Semantic model catalog');
  lines.push('');
  lines.push(`Catalog status: **${incomplete ? 'INCOMPLETE' : 'complete'}**`);
  lines.push('');
  lines.push(`SQLite database: \`${DATABASE_FILE}\``);
  if (datasetId) {
    lines.push(`Dataset: \`${datasetId}\``);
  }
  lines.push('');
  lines.push('| Table | Shape | Grain | Source |');
  lines.push('| --- | ---: | --- | --- |');
  for (const table of built) {
    const shape =
      `${table.rowCount.toLocaleString('en-US')} rows x ` +
      `${table.columns.length} columns`;
    const source = String(table.dax).replace(/\s+/g, ' ').replace(/\|/g, '\\|');
    lines.push(
      `| \`${table.table}\` | ${shape} | ${table.grain} | ` + `\`${source}\` |`
    );
  }
  lines.push('');
  lines.push('## Columns');
  lines.push('');
  for (const table of built) {
    if (table.columns.length === 0) {
      lines.push(`- \`${table.table}\` - empty.`);
      continue;
    }
    const columns = table.columns
      .map((column) => `\`${column.name}\``)
      .join(', ');
    lines.push(`- \`${table.table}\`: ${columns}`);
  }
  lines.push('');
  lines.push('## How the tables relate');
  lines.push('');
  lines.push(
    '- `info_view_columns."Table"` and `info_view_measures."Table"` ' +
      'join to `info_view_tables."Name"`.'
  );
  lines.push(
    '- `column_statistics.("Table Name", "Column Name")` joins to ' +
      '`info_view_columns.("Table", "Name")`.'
  );
  lines.push(
    '- Relationship endpoints join to columns by (table, column): ' +
      '`("FromTable", "FromColumn")` and ' +
      '`("ToTable", "ToColumn")`.'
  );
  lines.push(
    '- `catalog_status` records whether every source view was captured. ' +
      'Query it before treating an untruncated SQL result as proof that ' +
      'an object is absent.'
  );
  lines.push('');
  lines.push(
    "Column names are the model's own spellings, exactly as DAX returned " +
      'them, so names containing spaces need quoting.'
  );
  lines.push(
    '`column_statistics` contains actual Min/Max values derived from model ' +
      'rows, plus cardinality and maximum text length. Treat this cache as ' +
      'customer data.'
  );
  if (notes.length > 0) {
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    for (const note of notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function discoverRaw({ run } = {}) {
  const notes = [];
  const resultSets = [];
  let incomplete = false;
  const missing = [];

  for (const source of CATALOG_SOURCES) {
    const result = await run(rawQuery(source.dax));
    if (!result.ok) {
      if (source.table === 'info_view_tables') {
        return {
          ok: false,
          error: `Table discovery failed: ${result.error}`,
        };
      }
      incomplete = true;
      missing.push(source.table);
      const scope = source.optional ? '' : ' The catalog is incomplete.';
      notes.push(
        `${source.dax} failed, so \`${source.table}\` is not in the catalog.` +
          `${scope} ${result.error}`
      );
      continue;
    }
    if (!Array.isArray(result.columns) || result.columns.length === 0) {
      if (source.table === 'info_view_tables') {
        return {
          ok: false,
          error: 'Table discovery failed: the query returned no column schema.',
        };
      }
      incomplete = true;
      missing.push(source.table);
      notes.push(
        `${source.dax} returned no column schema, so ` +
          `\`${source.table}\` is not in the catalog.`
      );
      continue;
    }
    resultSets.push({
      ...source,
      columns: result.columns,
      rows: result.rows,
    });
  }

  resultSets.push({
    table: 'catalog_status',
    rows: [
      {
        status: incomplete ? 'incomplete' : 'complete',
        incomplete,
        notes: JSON.stringify(notes),
      },
    ],
    grain: 'One row describing catalog completeness',
    dax: 'Derived from catalog build outcomes',
    note: 'Check this row before treating absence from another table as proof.',
  });

  return { ok: true, resultSets, notes, incomplete, missing };
}

function catalogFileVersion(path) {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch {
    return null;
  }
}

function readCatalogStatus(dbPath) {
  if (!existsSync(dbPath)) {
    return null;
  }
  let db;
  try {
    db = openReadOnlyDatabase(dbPath);
    const row = db
      .prepare('SELECT status, incomplete, notes FROM "catalog_status" LIMIT 1')
      .get();
    if (!row) {
      return null;
    }
    return {
      status: row.status,
      incomplete: Boolean(row.incomplete),
      notes: row.notes,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function catalogHasTable(dbPath, table) {
  if (!existsSync(dbPath)) {
    return false;
  }
  let db;
  try {
    db = openReadOnlyDatabase(dbPath);
    return (
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1"
        )
        .get(table) !== undefined
    );
  } catch {
    // An unreadable database cannot be shown to hold the view, and the caller
    // only uses this to decide whether publishing would lose one.
    return false;
  } finally {
    db?.close();
  }
}

function reusedCatalogResult(dbPath, catalogPath, notes, extra = {}) {
  const status = readCatalogStatus(dbPath);
  return {
    ok: true,
    reused: true,
    dbPath,
    catalogPath,
    built: [],
    notes: Array.isArray(notes) ? notes : [notes],
    incomplete: status?.status !== 'complete',
    ...extra,
  };
}

export async function materializeCatalog({
  dir,
  datasetId,
  alias,
  run = (dax) => runFabricQuery(dax, { alias }),
  retry = withRateLimitRetry,
  lockOptions,
} = {}) {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, DATABASE_FILE);
  const catalogPath = join(dir, CATALOG_FILE);
  const initialVersion = catalogFileVersion(dbPath);

  const refreshCatalog = async ({ waited }) => {
    const currentVersion = catalogFileVersion(dbPath);
    const currentStatus = readCatalogStatus(dbPath);
    if (
      waited &&
      currentVersion !== null &&
      currentVersion !== initialVersion &&
      currentStatus?.status === 'complete'
    ) {
      return reusedCatalogResult(
        dbPath,
        catalogPath,
        'Another process refreshed this catalog while this process was waiting.'
      );
    }

    const discovery = await discoverRaw({
      run: retry(run),
    });
    if (!discovery.ok) {
      // A cold start has nothing to answer from, so a failed discovery stays
      // fatal. With a complete catalog already on disk it must not be:
      // throttling and transient outages hit the first request after the TTL
      // expires, and failing there costs the whole command even though the
      // previous snapshot would have answered it. The cooldown is still
      // recorded from these notes, so the next call does not re-hammer a
      // model that is already refusing.
      if (currentStatus?.status !== 'complete') {
        return discovery;
      }
      return reusedCatalogResult(
        dbPath,
        catalogPath,
        [
          'The refresh failed, so the previous complete catalog was ' +
            'preserved. No new data was fetched; the catalog below is the ' +
            'earlier snapshot.',
          discovery.error,
        ],
        { refreshIncomplete: true }
      );
    }
    // Preserve the previous catalog when republishing would drop a view it
    // actually has. Gating on "the previous catalog was complete" instead
    // failed both ways: an optional view that never works (COLUMNSTATISTICS
    // on a model that does not support it) keeps the status at incomplete
    // forever, which disabled this protection entirely and let a throttled
    // rebuild delete info_view_measures; and once the status was complete, a
    // rebuild missing only that same optional view was discarded for good,
    // freezing the catalog on the last snapshot that included it.
    const lost = (discovery.missing ?? []).filter((table) =>
      catalogHasTable(dbPath, table)
    );
    if (discovery.incomplete && lost.length > 0) {
      // Keep the previous catalog - a partial rebuild must never replace good
      // data. Keep the reason too: `catalog_status` describes the retained
      // snapshot, not this refresh, so these notes are the ONLY evidence that
      // the fetch failed, and they are what tells throttling (retry later)
      // apart from a permission or configuration problem (stop and fix
      // access).
      return reusedCatalogResult(
        dbPath,
        catalogPath,
        [
          `The refresh was incomplete and would have dropped ` +
            `${lost.map((table) => `\`${table}\``).join(', ')}, so the ` +
            'previous catalog was preserved. No new data was fetched; the ' +
            'catalog below is the earlier snapshot.',
          ...discovery.notes,
        ],
        { refreshIncomplete: true }
      );
    }

    const temporaryDbPath = `${dbPath}.${process.pid}.${randomUUID()}.tmp`;
    const temporaryCatalogPath = `${catalogPath}.${process.pid}.${randomUUID()}.tmp`;
    rmSync(temporaryDbPath, { force: true });
    rmSync(temporaryCatalogPath, { force: true });
    try {
      const built = populateDatabase(discovery.resultSets, temporaryDbPath);
      writeFileSync(
        temporaryCatalogPath,
        renderCatalog(built, {
          datasetId,
          notes: discovery.notes,
          incomplete: discovery.incomplete,
        }),
        'utf8'
      );
      publishFiles([
        {
          temporaryPath: temporaryDbPath,
          destinationPath: dbPath,
        },
        {
          temporaryPath: temporaryCatalogPath,
          destinationPath: catalogPath,
        },
      ]);
      return {
        ok: true,
        dbPath,
        catalogPath,
        built,
        notes: discovery.notes,
        incomplete: discovery.incomplete,
      };
    } finally {
      rmSync(temporaryDbPath, { force: true });
      rmSync(temporaryCatalogPath, { force: true });
    }
  };

  return withCatalogLock(
    dir,
    async (context) => {
      // A refresh can fail by throwing rather than by returning an error. On
      // Windows another process holding model.sqlite open - a second
      // schema:sql, a database browser - makes the publish rename fail with
      // EPERM after its retries. With a catalog already on disk that must not
      // cost the caller their query either, so it is handled exactly like the
      // failed refresh above: answer from the previous snapshot and let the
      // cooldown stop the next call from trying again immediately.
      const previousStatus = readCatalogStatus(dbPath);
      try {
        return await refreshCatalog(context);
      } catch (error) {
        if (previousStatus === null) {
          throw error;
        }
        return reusedCatalogResult(
          dbPath,
          catalogPath,
          [
            'The refresh could not be completed, so the previous catalog was ' +
              'preserved. No new data was fetched; the catalog below is the ' +
              'earlier snapshot.',
            error instanceof Error ? error.message : String(error),
          ],
          { refreshIncomplete: true }
        );
      }
    },
    lockOptions
  );
}

function tableNameFromResultRow(row) {
  if (row.kind != null && String(row.kind).toLocaleLowerCase() !== 'table') {
    return null;
  }
  for (const key of [
    'table_name',
    'tableName',
    'object_name',
    'Table',
    'Name',
  ]) {
    if (typeof row[key] === 'string' && row[key].length > 0) {
      return row[key];
    }
  }
  return null;
}

/**
 * Split SQL into coarse tokens: words, quoted identifiers, string literals and
 * single punctuation characters. Comments and whitespace are dropped.
 *
 * This is not a parser. It only has to be exact about where literals,
 * identifiers and comments end, so text inside them can never be mistaken for a
 * keyword, a table name, or a statement separator.
 */
export function sqlTokens(sql) {
  const text = String(sql);
  const tokens = [];
  let i = 0;
  const quoted = (open, close, type) => {
    let value = '';
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === close) {
        // A doubled delimiter is an escaped one, not the end.
        if (close === open && text[j + 1] === close) {
          value += close;
          j += 2;
          continue;
        }
        break;
      }
      value += text[j];
      j += 1;
    }
    tokens.push({ type, value });
    i = j + 1;
  };
  while (i < text.length) {
    const ch = text[i];
    if (/\s/u.test(ch)) {
      i += 1;
    } else if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === "'") {
      quoted("'", "'", 'string');
    } else if (ch === '"') {
      quoted('"', '"', 'identifier');
    } else if (ch === '`') {
      quoted('`', '`', 'identifier');
    } else if (ch === '[') {
      quoted('[', ']', 'identifier');
    } else if (/[\p{L}_]/u.test(ch)) {
      const match = /^[\p{L}\p{N}_$]+/u.exec(text.slice(i));
      tokens.push({ type: 'word', value: match[0] });
      i += match[0].length;
    } else if (/[0-9]/u.test(ch)) {
      const match = /^[0-9][0-9A-Za-z_.]*/u.exec(text.slice(i));
      tokens.push({ type: 'number', value: match[0] });
      i += match[0].length;
    } else {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
    }
  }
  return tokens;
}

const FROM_CLAUSE_TERMINATORS = new Set([
  'where',
  'group',
  'order',
  'limit',
  'having',
  'window',
]);

function isKeyword(token, ...words) {
  return (
    token?.type === 'word' && words.includes(token.value.toLocaleLowerCase())
  );
}

function isNamed(token, name) {
  return (
    (token?.type === 'word' || token?.type === 'identifier') &&
    token.value.toLocaleLowerCase() === name
  );
}

/**
 * True when every result row is an `info_view_tables` row: one SELECT whose
 * only top-level FROM source is `info_view_tables`, optionally aliased, with no
 * JOIN, comma join or compound operator.
 *
 * Subqueries in parentheses cannot change which table the rows come from, so
 * only top-level tokens are inspected.
 */
export function selectsOnlyTableRows(sql) {
  const topLevel = [];
  let depth = 0;
  for (const token of sqlTokens(sql)) {
    if (token.type === 'punct' && token.value === '(') {
      depth += 1;
    } else if (token.type === 'punct' && token.value === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      topLevel.push(token);
    }
  }
  while (topLevel.at(-1)?.type === 'punct' && topLevel.at(-1).value === ';') {
    topLevel.pop();
  }
  if (
    topLevel.some((token) =>
      isKeyword(token, 'join', 'union', 'intersect', 'except')
    )
  ) {
    return false;
  }
  const fromIndexes = topLevel
    .map((token, index) => (isKeyword(token, 'from') ? index : -1))
    .filter((index) => index >= 0);
  if (fromIndexes.length !== 1) {
    return false;
  }
  let next = fromIndexes[0] + 1;
  if (!isNamed(topLevel[next], 'info_view_tables')) {
    return false;
  }
  next += 1;
  if (isKeyword(topLevel[next], 'as')) {
    next += 1;
  }
  // An alias, if present. A bare word that begins the next clause is not one.
  const alias = topLevel[next];
  if (
    alias?.type === 'identifier' ||
    (alias?.type === 'word' &&
      !FROM_CLAUSE_TERMINATORS.has(alias.value.toLocaleLowerCase()))
  ) {
    next += 1;
  }
  // A comma here is a comma join, so the rows are no longer only table rows.
  return (
    next >= topLevel.length ||
    (topLevel[next].type === 'word' &&
      FROM_CLAUSE_TERMINATORS.has(topLevel[next].value.toLocaleLowerCase()))
  );
}

function enrichSelectedTablesWithOwnedMeasures(db, sql, rows) {
  // Only rows that ARE table rows may be enriched. Matching the table name
  // anywhere in the statement also fired on
  // `info_view_columns c JOIN info_view_tables t`, which returns column rows:
  // every one was read as a selected table, decorated with up to ten measures,
  // and the result blew the byte budget. The catalog itself documents that
  // join, so this is a query the agent is told to write.
  if (!selectsOnlyTableRows(sql)) {
    return rows;
  }
  const measureColumns = new Set(
    db
      .prepare('PRAGMA table_info("info_view_measures")')
      .all()
      .map((column) => column.name)
  );
  if (!measureColumns.has('Table') || !measureColumns.has('Name')) {
    return rows.map((row) =>
      tableNameFromResultRow(row)
        ? {
            ...row,
            ownedMeasuresUnavailable: true,
            ownedMeasureCount: null,
            ownedMeasures: null,
          }
        : row
    );
  }
  const fields = ['Name', 'DisplayFolder'].filter((field) =>
    measureColumns.has(field)
  );
  const lookup = db.prepare(
    `SELECT ${fields.map(quoteIdentifier).join(', ')} ` +
      `FROM "info_view_measures" ` +
      `WHERE lower("Table") = lower(?) ORDER BY "Name"`
  );

  return rows.map((row) => {
    const tableName = tableNameFromResultRow(row);
    if (!tableName) {
      return row;
    }
    const measures = lookup.all(tableName);
    return {
      ...row,
      ownedMeasureCount: measures.length,
      ownedMeasuresTruncated: measures.length > MAX_OWNED_MEASURE_PREVIEW,
      ownedMeasures: measures
        .slice(0, MAX_OWNED_MEASURE_PREVIEW)
        .map((measure) => ({
          name: measure.Name,
          displayFolder: measure.DisplayFolder ?? null,
        })),
      ownedMeasuresNeedDetail: measures.length > 0,
    };
  });
}

export function boundRows(
  rows,
  { limit = DEFAULT_PRINT_LIMIT, maxBytes = MAX_RESULT_BYTES, notes = [] } = {}
) {
  const total = rows.length;
  const kept = rows.slice(0, Math.max(0, limit));
  const rowLimitBound = kept.length < total;
  return boundResultRows(
    {
      ok: true,
      totalRows: total,
      returnedRows: kept.length,
      truncated: rowLimitBound,
      ...(rowLimitBound
        ? {
            truncation: {
              reason: 'row_limit',
              requiredAction: TRUNCATION_REQUIRED_ACTION,
            },
          }
        : {}),
      ...(notes.length ? { notes } : {}),
      rows: kept,
    },
    maxBytes
  );
}

// Drop whole rows until the serialized payload fits. Splitting the work out of
// boundRows lets a batch re-bound an already-built result against a smaller
// share without rebuilding it from the source rows.
function boundResultRows(result, maxBytes) {
  let candidate = result;
  let kept = result.rows;
  let bytes = Buffer.byteLength(formatResult(candidate), 'utf8');
  while (kept.length > 0 && bytes > maxBytes) {
    kept = kept.slice(0, Math.ceil(kept.length / 2));
    if (kept.length === candidate.returnedRows) {
      kept = kept.slice(0, -1);
    }
    candidate = {
      ...result,
      returnedRows: kept.length,
      truncated: true,
      truncation: {
        reason: result.truncation?.reason?.includes('row_limit')
          ? 'row_limit_and_byte_budget'
          : 'byte_budget',
        requiredAction: TRUNCATION_REQUIRED_ACTION,
      },
      rows: kept,
    };
    bytes = Buffer.byteLength(formatResult(candidate), 'utf8');
  }
  return candidate;
}

/**
 * Statement text after the first `;`, or null when there is none.
 *
 * `db.prepare()` compiles only the first statement, so anything after it never
 * runs while the answer still looks complete. Literals, quoted and bracketed
 * identifiers and comments are tokenized away first, so a `;` inside them is
 * not mistaken for a separator. A trailing `;` is fine.
 */
export function trailingStatement(sql) {
  const tokens = sqlTokens(sql);
  const end = tokens.findIndex(
    (token) => token.type === 'punct' && token.value === ';'
  );
  if (end < 0) {
    return null;
  }
  const rest = tokens
    .slice(end + 1)
    .filter((token) => !(token.type === 'punct' && token.value === ';'));
  return rest.length > 0 ? rest[0].value : null;
}

export function runSql(
  dbPath,
  sql,
  { limit = DEFAULT_PRINT_LIMIT, maxBytes = MAX_RESULT_BYTES } = {}
) {
  // Reject a second statement rather than answering the first and discarding
  // it silently: the agent asked two questions and would otherwise be told the
  // single answer is complete.
  const extra = trailingStatement(sql);
  if (extra !== null) {
    return {
      ok: false,
      error:
        `Only one statement runs per --sql, and text after the first ';' ` +
        `was ignored (starting at \`${extra}\`). Pass each statement as its ` +
        'own --sql; they still answer in one invocation.',
    };
  }
  // The open is inside the try: publication, a missing catalog, or a permission
  // problem must become this statement's error, not an exception that escapes
  // runBatch and discards every other statement's completed work.
  let db;
  try {
    db = openReadOnlyDatabase(dbPath);
    const rows = enrichSelectedTablesWithOwnedMeasures(
      db,
      sql,
      db.prepare(sql).all()
    );
    return boundRows(rows, { limit, maxBytes });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

function searchTokens(query) {
  if (Array.isArray(query)) {
    return [...new Set(query.filter(Boolean))];
  }
  return [
    ...new Set(
      String(query)
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((token) => token.trim())
        .filter(Boolean)
    ),
  ];
}

// One definition of "what search looks at", shared by ranking and by the
// relaxation below, so the two can never disagree about whether a term matches.
function searchableFields(row) {
  return {
    object_name: String(row.object_name ?? '').toLocaleLowerCase(),
    parent_name: String(row.parent_name ?? '').toLocaleLowerCase(),
    display_folder: String(row.display_folder ?? '').toLocaleLowerCase(),
    description: String(row.description ?? '').toLocaleLowerCase(),
    expression: String(row.expression ?? '').toLocaleLowerCase(),
    data_type: String(row.data_type ?? '').toLocaleLowerCase(),
    synonyms: String(row.synonyms ?? '').toLocaleLowerCase(),
  };
}

/** Terms that appear somewhere in this catalog, in the order supplied. */
export function matchedSearchTokens(rows, tokens) {
  const fields = (rows || []).map(searchableFields);
  return tokens.filter((token) =>
    fields.some((row) =>
      Object.values(row).some((value) => value.includes(token))
    )
  );
}

export function rankSemanticSearchRows(rows, query) {
  const tokens = searchTokens(query);
  if (tokens.length === 0) {
    throw new Error(
      'search requires at least one letter, number, or underscore.'
    );
  }
  const kindWeight = {
    measure: 12,
    table: 8,
    column: 4,
    relationship: 0,
  };
  return rows
    .map((row) => {
      const fields = searchableFields(row);
      const matchedFields = new Set();
      let score = kindWeight[row.kind] ?? 0;
      for (const token of tokens) {
        let tokenMatched = false;
        for (const [field, value] of Object.entries(fields)) {
          if (!value.includes(token)) {
            continue;
          }
          tokenMatched = true;
          matchedFields.add(field);
          const weight =
            field === 'object_name'
              ? value === token
                ? 100
                : value.startsWith(token)
                  ? 70
                  : 50
              : field === 'parent_name'
                ? value === token
                  ? 80
                  : value.startsWith(token)
                    ? 55
                    : 35
                : field === 'display_folder'
                  ? 20
                  : field === 'synonyms'
                    ? 18
                    : field === 'description'
                      ? 12
                      : field === 'expression'
                        ? 8
                        : 3;
          score += weight;
        }
        if (!tokenMatched) {
          return null;
        }
      }
      return {
        score,
        reason: [...matchedFields].join(', '),
        kind: row.kind,
        parent_name: row.parent_name,
        object_name: row.object_name,
        description: row.description,
        expression: row.expression,
        display_folder: row.display_folder,
        data_type: row.data_type,
        synonyms: row.synonyms,
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.kind.localeCompare(right.kind) ||
        left.parent_name.localeCompare(right.parent_name) ||
        left.object_name.localeCompare(right.object_name)
    );
}

// --- search payload trimming ------------------------------------------------
//
// Search is a findability surface, not a reading surface: the agent uses it to
// learn which objects exist, then reads detail with SQL. Two fields break that
// contract by carrying whole documents into every result page.
//
// Both are trimmed in the OUTPUT ONLY. Ranking above still sees the full text,
// so nothing becomes unfindable - the failure mode of simply dropping the rows.
//
// This is separate from, and complementary to, the owned-measure preview trim in
// enrichSelectedTablesWithOwnedMeasures: that bounds info_view_tables rows on the
// SQL path, this bounds semantic_search rows on the search path.

/** Expressions at or under this stay verbatim; a real measure definition is short. */
export const SEARCH_EXPRESSION_LIMIT = 120;

/**
 * A description shared by this many rows, and by this share of the described
 * rows, discriminates nothing between them.
 */
export const BOILERPLATE_MIN_ROWS = 8;
export const BOILERPLATE_MIN_SHARE = 0.2;

/**
 * Keep the head of a long expression and say how to get the rest.
 *
 * Localization measures are the pathological case - a `SWITCH(USERCULTURE(), ...)`
 * holding one sentence per locale runs to thousands of characters and computes
 * nothing - but the rule is general: search never needs a full definition.
 */
export function summarizeSearchExpression(expression) {
  const text = String(expression ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= SEARCH_EXPRESSION_LIMIT) {
    return text;
  }
  let head = text.slice(0, SEARCH_EXPRESSION_LIMIT);
  // Cut on a token boundary so the head stays readable DAX rather than half an
  // identifier the agent might copy.
  const boundary = Math.max(
    head.lastIndexOf(' '),
    head.lastIndexOf(','),
    head.lastIndexOf('(')
  );
  if (boundary > SEARCH_EXPRESSION_LIMIT / 2) {
    head = head.slice(0, boundary);
  }
  // A head with no separator in it at all gets no boundary rescue, so the raw
  // slice can land between a surrogate pair. Same rule as the batch labels.
  head = dropTrailingHighSurrogate(head);
  return (
    `${head.trimEnd()} \u2026 ` +
    `(${text.length} chars - read via substr([Expression], <offset>, 1000))`
  );
}

/** Description values repeated widely enough to carry no information. */
export function boilerplateDescriptions(rows) {
  const counts = new Map();
  let described = 0;
  for (const row of rows || []) {
    const text = String(row?.description ?? '').trim();
    if (!text) {
      continue;
    }
    described += 1;
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const boilerplate = new Set();
  for (const [text, count] of counts) {
    if (
      count >= BOILERPLATE_MIN_ROWS &&
      count >= described * BOILERPLATE_MIN_SHARE
    ) {
      boilerplate.add(text);
    }
  }
  return boilerplate;
}

/**
 * Apply both trims and report what was done once, rather than per row.
 *
 * `catalogRows` is the whole table so "boilerplate" means the same thing no
 * matter which subset a query happened to match.
 */
export function trimSearchRows(rankedRows, catalogRows) {
  const boilerplate = boilerplateDescriptions(catalogRows);
  let droppedDescriptions = 0;
  let summarizedExpressions = 0;

  const rows = rankedRows.map((row) => {
    const next = { ...row };
    const description = String(next.description ?? '').trim();
    if (description && boilerplate.has(description)) {
      next.description = null;
      droppedDescriptions += 1;
    }
    const expression = String(next.expression ?? '');
    if (expression) {
      const summary = summarizeSearchExpression(expression);
      if (summary !== expression) {
        summarizedExpressions += 1;
      }
      next.expression = summary;
    }
    return next;
  });

  return {
    rows,
    notes: searchTrimNotes(droppedDescriptions, summarizedExpressions),
  };
}

function searchTrimNotes(droppedDescriptions, summarizedExpressions) {
  const notes = [];
  if (droppedDescriptions > 0) {
    notes.push(
      `description omitted on ${droppedDescriptions} row(s): identical ` +
        'boilerplate shared across the model. It is still searched, just not ' +
        'reprinted.'
    );
  }
  if (summarizedExpressions > 0) {
    notes.push(
      `expression shortened on ${summarizedExpressions} row(s). Search ` +
        'matches the full text; SELECT the row for it.'
    );
  }
  return notes;
}

// Notes are reserved out of the batch byte budget before any statement runs, so
// a note built from agent-supplied query text has to have a computable maximum.
// The cap is in serialized UTF-8 BYTES, not UTF-16 length: forty CJK terms cost
// three times forty ASCII ones, and a length-based cap measured against a
// byte-based reserve overruns the share and aborts the whole batch.
const MAX_NOTE_TOKENS = 8;
const MAX_NOTE_TOKEN_CHARS = 40;
const MAX_NOTE_BYTES = 400;

/** A lone high surrogate left at a cut is not a character; drop it. */
function dropTrailingHighSurrogate(text) {
  return text.replace(/[\uD800-\uDBFF]$/u, '');
}

function clampNoteBytes(text) {
  if (Buffer.byteLength(text, 'utf8') <= MAX_NOTE_BYTES) {
    return text;
  }
  return `${fittingPrefix(text, (value) => `${value}\u2026`, MAX_NOTE_BYTES)}\u2026`;
}

function renderSearchTokens(tokens) {
  const shown = tokens
    .slice(0, MAX_NOTE_TOKENS)
    .map(
      (token) =>
        `"${dropTrailingHighSurrogate(String(token).slice(0, MAX_NOTE_TOKEN_CHARS))}"`
    );
  const extra = tokens.length - shown.length;
  return extra > 0 ? `${shown.join(', ')} and ${extra} more` : shown.join(', ');
}

function droppedTermsNote(termCount, dropped, useful) {
  return clampNoteBytes(
    `no object matched all ${termCount} terms, so ` +
      `${renderSearchTokens(dropped)} ` +
      `${dropped.length === 1 ? 'was' : 'were'} dropped: nothing in this ` +
      `model contains ${dropped.length === 1 ? 'it' : 'them'}. These rows ` +
      `matched ${renderSearchTokens(useful)}.`
  );
}

const NO_MATCH_NOTE =
  'no object matched every term. Search is an AND across names, ' +
  'descriptions, expressions, folders, and synonyms, so retry with fewer and ' +
  'more specific terms rather than a whole phrase.';

/**
 * The longest note set a search runner can produce, for budget reservation.
 *
 * The relaxation note is clamped to MAX_NOTE_BYTES whatever script it quotes,
 * so one ASCII byte per character is an exact upper bound rather than an
 * estimate that a non-Latin query can exceed.
 */
function worstCaseSearchNotes() {
  return [
    'x'.repeat(MAX_NOTE_BYTES),
    ...searchTrimNotes(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  ];
}

/**
 * Rank, and if nothing matched, say so usefully.
 *
 * Ranking is a strict AND: every term must appear somewhere in a row. That is
 * the right default - it is what makes a two-word query precise - but it turns
 * natural phrasing into a silent dead end, because one term the model has never
 * heard of empties the whole result. "sales amount by product" returns nothing
 * on a model that answers "sales amount" with two rows.
 *
 * So when, and only when, the strict pass found nothing, drop the terms that
 * match no row anywhere in this catalog and rank once more. Dropping a term
 * because THIS model does not contain it keeps the rule independent of language
 * and of any stop-word list, and the retry happens inside the same invocation,
 * which is the whole point of this file. A search that already found something
 * is never touched.
 */
export function rankSearchWithFallback(rows, query) {
  const ranked = rankSemanticSearchRows(rows, query);
  if (ranked.length > 0) {
    return { rows: ranked, notes: [] };
  }

  const tokens = searchTokens(query);
  const useful = matchedSearchTokens(rows, tokens);
  const dropped = tokens.filter((token) => !useful.includes(token));

  if (useful.length > 0 && dropped.length > 0) {
    const relaxed = rankSemanticSearchRows(rows, useful);
    if (relaxed.length > 0) {
      return {
        rows: relaxed,
        notes: [droppedTermsNote(tokens.length, dropped, useful)],
      };
    }
  }

  return { rows: [], notes: [NO_MATCH_NOTE] };
}

export function searchCatalog(dbPath, query, options = {}) {
  // Opened inside the try for the same reason as runSql.
  let db;
  try {
    db = openReadOnlyDatabase(dbPath);
    const rows = db
      .prepare(
        'SELECT kind, parent_name, object_name, description, ' +
          'expression, display_folder, data_type, synonyms ' +
          'FROM "semantic_search"'
      )
      .all();
    const ranked = rankSearchWithFallback(rows, query);
    const trimmed = trimSearchRows(ranked.rows, rows);
    return boundRows(trimmed.rows, {
      ...options,
      notes: [...ranked.notes, ...trimmed.notes],
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

export function resultExitCode(result, { allowTruncated = false } = {}) {
  if (!result?.ok) {
    return 1;
  }
  return result.truncated && !allowTruncated ? 2 : 0;
}

// --- batching ---------------------------------------------------------------
//
// One invocation costs one model round trip, and a round trip re-sends the
// entire conversation. Discovery is rarely a single question, so the batch is
// the cheap shape and the single statement is just a batch of one.

export const MAX_BATCH_STATEMENTS = 8;
const MAX_BATCH_LABEL_BYTES = 512;

// --file is an input channel, not a new capability: its contents run through the
// same runSql -> openReadOnlyDatabase path as positional SQL, so query_only
// still applies. What it does add is an unbounded read of an arbitrary path, so
// the size is capped before the file is loaded. A statement larger than this is
// a mistake, not a query.
const MAX_SQL_FILE_BYTES = 1_000_000;

function batchHeader(count, ok) {
  return `# ${JSON.stringify({ ok, batch: true, statements: count })}\n`;
}

// Longest prefix of `text` whose serialized form still fits `maxBytes`. The
// search is over characters but the budget is over UTF-8 bytes, so the two
// cannot be assumed proportional.
function fittingPrefix(text, serialize, maxBytes) {
  if (Buffer.byteLength(serialize(''), 'utf8') > maxBytes) {
    throw new Error('The byte budget cannot fit the required metadata.');
  }
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  const prefix = (length) => dropTrailingHighSurrogate(text.slice(0, length));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(serialize(prefix(middle)), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return prefix(low);
}

function batchLabel(entry, index) {
  // A --file statement is named by its path, not by its contents: the path is
  // what the caller actually typed, it is shorter, and it keeps file bytes out
  // of a payload that the agent did not ask to read.
  const field = entry.source ? 'source' : 'query';
  const text = entry.source ?? entry.query;
  const label = { index, kind: entry.kind, [field]: text };
  const serialize = (value) => `## ${JSON.stringify(value)}\n`;
  const full = serialize(label);
  if (Buffer.byteLength(full, 'utf8') <= MAX_BATCH_LABEL_BYTES) {
    return full;
  }
  const textBytes = Buffer.byteLength(text, 'utf8');
  const textHash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const summarized = (value) =>
    serialize({
      ...label,
      [field]: value,
      [`${field}Truncated`]: true,
      [`${field}Bytes`]: textBytes,
      [`${field}Hash`]: textHash,
    });
  return summarized(fittingPrefix(text, summarized, MAX_BATCH_LABEL_BYTES));
}

/**
 * Format several results as one payload.
 *
 * Each block is exactly what {@link formatResult} would have printed on its
 * own, introduced by a `##` line naming the statement. Keeping the
 * per-statement body byte-identical to the single-statement form means nothing
 * has to learn a second encoding, and TSV rows stay TSV rather than being
 * re-wrapped as JSON.
 */
export function formatBatch(entries) {
  const header = batchHeader(
    entries.length,
    entries.every((entry) => entry.result?.ok)
  );
  const blocks = entries.map(
    (entry, index) => `${batchLabel(entry, index)}${formatResult(entry.result)}`
  );
  return `${header}${blocks.join('')}`;
}

/**
 * Worst outcome across the batch, using the same codes as a single statement:
 * 1 for a failure, 2 for an untolerated truncation, 0 otherwise.
 *
 * A failure outranks a truncation because a truncated result is still evidence,
 * whereas a failed one is not.
 */
export function batchExitCode(entries, { allowTruncated = false } = {}) {
  let code = 0;
  for (const entry of entries) {
    const entryCode = resultExitCode(entry.result, { allowTruncated });
    if (entryCode === 1) {
      return 1;
    }
    if (entryCode === 2) {
      code = 2;
    }
  }
  return code;
}

/** The `## {...}` label line each batch block carries, in bytes. */
function batchLabelBytes(batch) {
  return batch.reduce(
    (total, entry, index) =>
      total + Buffer.byteLength(batchLabel(entry, index), 'utf8'),
    // A failing header is one byte longer than a successful one.
    Buffer.byteLength(batchHeader(batch.length, false), 'utf8')
  );
}

function batchResultReserve(kind) {
  // Reserve the largest empty-result metadata our runners can produce,
  // including search notes and row counts, before giving any statement room for
  // row data. An empty row set formats through the JSON branch, which is the
  // floor boundResultRows can always reach.
  return Buffer.byteLength(
    formatResult({
      ok: true,
      totalRows: Number.MAX_SAFE_INTEGER,
      returnedRows: 0,
      truncated: true,
      truncation: {
        reason: 'row_limit_and_byte_budget',
        requiredAction: TRUNCATION_REQUIRED_ACTION,
      },
      ...(kind === 'search' ? { notes: worstCaseSearchNotes() } : {}),
      rows: [],
    }),
    'utf8'
  );
}

function boundBatchResult(result, maxBytes) {
  if (Buffer.byteLength(formatResult(result), 'utf8') <= maxBytes) {
    return result;
  }
  if (result.ok) {
    return boundResultRows(result, maxBytes);
  }
  // A SQLite diagnostic quotes the offending SQL back, so a large statement
  // produces a large error. Keep it indexed and inside the budget.
  const text = String(result.error);
  const errorBytes = Buffer.byteLength(text, 'utf8');
  const summarized = (error) => ({
    ...result,
    error,
    errorTruncated: true,
    errorBytes,
  });
  return summarized(
    fittingPrefix(text, (error) => formatResult(summarized(error)), maxBytes)
  );
}

/**
 * Run a planned batch inside ONE byte budget.
 *
 * The per-statement cap exists because an answer that buries the session's
 * context is worse than no answer. Batching must not multiply that cap by the
 * number of statements, so the whole payload shares the single-statement
 * budget: each statement gets an equal share of what is left, and whatever it
 * does not use rolls forward to the next. A statement can therefore never
 * starve a later one, and a cheap statement makes an expensive one roomier.
 */
export function runBatch(
  batch,
  { runners, limit = DEFAULT_PRINT_LIMIT, maxBytes = MAX_RESULT_BYTES } = {}
) {
  const labels = batchLabelBytes(batch);
  const reserves = batch.map((entry) => batchResultReserve(entry.kind));
  let reserved = reserves.reduce((total, bytes) => total + bytes, 0);
  const minimumBytes = labels + reserved;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < minimumBytes) {
    throw new Error(
      `Batch byte budget must be an integer of at least ${minimumBytes} bytes.`
    );
  }
  let remaining = maxBytes - labels;
  const entries = [];
  batch.forEach((entry, index) => {
    const share =
      reserves[index] +
      Math.floor((remaining - reserved) / (batch.length - index));
    const result = boundBatchResult(
      runners[entry.kind](entry.query, { limit, maxBytes: share }),
      share
    );
    const bytes = Buffer.byteLength(formatResult(result), 'utf8');
    if (bytes > share) {
      throw new Error(
        `Statement ${index} metadata exceeds its batch byte budget. ` +
          TRUNCATION_REQUIRED_ACTION
      );
    }
    remaining -= bytes;
    reserved -= reserves[index];
    entries.push({ ...entry, result });
  });
  return entries;
}

function isInsideRoot(base, candidate) {
  return candidate === base || candidate.startsWith(base + sep);
}

function readSqlFile(path, root) {
  // Match the Rayfin CLI's own --file convention (connector-invoke.ts
  // readJsonInputFile): a statement file must live inside the app. Without
  // this, a mistyped path pulls unrelated file bytes into the agent's context
  // and SQLite quotes a fragment of them back in its syntax error.
  const base = resolve(root);
  const absolute = resolve(base, path);
  if (!isInsideRoot(base, absolute)) {
    return { error: `--file must be inside the app: ${path}` };
  }
  try {
    // Then check again after resolving links. A junction or symlink inside the
    // app that points outside it satisfies the purely lexical test above, so a
    // lexical check alone is containment that can be walked around. The CLI's
    // own check has this gap; we do not inherit it, because here the thing
    // being guarded is a catalog holding real column values.
    const realBase = realpathSync(base);
    const realPath = realpathSync(absolute);
    if (!isInsideRoot(realBase, realPath)) {
      return { error: `--file must be inside the app: ${path}` };
    }
    const stats = statSync(realPath);
    if (!stats.isFile()) {
      throw new Error('not a regular file');
    }
    if (stats.size > MAX_SQL_FILE_BYTES) {
      throw new Error(
        `${stats.size} bytes exceeds the ${MAX_SQL_FILE_BYTES}-byte limit ` +
          'for a single statement'
      );
    }
    return {
      query: readFileSync(realPath, 'utf8'),
      source: relative(realBase, realPath) || path,
    };
  } catch (error) {
    return {
      error:
        `Could not read --file ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Turn parsed CLI values into the ordered list of statements to run.
 *
 * Searches come before SQL because that is the order discovery actually happens
 * in: find the objects, then read their detail. `parseArgs` does not preserve
 * interleaved order across different option names, so each entry carries its
 * own query text and the caller never has to infer which result is which.
 *
 * Returns `{ error }`, or `{ batch, mode }` where mode is:
 *   "single" - one positional statement; print the original single-result payload
 *   "batch"  - one or more --search/--sql/--file statements; print the envelope
 *   "none"   - nothing to run
 */
export function planStatements({
  positionalSql = '',
  search = [],
  sql = [],
  file = [],
  root = process.cwd(),
} = {}) {
  const fromFiles = [];
  for (const path of file) {
    const read = readSqlFile(path, root);
    if (read.error) {
      return { error: read.error };
    }
    fromFiles.push({ kind: 'sql', query: read.query, source: read.source });
  }
  const batch = [
    ...search.map((query) => ({ kind: 'search', query })),
    ...sql.map((query) => ({ kind: 'sql', query })),
    ...fromFiles,
  ];

  if (positionalSql && batch.length > 0) {
    return {
      error: 'Use either positional SQL or --search/--sql/--file, not both.',
    };
  }
  if (batch.length > MAX_BATCH_STATEMENTS) {
    return {
      error:
        `Too many statements (${batch.length}); the limit is ` +
        `${MAX_BATCH_STATEMENTS}. Split them across two invocations.`,
    };
  }
  const empty = batch.find((entry) => !String(entry.query).trim());
  if (empty) {
    return {
      error:
        `An empty ${empty.kind} statement was supplied` +
        `${empty.source ? ` from ${empty.source}` : ''}.`,
    };
  }
  if (positionalSql) {
    return {
      batch: [{ kind: 'sql', query: positionalSql }],
      mode: 'single',
    };
  }
  return { batch, mode: batch.length > 0 ? 'batch' : 'none' };
}

export function modelCacheDir(root, datasetId) {
  if (!isFabricGuid(datasetId)) {
    throw new Error(
      `Invalid semantic-model itemId "${datasetId}". ` +
        'Expected a Fabric GUID from `rayfin connector list --json`.'
    );
  }
  const modelsRoot = resolve(root, 'models');
  const absolute = resolve(modelsRoot, datasetId);
  const rel = relative(modelsRoot, absolute);
  if (rel.startsWith('..') || resolve(modelsRoot, rel) !== absolute) {
    throw new Error('Resolved catalog path escaped the schema cache root.');
  }
  return join(root, 'models', datasetId);
}

export function ttlMinutes(explicit) {
  const raw = explicit ?? process.env.RAYFIN_SCHEMA_TTL_MINUTES;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MINUTES;
}

export function modelMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * A cooldown after a failed refresh, kept separate from the catalog's mtime.
 *
 * The catalog keeps its real age - faking freshness would make it lie about
 * itself - so without this marker every subsequent command sees "stale" and
 * re-fetches all five sources. The usual cause of a failed fetch is throttling,
 * and retrying immediately extends the block it is reacting to.
 */
export function refreshCooldown(dir, { now = Date.now } = {}) {
  try {
    const raw = JSON.parse(
      readFileSync(join(dir, REFRESH_COOLDOWN_FILE), 'utf8')
    );
    const until = Date.parse(raw?.retryAfter);
    if (!Number.isFinite(until) || until <= now()) {
      return null;
    }
    return { retryAfter: raw.retryAfter, reason: raw.reason ?? null };
  } catch {
    return null;
  }
}

export function recordRefreshCooldown(
  dir,
  reason,
  { now = Date.now, minutes = REFRESH_COOLDOWN_MINUTES } = {}
) {
  try {
    writeFileSync(
      join(dir, REFRESH_COOLDOWN_FILE),
      JSON.stringify({
        retryAfter: new Date(now() + minutes * 60_000).toISOString(),
        reason: reason ?? null,
      }),
      'utf8'
    );
    return { ok: true };
  } catch (error) {
    // Not worth failing a usable query over, but not worth hiding either: the
    // visible symptom would be the repeated-refresh behaviour this prevents,
    // with nothing to explain it.
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function clearRefreshCooldown(dir) {
  rmSync(join(dir, REFRESH_COOLDOWN_FILE), { force: true });
}

export function cacheStatus(
  mtimeMs,
  { ttl = DEFAULT_TTL_MINUTES, now = Date.now() } = {}
) {
  if (mtimeMs == null) {
    return {
      fresh: false,
      reason: 'no cached catalog on disk',
    };
  }
  const ageMinutes = (now - mtimeMs) / 60_000;
  if (!Number.isFinite(ageMinutes)) {
    return {
      fresh: false,
      reason: 'cached catalog has an unreadable timestamp',
    };
  }
  return {
    fresh: ageMinutes <= ttl,
    reason:
      `cached catalog is ${ageMinutes.toFixed(1)} min old ` +
      `(TTL ${ttl} min)`,
    ageMinutes,
  };
}

export function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      alias: { type: 'string', short: 'a' },
      limit: { type: 'string', short: 'l' },
      search: { type: 'string', multiple: true },
      sql: { type: 'string', multiple: true },
      file: { type: 'string', multiple: true },
      'allow-truncated': {
        type: 'boolean',
        default: false,
      },
      refresh: { type: 'boolean', default: false },
      help: {
        type: 'boolean',
        short: 'h',
        default: false,
      },
    },
  });
}

const USAGE = `Usage:
  npm run --silent schema:sql -- "SELECT ..."   Run SQL against the model catalog
  npm run --silent schema:sql -- --search "terms" Search all model metadata by relevance
  npm run --silent schema:refresh                 Rebuild the catalog from the model

Batch - one invocation, several answers. Prefer this: each extra invocation costs a
whole model round trip, so ask everything you already know you need at once.
  npm run --silent schema:sql -- --search "revenue" --sql "SELECT [Name] FROM info_view_tables" --sql "SELECT [Table], [Name] FROM info_view_measures"

Options:
  -a, --alias <name>     Rayfin semantic-model connector name
  -l, --limit <n>        Max rows to print per statement (default ${DEFAULT_PRINT_LIMIT})
      --search <terms>   Ranked catalog-wide semantic search (repeatable)
      --sql <text>       A SQL statement (repeatable)
      --file <path>      Read one SQL statement from a file (repeatable)
      --allow-truncated  Exit successfully with an incomplete preview
      --refresh          Rebuild even when the cache is fresh
  -h, --help             Show this help

At most ${MAX_BATCH_STATEMENTS} statements per invocation. The whole batch shares one byte budget,
so batching never costs more context than a single statement. Exit code is the worst
outcome: 1 if any statement failed, 2 if any was truncated OR an explicitly requested
--refresh could not fetch fresh data, 0 otherwise.

Environment:
  RAYFIN_SCHEMA_TTL_MINUTES  Catalog freshness window (default ${DEFAULT_TTL_MINUTES})
`;

async function main(argv) {
  const { values, positionals } = parseCliArgs(argv);
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Plan before touching the model: an argument mistake should not cost a
  // catalog build first.
  const plan = planStatements({
    positionalSql: positionals.join(' ').trim(),
    search: values.search ?? [],
    sql: values.sql ?? [],
    file: values.file ?? [],
  });
  if (plan.error) {
    process.stderr.write(`${plan.error}\n`);
    return 1;
  }
  if (plan.mode === 'none' && !values.refresh) {
    process.stdout.write(USAGE);
    return 0;
  }

  const resolved = await resolveAlias(process.cwd(), values.alias);
  if (resolved.error) {
    process.stderr.write(`${resolved.error}\n`);
    return 1;
  }
  const alias = resolved.alias;
  const identity = await resolveIdentity({
    alias,
    connector: resolved.connector,
    cwd: process.cwd(),
  });
  if (identity?.error) {
    process.stderr.write(`${identity.error}\n`);
    return 1;
  }
  if (!identity?.datasetId) {
    process.stderr.write(
      `Could not resolve which dataset "${alias}" points at. ` +
        'Run `npx rayfin connector list --json` from the app root.\n'
    );
    return 1;
  }

  const dir = modelCacheDir(CACHE_ROOT, identity.datasetId);
  const dbPath = join(dir, DATABASE_FILE);
  const status = cacheStatus(modelMtime(dbPath), {
    ttl: ttlMinutes(),
  });

  // Reusing a catalog is not by itself a failure. Three outcomes look alike
  // from the outside and must not be collapsed:
  //   - an explicit --refresh whose fetch failed: the requested action did not
  //     happen, so the status has to say so;
  //   - an automatic TTL rebuild that fell back: nobody asked for freshness,
  //     and a usable catalog is the right outcome;
  //   - a waiter reusing another process's newly completed refresh: the
  //     refresh did happen, just not here, so this is success.
  // Only the first sets refreshIncomplete, so that is what we branch on.
  let refreshUnsatisfied = false;
  // The cooldown exists to stop re-fetching when there is already something
  // good to serve. With no usable catalog there is nothing to serve, so
  // skipping the rebuild would lock the user out of a feature that has never
  // worked yet - strictly worse than the repeated fetching it prevents. An
  // explicit --refresh always retries regardless.
  const retained = readCatalogStatus(dbPath);
  const cooldown = values.refresh || !retained ? null : refreshCooldown(dir);
  const noteCooldown = (reason) => {
    if (!retained) {
      return;
    }
    const recorded = recordRefreshCooldown(dir, reason);
    if (!recorded.ok) {
      process.stderr.write(
        `Warning: could not record the refresh cooldown, so the next command ` +
          `will try to fetch again. ${recorded.error}\n`
      );
    }
  };
  if (values.refresh || (!status.fresh && !cooldown)) {
    process.stderr.write(`Building the model catalog - ${status.reason}.\n`);
    const result = await materializeCatalog({
      dir,
      datasetId: identity.datasetId,
      alias,
    });
    if (!result.ok) {
      noteCooldown(result.error);
      process.stderr.write(`${result.error}\n`);
      return 1;
    }
    if (result.refreshIncomplete) {
      noteCooldown(result.notes[1] ?? result.notes[0] ?? null);
    } else if (!result.reused) {
      clearRefreshCooldown(dir);
    }
    if (result.reused) {
      process.stderr.write(`Using ${result.dbPath}.\n`);
    } else {
      const shape = result.built
        .map((table) => `${table.table} (${table.rowCount})`)
        .join(', ');
      process.stderr.write(`Wrote ${result.dbPath}: ${shape}\n`);
    }
    for (const note of result.notes) {
      process.stderr.write(`Note: ${note}\n`);
    }
    if (result.refreshIncomplete && values.refresh) {
      refreshUnsatisfied = true;
      process.stderr.write(
        'Refresh not completed: you asked for fresh data and it could not be ' +
          'fetched. The notes above name the source that failed and why. The ' +
          'catalog below is the previous snapshot, so `catalog_status` still ' +
          'reads complete because it describes that earlier generation.\n'
      );
    }
    if (result.incomplete) {
      process.stderr.write(
        'Warning: this catalog is incomplete. Query `catalog_status` ' +
          'and read catalog.md before using absence as evidence. ' +
          'Run `npm run schema:refresh` to retry the missing views.\n'
      );
    }
    process.stderr.write(`Catalog: ${result.catalogPath}\n`);
  } else if (cooldown && !status.fresh) {
    process.stderr.write(
      `Note: the last refresh did not complete, so it is not retrying until ` +
        `${cooldown.retryAfter}. Answering from the catalog on disk. Run ` +
        'with --refresh to retry now.\n'
    );
    if (cooldown.reason) {
      process.stderr.write(`Note: ${cooldown.reason}\n`);
    }
  }

  if (plan.mode === 'none') {
    return refreshUnsatisfied ? 2 : 0;
  }

  const limit = Number(values.limit);
  const printLimit =
    Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PRINT_LIMIT;
  const runners = {
    search: (query, options) => searchCatalog(dbPath, query, options),
    sql: (query, options) => runSql(dbPath, query, options),
  };
  // A failed freshness request is not swallowed just because the SQL half
  // succeeded. Same precedence as a batch: failure outranks truncation.
  const withRefreshStatus = (code) => {
    if (code === 1) {
      return 1;
    }
    return refreshUnsatisfied || code === 2 ? 2 : 0;
  };

  // A lone positional statement keeps the original payload byte for byte, so
  // every existing instruction, parser, and truncation rule still holds.
  if (plan.mode === 'single') {
    const result = runners.sql(plan.batch[0].query, { limit: printLimit });
    if (!result.ok) {
      process.stderr.write(`${result.error}\n`);
      return 1;
    }
    process.stdout.write(formatResult(result));
    return withRefreshStatus(
      resultExitCode(result, {
        allowTruncated: values['allow-truncated'],
      })
    );
  }

  const entries = runBatch(plan.batch, { runners, limit: printLimit });

  // A failed statement inside a batch stays in the payload rather than going to
  // stderr: the other statements succeeded, and the agent needs to see which
  // one did not next to the ones that did.
  process.stdout.write(formatBatch(entries));
  return withRefreshStatus(
    batchExitCode(entries, {
      allowTruncated: values['allow-truncated'],
    })
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack || error}\n`);
      process.exitCode = 1;
    });
}
