//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// Batching and search-payload trimming.
//
// Both exist for the same reason: one invocation costs one model round trip, and
// a round trip re-sends the whole conversation. Batching removes round trips;
// trimming shrinks what each one carries forward. The trimming tests care most
// about what must NOT change - an object that was findable before has to stay
// findable.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';

import {
  batchExitCode,
  BOILERPLATE_MIN_ROWS,
  BOILERPLATE_MIN_SHARE,
  boilerplateDescriptions,
  buildDatabase,
  formatBatch,
  formatResult,
  MAX_BATCH_STATEMENTS,
  MAX_RESULT_BYTES,
  matchedSearchTokens,
  parseCliArgs,
  planStatements,
  publishFiles,
  rankSearchWithFallback,
  rankSemanticSearchRows,
  runBatch,
  runSql,
  searchCatalog,
  SEARCH_EXPRESSION_LIMIT,
  summarizeSearchExpression,
  trimSearchRows,
  withCatalogLock,
} from './schema-sql.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'schema-sql-batch-'));
}

function runnersFor(dbPath) {
  return {
    sql: (query, options) => runSql(dbPath, query, options),
    search: (query, options) => searchCatalog(dbPath, query, options),
  };
}

// -- Statement planning --

test('repeated --search/--sql/--file parse into arrays', () => {
  const { values, positionals } = parseCliArgs([
    '--search',
    'revenue',
    '--search',
    'margin',
    '--sql',
    'SELECT 1',
    '--file',
    'a.sql',
  ]);
  assert.deepEqual(values.search, ['revenue', 'margin']);
  assert.deepEqual(values.sql, ['SELECT 1']);
  assert.deepEqual(values.file, ['a.sql']);
  assert.deepEqual(positionals, []);
});

test('--profile stays removed rather than returning with the batch flags', () => {
  // It was deprecated on arrival and ignored by both resolvers. Upstream still
  // parses it; reintroducing it would give the agent an option that does nothing.
  assert.throws(
    () => parseCliArgs(['--profile', 'anything']),
    /unknown option|not (a )?known/iu
  );
});

test('a lone positional statement still plans as a single statement', () => {
  const plan = planStatements({ positionalSql: 'SELECT 1' });
  assert.equal(plan.mode, 'single');
  assert.equal(plan.batch.length, 1);
  assert.equal(plan.batch[0].query, 'SELECT 1');
});

test('searches are planned before SQL so results read in discovery order', () => {
  const plan = planStatements({
    search: ['revenue'],
    sql: ['SELECT 1', 'SELECT 2'],
  });
  assert.equal(plan.mode, 'batch');
  assert.deepEqual(
    plan.batch.map((entry) => entry.kind),
    ['search', 'sql', 'sql']
  );
  assert.deepEqual(
    plan.batch.map((entry) => entry.query),
    ['revenue', 'SELECT 1', 'SELECT 2']
  );
});

test('--file contributes its contents as a statement and remembers its source', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'q.sql');
    writeFileSync(path, 'SELECT [Name] FROM info_view_measures', 'utf8');
    const plan = planStatements({ file: [path], root: dir });
    assert.equal(plan.mode, 'batch');
    assert.equal(plan.batch[0].query, 'SELECT [Name] FROM info_view_measures');
    assert.equal(plan.batch[0].source, 'q.sql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable --file is reported rather than thrown', () => {
  const dir = tempDir();
  try {
    const plan = planStatements({
      file: [join(dir, 'missing.sql')],
      root: dir,
    });
    assert.match(plan.error, /Could not read --file/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('positional SQL and batch flags cannot be mixed', () => {
  const plan = planStatements({
    positionalSql: 'SELECT 1',
    sql: ['SELECT 2'],
  });
  assert.match(plan.error, /not both/u);
});

test('the batch size is capped so one call cannot become a whole workload', () => {
  const sql = Array.from(
    { length: MAX_BATCH_STATEMENTS + 1 },
    (_, index) => `SELECT ${index}`
  );
  const plan = planStatements({ sql });
  assert.match(plan.error, new RegExp(`limit is ${MAX_BATCH_STATEMENTS}`, 'u'));
});

test('an empty statement is rejected instead of running as blank SQL', () => {
  assert.match(planStatements({ sql: ['   '] }).error, /empty sql statement/u);
  assert.match(
    planStatements({ search: [''] }).error,
    /empty search statement/u
  );
});

test('no statements and no refresh plans nothing', () => {
  assert.equal(planStatements({}).mode, 'none');
});

// -- --file is an input channel, not a new capability --
//
// Everything reachable through --file was already reachable through positional
// SQL. Two things still needed closing, because --file is the only option that
// reads bytes the caller did not type:
//
//   1. the path is constrained to the app, matching the Rayfin CLI's own --file
//      convention (connector-invoke.ts readJsonInputFile), and
//   2. the printed label names the file rather than quoting its contents.
//
// Together those mean a mistyped path cannot pull unrelated file bytes into the
// agent's context, whether through the label or through a SQLite syntax error
// that quotes the offending token back.

test('a --file outside the app is refused before it is opened', () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    const path = join(outside, 'secret.txt');
    writeFileSync(path, 'NOT-A-REAL-CREDENTIAL-abcdef1234567890', 'utf8');

    const plan = planStatements({ file: [path], root: dir });
    assert.match(plan.error, /--file must be inside the app/u);
    assert.ok(
      !plan.error.includes('NOT-A-REAL-CREDENTIAL'),
      'the refusal must not quote what it refused to read'
    );

    // Traversal out of the app is the same refusal, not a different one.
    assert.match(
      planStatements({ file: ['../secret.txt'], root: dir }).error,
      /--file must be inside the app/u
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a --file statement is labelled by its path, not by the bytes it holds', (t) => {
  // The label is bounded at 512 bytes, so quoting file contents would spill up
  // to 512 bytes of an arbitrary in-app file into every batch payload. Naming
  // the file is both safer and a better label: it is what the caller typed.
  const marker = 'DISTINCTIVE-FILE-CONTENT-MARKER';
  const queries = [
    `SELECT marker FROM t WHERE id = 1 /* ${marker} ${'x'.repeat(4_000)} */`,
  ];
  const { labels, payload, executed } = batchFixture(t, queries, {
    via: 'file',
  });

  assert.equal(labels[0].source, 'statement 0.sql');
  assert.equal(labels[0].query, undefined);
  assert.ok(
    !payload.includes(marker),
    'no part of the file body may appear in the printed label'
  );
  assert.deepEqual(
    executed,
    queries,
    'the full file text still runs - only the label is shortened'
  );
});

test('file-sourced statements still share the one batch byte budget', (t) => {
  const rows = Array.from({ length: 200 }, (_, id) => ({
    id,
    marker: `${id} ${'value '.repeat(50)}`,
  }));
  const queries = Array.from({ length: 8 }, () => 'SELECT * FROM t');
  const { entries, bytes } = batchFixture(t, queries, { via: 'file', rows });

  assert.ok(bytes <= MAX_RESULT_BYTES, `batch emitted ${bytes} bytes`);
  for (const entry of entries) {
    assert.equal(entry.result.totalRows, rows.length);
    assert.ok(entry.result.returnedRows > 0, 'no statement was starved');
  }
  t.diagnostic(`eight file statements: ${bytes}/${MAX_RESULT_BYTES} bytes`);
});

test('SQL supplied through --file cannot escape the read-only connection', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [{ table: 't', grain: '', dax: '', rows: [{ secret: 'customer row' }] }],
      dbPath
    );

    const copiedPath = join(dir, 'exfiltrated.sqlite');
    const statementPath = join(dir, 'exfiltrate.sql');
    writeFileSync(
      statementPath,
      `VACUUM INTO '${copiedPath.replace(/'/gu, "''")}'`,
      'utf8'
    );

    const plan = planStatements({ file: [statementPath], root: dir });
    assert.equal(plan.mode, 'batch');
    const [entry] = runBatch(plan.batch, { runners: runnersFor(dbPath) });

    assert.equal(entry.result.ok, false);
    assert.match(entry.result.error, /read.?only|readonly/iu);
    assert.equal(
      existsSync(copiedPath) ? statSync(copiedPath).size : 0,
      0,
      'no catalog data may escape through a --file statement'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a query_only bypass cannot carry across two batch statements', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [{ table: 't', grain: '', dax: '', rows: [{ secret: 'customer row' }] }],
      dbPath
    );

    // On one reused connection PRAGMA query_only=OFF re-enables writes and the
    // VACUUM INTO that follows succeeds. Each batch entry opens its own
    // read-only connection, so the PRAGMA cannot carry into the next statement.
    const copiedPath = join(dir, 'exfiltrated.sqlite');
    const plan = planStatements({
      sql: [
        'PRAGMA query_only=OFF',
        `VACUUM INTO '${copiedPath.replace(/'/gu, "''")}'`,
      ],
      root: dir,
    });
    assert.equal(plan.mode, 'batch');
    const entries = runBatch(plan.batch, { runners: runnersFor(dbPath) });

    assert.equal(entries.length, 2);
    assert.equal(entries[1].result.ok, false);
    assert.match(entries[1].result.error, /read.?only|readonly/iu);
    assert.equal(
      existsSync(copiedPath) ? statSync(copiedPath).size : 0,
      0,
      'a PRAGMA in an earlier statement may not unlock a later write'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an oversized --file is rejected before it is read into memory', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'huge.sql');
    // Upstream reads --file unboundedly, which turns a wrong path into a memory
    // blowup. The cap is stated in the error so the limit is discoverable.
    writeFileSync(path, `-- ${'x'.repeat(1_000_001)}`, 'utf8');
    const plan = planStatements({ file: [path], root: dir });
    assert.match(plan.error, /Could not read --file/u);
    assert.match(plan.error, /exceeds the 1000000-byte limit/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --file that is not a regular file is reported, not read', () => {
  const dir = tempDir();
  try {
    const plan = planStatements({ file: [dir], root: dir });
    // Assert the guard's own message rather than just "could not read": a
    // directory would fail inside readFileSync anyway, so a loose match here
    // would be a test that cannot fail.
    assert.match(plan.error, /Could not read --file/u);
    assert.match(plan.error, /not a regular file/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Batch payload --

test('each batch block is byte-identical to the single-statement payload', () => {
  const result = {
    ok: true,
    totalRows: 1,
    returnedRows: 1,
    truncated: false,
    rows: [{ name: 'Revenue' }],
  };
  const out = formatBatch([{ kind: 'sql', query: 'SELECT 1', result }]);
  const lines = out.split('\n');
  assert.deepEqual(JSON.parse(lines[0].slice(2)), {
    ok: true,
    batch: true,
    statements: 1,
  });
  assert.deepEqual(JSON.parse(lines[1].slice(3)), {
    index: 0,
    kind: 'sql',
    query: 'SELECT 1',
  });
  // The body is still TSV - batching must not force results into JSON.
  assert.match(lines[2], /^# \{/u);
  assert.equal(lines[3], 'name');
  assert.equal(lines[4], 'Revenue');
});

test('a failed statement stays in the payload beside the ones that worked', () => {
  const out = formatBatch([
    {
      kind: 'sql',
      query: 'SELECT 1',
      result: {
        ok: true,
        totalRows: 1,
        returnedRows: 1,
        truncated: false,
        rows: [{ n: 1 }],
      },
    },
    {
      kind: 'sql',
      query: 'SELEKT',
      result: { ok: false, error: 'no such function: SELEKT' },
    },
  ]);
  assert.match(out, /"statements":2/u);
  assert.match(out, /"ok":false/u);
  assert.match(out, /no such function/u);
  assert.match(out, /"index":1/u);
});

test('the batch exit code is the worst outcome, and failure outranks truncation', () => {
  const ok = { ok: true, truncated: false };
  const cut = { ok: true, truncated: true };
  const bad = { ok: false, error: 'x' };
  const wrap = (results) =>
    results.map((result) => ({ kind: 'sql', query: 'q', result }));

  assert.equal(batchExitCode(wrap([ok, ok])), 0);
  assert.equal(batchExitCode(wrap([ok, cut])), 2);
  assert.equal(batchExitCode(wrap([cut, bad])), 1);
  assert.equal(batchExitCode(wrap([ok, cut]), { allowTruncated: true }), 0);
  assert.equal(batchExitCode(wrap([])), 0);
});

// -- The whole batch shares one byte budget --
//
// The per-statement cap exists so a result cannot bury the session's context.
// Batching must not multiply it by the number of statements, or it would make
// the very problem it is meant to reduce strictly worse.

test('a full batch of large results still fits the single-statement byte budget', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_measures',
          grain: '',
          dax: 'INFO.VIEW.MEASURES()',
          // Each row alone would blow a meaningful part of the budget.
          rows: Array.from({ length: 200 }, (_, index) => ({
            Table: 'Facts',
            Name: `Measure ${index}`,
            Description: `unique description ${index} ${'padding '.repeat(40)}`,
          })),
        },
      ],
      dbPath
    );

    const batch = Array.from({ length: MAX_BATCH_STATEMENTS }, () => ({
      kind: 'sql',
      query: 'SELECT * FROM info_view_measures',
    }));
    const entries = runBatch(batch, { runners: runnersFor(dbPath) });

    assert.equal(entries.length, MAX_BATCH_STATEMENTS);
    const payload = Buffer.byteLength(formatBatch(entries), 'utf8');
    assert.ok(
      payload <= MAX_RESULT_BYTES,
      `the whole batch must fit ${MAX_RESULT_BYTES} bytes, got ${payload}`
    );

    // The property that makes this worth asserting: eight statements did not
    // cost eight budgets. A per-statement cap would have allowed 8x this.
    const single = Buffer.byteLength(
      formatResult(runSql(dbPath, 'SELECT * FROM info_view_measures')),
      'utf8'
    );
    assert.ok(
      payload < single * 2,
      `a batch of ${MAX_BATCH_STATEMENTS} must not approach ${MAX_BATCH_STATEMENTS}x ` +
        `one statement: ${payload} vs ${single} each`
    );

    // Every statement still answered - bounded, not dropped.
    for (const entry of entries) {
      assert.equal(entry.result.ok, true);
      assert.ok(
        entry.result.returnedRows > 0,
        'no statement was starved to zero rows'
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unused share rolls forward, so a cheap statement makes a later one roomier', () => {
  const sizes = [];
  const runners = {
    sql: (query, options) => {
      sizes.push(options.maxBytes);
      // The first statement answers in almost nothing.
      return query === 'tiny'
        ? {
            ok: true,
            totalRows: 1,
            returnedRows: 1,
            truncated: false,
            rows: [{ a: 1 }],
          }
        : {
            ok: true,
            totalRows: 1,
            returnedRows: 1,
            truncated: false,
            rows: [{ a: 'x'.repeat(200) }],
          };
    },
    search: () => ({ ok: false, error: 'unused' }),
  };
  runBatch(
    [
      { kind: 'sql', query: 'tiny' },
      { kind: 'sql', query: 'big' },
    ],
    { runners, maxBytes: 10_000 }
  );

  assert.ok(
    sizes[1] > sizes[0],
    `expected the second share to grow: ${sizes[0]} -> ${sizes[1]}`
  );
});

function batchFixture(
  t,
  queries,
  { via = 'sql', rows = [{ id: 1, marker: 'unchanged SQL' }], ...options } = {}
) {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'budget.sqlite');
  buildDatabase([{ table: 't', grain: '', dax: '', rows }], dbPath);
  const args = queries.flatMap((query, index) => {
    if (via === 'sql') {
      return ['--sql', query];
    }
    const path = join(dir, `statement ${index}.sql`);
    writeFileSync(path, query, 'utf8');
    return ['--file', path];
  });
  const { values } = parseCliArgs(args);
  const plan = planStatements({ ...values, root: dir });
  assert.equal(plan.mode, 'batch');
  const executed = [];
  const runners = {
    sql: (query, limits) => {
      executed.push(query);
      return runSql(dbPath, query, limits);
    },
    search: (query, limits) => searchCatalog(dbPath, query, limits),
  };
  const entries = runBatch(plan.batch, { runners, ...options });
  assert.deepEqual(
    executed,
    queries,
    'execute the full original statement text, not its printed label'
  );
  const payload = formatBatch(entries);
  const bytes = Buffer.byteLength(payload, 'utf8');
  assert.ok(
    bytes <= (options.maxBytes ?? MAX_RESULT_BYTES),
    `batch emitted ${bytes} bytes`
  );
  const labels = payload
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => JSON.parse(line.slice(3)));
  return { entries, payload, bytes, labels, plan, runners, executed, dir };
}

for (const [name, count, padding] of [
  ['one oversized statement', 1, 'x'.repeat(30_000)],
  ['eight large statements', 8, 'x'.repeat(4_100)],
  ['Unicode and JSON escapes', 1, '\u03b1\u{1f642}"\\\t\n'.repeat(4_000)],
]) {
  test(`batch bounds printed labels from ${name} without altering SQL`, (t) => {
    const queries = Array.from(
      { length: count },
      (_, index) =>
        `SELECT marker FROM t /* ${index} ${padding} */ WHERE id = 1`
    );
    const { entries, labels, bytes } = batchFixture(t, queries);
    assert.equal(batchExitCode(entries), 0);
    for (const [index, entry] of entries.entries()) {
      assert.deepEqual(
        entry.result.rows.map((row) => ({ ...row })),
        [{ marker: 'unchanged SQL' }]
      );
      assert.equal(labels[index].index, index);
      assert.equal(labels[index].kind, 'sql');
      assert.ok(queries[index].startsWith(labels[index].query));
      assert.equal(labels[index].queryTruncated, true);
      assert.equal(
        labels[index].queryBytes,
        Buffer.byteLength(queries[index], 'utf8')
      );
      assert.equal(
        labels[index].queryHash,
        createHash('sha256').update(queries[index]).digest('hex').slice(0, 16)
      );
      assert.ok(
        !/[\uD800-\uDBFF]$/u.test(labels[index].query),
        'do not split a surrogate pair'
      );
    }
    t.diagnostic(`${name}: ${bytes}/${MAX_RESULT_BYTES} UTF-8 bytes`);
  });
}

test('eight long labels leave fair shares for rows and preserve recovery metadata', (t) => {
  const rows = Array.from({ length: 200 }, (_, id) => ({
    id,
    marker: `${id} ${'value '.repeat(50)}`,
  }));
  const queries = Array.from(
    { length: 8 },
    () => `SELECT * FROM t /* ${'x'.repeat(4_100)} */`
  );
  const { entries, bytes } = batchFixture(t, queries, { rows });
  assert.equal(batchExitCode(entries), 2);
  for (const entry of entries) {
    assert.equal(entry.result.totalRows, rows.length);
    assert.ok(
      entry.result.returnedRows > 0,
      'labels cannot starve later statements'
    );
    assert.equal(entry.result.truncated, true);
    assert.match(
      entry.result.truncation.requiredAction,
      /narrower WHERE|smaller projection/u
    );
    assert.deepEqual(Object.keys(entry.result.rows[0]), ['id', 'marker']);
  }
  t.diagnostic(`labels and row data: ${bytes}/${MAX_RESULT_BYTES} UTF-8 bytes`);
});

test('large SQLite diagnostics stay indexed errors inside the final budget', (t) => {
  const missing = 'missing_\u03b1\u{1f642}\\"'
    .repeat(4_000)
    .replace(/"/gu, '""');
  const { entries, payload, bytes } = batchFixture(t, [
    'SELECT marker FROM t',
    `SELECT * FROM "${missing}"`,
    'SELEKT broken',
    'SELECT marker FROM t WHERE id = 1',
  ]);
  assert.equal(batchExitCode(entries, { allowTruncated: true }), 1);
  assert.equal(entries[0].result.ok, true);
  assert.equal(entries[3].result.ok, true);
  assert.equal(entries[1].result.ok, false);
  assert.match(entries[1].result.error, /no such table/u);
  assert.equal(entries[1].result.errorTruncated, true);
  assert.ok(entries[1].result.errorBytes > MAX_RESULT_BYTES);
  assert.match(entries[2].result.error, /syntax error/u);
  assert.equal(JSON.parse(payload.split('\n')[0].slice(2)).ok, false);
  t.diagnostic(`long error: ${bytes}/${MAX_RESULT_BYTES} UTF-8 bytes`);
});

test('an all-error batch can fill the exact cap without a one-byte header overrun', (t) => {
  const queries = Array.from(
    { length: 2 },
    (_, index) => `SELECT * FROM "missing_${index}_${'x'.repeat(30_000)}"`
  );
  const { entries, bytes } = batchFixture(t, queries);
  assert.equal(bytes, MAX_RESULT_BYTES);
  assert.equal(batchExitCode(entries), 1);
  assert.ok(
    entries.every(
      (entry) => entry.result.ok === false && entry.result.errorTruncated
    )
  );
  assert.ok(
    entries.every((entry) =>
      entry.result.error.startsWith('no such table: missing_')
    )
  );
  t.diagnostic(`all-error batch: ${bytes}/${MAX_RESULT_BYTES} UTF-8 bytes`);
});

test('short query labels and result blocks retain their original serialized form', (t) => {
  const queries = [
    'SELECT marker FROM t',
    'SELECT marker FROM t WHERE id = 0',
    'SELEKT broken',
  ];
  const { entries, payload, labels } = batchFixture(t, queries);
  const expected =
    '# {"ok":false,"batch":true,"statements":3}\n' +
    entries
      .map(
        (entry, index) =>
          `## ${JSON.stringify({ index, kind: 'sql', query: queries[index] })}\n` +
          formatResult(entry.result)
      )
      .join('');
  assert.equal(payload, expected);
  assert.deepEqual(
    labels,
    queries.map((query, index) => ({ index, kind: 'sql', query }))
  );
  assert.equal(entries[1].result.totalRows, 0);
  assert.equal(entries[1].result.truncated, false);
});

test('batch byte boundaries include escaped labels, errors and result metadata', (t) => {
  const queries = [
    'SELECT marker FROM t /* "\u{1f642}\\ */',
    'SELECT * FROM t WHERE id = 0',
    'SELEKT broken',
  ];
  for (const maxBytes of [
    2_000,
    2_001,
    4_096,
    MAX_RESULT_BYTES - 1,
    MAX_RESULT_BYTES,
  ]) {
    const { entries } = batchFixture(t, queries, { maxBytes });
    assert.equal(batchExitCode(entries), 1);
    assert.equal(entries[1].result.truncated, false);
  }
});

test('budgets too small for batch metadata fail explicitly before execution', () => {
  let executions = 0;
  const runners = {
    sql: () => {
      executions += 1;
      return {
        ok: true,
        totalRows: 0,
        returnedRows: 0,
        truncated: false,
        rows: [],
      };
    },
  };
  for (const maxBytes of [0, 1, 100, -1, NaN, Infinity]) {
    assert.throws(
      () =>
        runBatch([{ kind: 'sql', query: 'SELECT 1' }], { runners, maxBytes }),
      /budget|bytes/iu
    );
  }
  assert.equal(executions, 0);
});

test('label limits use serialized UTF-8 bytes and only summarize above the boundary', (t) => {
  const base = 'SELECT marker FROM t /* "\\\u{1f642} */';
  const labelBytes = Buffer.byteLength(
    `## ${JSON.stringify({ index: 0, kind: 'sql', query: base })}\n`
  );
  for (const offset of [-1, 0, 1]) {
    const query = base + ' '.repeat(512 - labelBytes + offset);
    const { payload, labels } = batchFixture(t, [query]);
    const label = `${payload.split('\n')[1]}\n`;
    assert.ok(Buffer.byteLength(label) <= 512);
    assert.equal(labels[0].queryTruncated, offset > 0 ? true : undefined);
    if (offset <= 0) {
      assert.equal(labels[0].query, query);
      assert.equal(Buffer.byteLength(label), 512 + offset);
    }
  }
});

test('exact final budget includes the failing header and trims whole rows one byte below it', (t) => {
  const fixture = batchFixture(t, ['SELEKT', 'SELECT marker FROM t'], {
    rows: [{ marker: 'x'.repeat(2_000) }],
  });
  const exact = runBatch(fixture.plan.batch, {
    runners: fixture.runners,
    maxBytes: fixture.bytes,
  });
  assert.equal(formatBatch(exact), fixture.payload);
  assert.equal(Buffer.byteLength(formatBatch(exact)), fixture.bytes);
  const below = runBatch(fixture.plan.batch, {
    runners: fixture.runners,
    maxBytes: fixture.bytes - 1,
  });
  assert.ok(Buffer.byteLength(formatBatch(below)) <= fixture.bytes - 1);
  assert.equal(below[0].result.error, exact[0].result.error);
  assert.equal(below[1].result.totalRows, 1);
  assert.equal(below[1].result.returnedRows, 0);
  assert.equal(below[1].result.truncated, true);
  assert.equal(below[1].result.truncation.reason, 'byte_budget');
  assert.equal(batchExitCode(below), 1);
});

test('minimum supported budget reserves all metadata before running any statement', (t) => {
  const fixture = batchFixture(
    t,
    [
      'SELECT marker FROM t WHERE id = 0',
      'SELECT marker FROM t',
      'SELECT marker FROM t',
    ],
    { rows: [{ id: 1, marker: 'x'.repeat(30_000) }] }
  );
  fixture.executed.length = 0;
  let minimum;
  assert.throws(
    () =>
      runBatch(fixture.plan.batch, { runners: fixture.runners, maxBytes: 0 }),
    (error) => {
      minimum = Number(/at least (\d+) bytes/u.exec(error.message)?.[1]);
      return Number.isSafeInteger(minimum) && minimum > 0;
    }
  );
  assert.throws(
    () =>
      runBatch(fixture.plan.batch, {
        runners: fixture.runners,
        maxBytes: minimum - 1,
      }),
    /byte budget/u
  );
  assert.deepEqual(fixture.executed, []);
  for (const maxBytes of [minimum, minimum + 1]) {
    const entries = runBatch(fixture.plan.batch, {
      runners: fixture.runners,
      maxBytes,
    });
    assert.ok(Buffer.byteLength(formatBatch(entries)) <= maxBytes);
    assert.equal(
      entries[0].result.truncated,
      false,
      'empty is complete, not truncated'
    );
    for (const entry of entries.slice(1)) {
      assert.equal(entry.result.totalRows, 1);
      assert.equal(entry.result.returnedRows, 0);
      assert.equal(entry.result.truncated, true);
      assert.match(
        entry.result.truncation.requiredAction,
        /before using this result/u
      );
    }
  }
  t.diagnostic(`minimum supported three-statement budget: ${minimum} bytes`);
});

test('bounded UTF-8 batches retain complete row values or explicit truncation across encodings', (t) => {
  const cells = ['plain', '"\\\u03b1\u{1f642}', 'line1\nline2\t"\\\u{1f642}'];
  for (const [index, cell] of cells.entries()) {
    for (const count of [1, 2, 8]) {
      const rows = Array.from({ length: 30 }, (_, id) => ({
        id,
        marker: cell.repeat(20 + id),
      }));
      const queries = Array.from(
        { length: count },
        (_, position) =>
          `SELECT * FROM t /* ${position} ${cell.repeat(300 + index)} */`
      );
      const fixture = batchFixture(t, queries, {
        rows,
        maxBytes: 8_000 + index,
        limit: 20,
      });
      for (const entry of fixture.entries) {
        assert.equal(entry.result.totalRows, rows.length);
        assert.equal(entry.result.returnedRows, entry.result.rows.length);
        assert.equal(entry.result.truncated, true);
        assert.deepEqual(
          entry.result.rows.map((row) => ({ ...row })),
          rows.slice(0, entry.result.returnedRows)
        );
        assert.match(entry.result.truncation.reason, /row_limit/u);
        assert.match(entry.result.truncation.requiredAction, /narrower WHERE/u);
      }
    }
  }
});

test('minimum search shares preserve notes and indexed errors beside other statements', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'search.sqlite');
  buildDatabase(
    [
      {
        table: 'info_view_measures',
        grain: '',
        dax: '',
        rows: Array.from({ length: 30 }, (_, index) => ({
          Table: 'Facts',
          Name: `Metric ${index}`,
          Description: 'Shared description',
          Expression: 'measure '.repeat(100),
        })),
      },
    ],
    dbPath
  );
  const { values } = parseCliArgs([
    '--search',
    'metric',
    '--search',
    '!!!',
    '--sql',
    'SELECT 1 AS n',
  ]);
  const plan = planStatements(values);
  const runners = runnersFor(dbPath);
  let minimum;
  assert.throws(
    () => runBatch(plan.batch, { runners, maxBytes: 0 }),
    (error) => {
      minimum = Number(/at least (\d+) bytes/u.exec(error.message)?.[1]);
      return Number.isSafeInteger(minimum);
    }
  );
  const entries = runBatch(plan.batch, { runners, maxBytes: minimum });
  assert.ok(Buffer.byteLength(formatBatch(entries)) <= minimum);
  assert.equal(entries[0].result.totalRows, 30);
  assert.equal(entries[0].result.truncated, true);
  assert.equal(entries[0].result.notes.length, 2);
  assert.match(entries[0].result.notes[0], /description omitted/u);
  assert.match(entries[0].result.notes[1], /expression shortened/u);
  assert.match(entries[1].result.error, /search requires/u);
  assert.equal(entries[2].result.rows[0].n, 1);
  assert.equal(batchExitCode(entries), 1);
});

// -- The workload batching exists for --
//
// schema-discovery/SKILL.md documents a five-query sequence that an agent runs
// back to back after one --search. That is the shape this must hold at, not a
// pair of toy SELECTs, and it is the shape where the owned-measure enrichment
// on info_view_tables competes for the same budget.

function realisticModel() {
  const tables = ['Sales', 'Date', 'Product', 'Customer', 'Store', 'Geography'];
  return [
    {
      table: 'info_view_tables',
      grain: '',
      dax: 'INFO.VIEW.TABLES()',
      rows: tables.map((name) => ({
        Name: name,
        Description: `${name} dimension or fact table for the retail model`,
        IsHidden: false,
      })),
    },
    {
      table: 'info_view_measures',
      grain: '',
      dax: 'INFO.VIEW.MEASURES()',
      rows: [
        // Headline business measures, so the --search pass matches the way it
        // would on a real model rather than returning an empty set.
        ...Array.from({ length: 4 }, (_, index) => ({
          Table: 'Sales',
          Name: `Revenue by Region ${index}`,
          Expression: `CALCULATE(SUM('Sales'[Amount]), ALLEXCEPT('Geography', 'Geography'[Region]))`,
          Description: 'Revenue comparison across region for the period.',
          FormatString: '$#,0',
          DisplayFolder: 'Sales\\Revenue',
        })),
        ...tables.flatMap((table) =>
          Array.from({ length: 12 }, (_, index) => ({
            Table: table,
            Name: `${table} Measure ${index}`,
            Expression: `CALCULATE(SUM('${table}'[Amount]), ALLEXCEPT('${table}', '${table}'[Key]))`,
            Description: `Aggregates ${table} amount for reporting purposes.`,
            FormatString: '$#,0',
            DisplayFolder: `${table}\\Core`,
          }))
        ),
      ],
    },
    {
      table: 'info_view_columns',
      grain: '',
      dax: 'INFO.VIEW.COLUMNS()',
      rows: tables.flatMap((table) =>
        Array.from({ length: 14 }, (_, index) => ({
          Table: table,
          Name: `${table} Column ${index}`,
          DataType: index % 2 === 0 ? 'String' : 'Decimal',
          Description: `Column ${index} of ${table}.`,
          FormatString: '',
          IsHidden: false,
        }))
      ),
    },
    {
      table: 'info_view_relationships',
      grain: '',
      dax: 'INFO.VIEW.RELATIONSHIPS()',
      rows: tables.slice(1).map((table) => ({
        FromTable: 'Sales',
        FromColumn: `${table}Key`,
        ToTable: table,
        ToColumn: `${table}Key`,
        IsActive: true,
        CrossFilteringBehavior: 'OneDirection',
      })),
    },
    {
      table: 'column_statistics',
      grain: '',
      dax: 'COLUMNSTATISTICS()',
      rows: tables.flatMap((table) =>
        Array.from({ length: 6 }, (_, index) => ({
          'Table Name': table,
          'Column Name': `${table} Column ${index}`,
          Min: '1',
          Max: '99999',
          Cardinality: 1000 + index,
          'Max Length': 64,
        }))
      ),
    },
  ];
}

test('the documented six-step discovery sequence answers in one shared budget', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'model.sqlite');
  buildDatabase(realisticModel(), dbPath);

  // Verbatim shapes from schema-discovery/SKILL.md, narrowed the way that file
  // instructs, plus the --search pass that precedes them.
  const { values } = parseCliArgs([
    '--search',
    'revenue region comparison',
    '--sql',
    "SELECT [Name], [Description], [IsHidden] FROM info_view_tables WHERE lower([Name]) LIKE '%sales%'",
    '--sql',
    "SELECT [Table], [Name], [Expression], [Description], [FormatString], [DisplayFolder] FROM info_view_measures WHERE [Table] IN ('Sales', 'Date') ORDER BY [Table], [Name]",
    '--sql',
    "SELECT [Table], [Name], [DataType], [Description], [FormatString], [IsHidden] FROM info_view_columns WHERE [Table] IN ('Sales', 'Date') ORDER BY [Table], [Name]",
    '--sql',
    "SELECT [FromTable], [FromColumn], [ToTable], [ToColumn], [IsActive], [CrossFilteringBehavior] FROM info_view_relationships WHERE [FromTable] IN ('Sales', 'Date') OR [ToTable] IN ('Sales', 'Date')",
    '--sql',
    "SELECT [Table Name], [Column Name], [Min], [Max], [Cardinality], [Max Length] FROM column_statistics WHERE [Table Name] = 'Date'",
  ]);
  const plan = planStatements(values);
  assert.equal(plan.batch.length, 6);

  const entries = runBatch(plan.batch, { runners: runnersFor(dbPath) });
  const bytes = Buffer.byteLength(formatBatch(entries), 'utf8');

  assert.ok(
    bytes <= MAX_RESULT_BYTES,
    `six real discovery statements must fit ${MAX_RESULT_BYTES} bytes, got ${bytes}`
  );
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.result.ok, true, `statement ${index} failed`);
    assert.ok(
      entry.result.returnedRows > 0,
      `statement ${index} was starved to zero rows`
    );
  }

  // The info_view_tables statement still carries the owned-measure enrichment,
  // so P5 and the H2 preview trim coexist inside the same shared budget.
  const tablesRow = entries[1].result.rows[0];
  assert.equal(tablesRow.ownedMeasureCount, 16);
  assert.equal(tablesRow.ownedMeasuresTruncated, true);
  assert.equal(tablesRow.ownedMeasuresNeedDetail, true);
  assert.equal(tablesRow.ownedMeasures.length, 10);
  assert.deepEqual(Object.keys(tablesRow.ownedMeasures[0]), [
    'name',
    'displayFolder',
  ]);

  // And the search block reports its own trimming rather than silently
  // shortening what it printed.
  assert.ok(entries[0].result.totalRows > 0);

  t.diagnostic(
    `six documented discovery statements: ${bytes}/${MAX_RESULT_BYTES} UTF-8 bytes`
  );
});

// -- A zero-result search must not be a silent dead end (F1) --

test('a term this model has never heard of does not empty the whole result', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: [
            {
              Table: 'Sales',
              Name: 'Total Sales Amount',
              Expression: 'SUM(1)',
            },
            { Table: 'Sales', Name: 'Sales Amount LY', Expression: 'SUM(2)' },
          ],
        },
      ],
      dbPath
    );

    // The strict AND is unchanged and still precise.
    assert.equal(searchCatalog(dbPath, 'sales amount').totalRows, 2);

    // "by" appears nowhere in this catalog, so upstream returns zero rows for
    // the user's natural phrasing. The relaxed pass answers instead.
    const natural = searchCatalog(dbPath, 'sales amount by');
    assert.equal(natural.ok, true);
    assert.equal(natural.totalRows, 2);
    assert.match(natural.notes[0], /no object matched all 3 terms/u);
    assert.match(natural.notes[0], /"by"/u);
    assert.match(natural.notes[0], /was dropped/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a search that already found rows is never relaxed', () => {
  const rows = [
    { kind: 'measure', object_name: 'Revenue', parent_name: 'Sales' },
    { kind: 'measure', object_name: 'Cost', parent_name: 'Sales' },
  ];
  const strict = rankSearchWithFallback(rows, 'sales revenue');
  assert.deepEqual(
    strict.rows,
    rankSemanticSearchRows(rows, 'sales revenue'),
    'the successful path must be byte-identical to plain ranking'
  );
  assert.deepEqual(strict.notes, [], 'and must say nothing extra');
});

test('a search that matches nothing at all says how to retry', () => {
  const rows = [{ kind: 'measure', object_name: 'Revenue', parent_name: 'S' }];
  const missed = rankSearchWithFallback(rows, 'zzz qqq');
  assert.deepEqual(missed.rows, []);
  assert.equal(missed.notes.length, 1);
  assert.match(missed.notes[0], /retry with fewer and more specific terms/u);
});

test('relaxation only drops terms absent from this model, not a word list', () => {
  // "by" is a stop word in English and nothing in the other direction: the rule
  // has to be about the catalog, or it stops working in another locale.
  const rows = [
    { kind: 'column', object_name: 'Byte Size', parent_name: 'Files' },
  ];
  assert.deepEqual(matchedSearchTokens(rows, ['by']), ['by']);
  assert.deepEqual(matchedSearchTokens(rows, ['by', 'zzz']), ['by']);
  // A term the model does contain is kept even when it reads like noise, so a
  // query of only such terms still answers strictly.
  assert.equal(rankSearchWithFallback(rows, 'by').rows.length, 1);
});

test('the relaxation note is bounded, so the batch reserve can cover it', (t) => {
  // The note quotes query terms, and the query is agent-supplied. An unbounded
  // note would overrun the share reserved for it before any row is printed.
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'm.sqlite');
  buildDatabase(
    [
      {
        table: 'info_view_measures',
        grain: '',
        dax: '',
        rows: [{ Table: 'Sales', Name: 'Revenue', Expression: 'SUM(1)' }],
      },
    ],
    dbPath
  );

  const absurd = `revenue ${Array.from({ length: 50 }, (_, index) => `${'z'.repeat(200)}${index}`).join(' ')}`;
  const out = searchCatalog(dbPath, absurd);
  assert.equal(out.totalRows, 1, 'the one real term still answers');
  assert.ok(
    Buffer.byteLength(out.notes.join(''), 'utf8') < 1_000,
    `the note must stay bounded, got ${out.notes.join('').length} chars`
  );

  // And the whole thing still fits a batch beside another statement.
  const entries = runBatch(
    [
      { kind: 'search', query: absurd },
      { kind: 'sql', query: 'SELECT 1 AS n' },
    ],
    { runners: runnersFor(dbPath) }
  );
  assert.equal(entries[0].result.totalRows, 1);
  assert.equal(entries[1].result.rows[0].n, 1);
  assert.ok(
    Buffer.byteLength(formatBatch(entries), 'utf8') <= MAX_RESULT_BYTES
  );
});

// -- Owned-measure detail is a per-row signal, not a banner (F2) --

test('a table with no owned measures is not told to go fetch them', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: '',
          rows: [{ Name: 'Sales' }, { Name: 'Sales Territory' }],
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: [{ Table: 'Sales', Name: 'Revenue', DisplayFolder: 'Finance' }],
        },
      ],
      dbPath
    );

    const out = runSql(dbPath, 'SELECT [Name] FROM info_view_tables');
    const byName = Object.fromEntries(out.rows.map((row) => [row.Name, row]));

    assert.equal(byName.Sales.ownedMeasureCount, 1);
    assert.equal(byName.Sales.ownedMeasuresNeedDetail, true);

    assert.equal(byName['Sales Territory'].ownedMeasureCount, 0);
    assert.equal(
      byName['Sales Territory'].ownedMeasuresNeedDetail,
      false,
      'there is nothing to fetch, so do not send the agent to fetch it'
    );
    // The key set stays identical across rows either way.
    assert.deepEqual(
      Object.keys(byName.Sales),
      Object.keys(byName['Sales Territory'])
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Publication must stay visible, and a failed open is one statement's
//    problem, not the batch's (A4) --

test('publication never leaves the destination missing', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    const catalogPath = join(dir, 'catalog.md');
    writeFileSync(dbPath, 'previous database', 'utf8');
    writeFileSync(catalogPath, 'previous catalog', 'utf8');
    const temporaryDb = join(dir, 'next.sqlite.tmp');
    const temporaryCatalog = join(dir, 'next.md.tmp');
    writeFileSync(temporaryDb, 'next database', 'utf8');
    writeFileSync(temporaryCatalog, 'next catalog', 'utf8');

    // Observe the live path after every filesystem step. Backing the previous
    // generation up by renaming it away made this false in the middle, and a
    // reader landing there got "unable to open database file".
    const seen = [];
    const observe =
      (operation) =>
      (...args) => {
        const result = operation(...args);
        seen.push(existsSync(dbPath));
        return result;
      };
    publishFiles(
      [
        { temporaryPath: temporaryDb, destinationPath: dbPath },
        { temporaryPath: temporaryCatalog, destinationPath: catalogPath },
      ],
      { rename: observe(renameSync), link: observe(linkSync) }
    );

    assert.ok(seen.length >= 4, 'the publication really ran');
    assert.ok(
      seen.every(Boolean),
      `the database path must exist at every step, got ${JSON.stringify(seen)}`
    );
    assert.equal(readFileSync(dbPath, 'utf8'), 'next database');
    assert.equal(readFileSync(catalogPath, 'utf8'), 'next catalog');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a statement that cannot open the catalog does not discard the batch', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [{ table: 't', grain: '', dax: '', rows: [{ n: 1 }] }],
      dbPath
    );

    // Model a reader that lands on the catalog exactly while it is being
    // replaced: the first statement succeeds, then the file goes away.
    const runners = {
      search: (query, options) => searchCatalog(dbPath, query, options),
      sql: (query, options) => {
        if (query.includes('second')) {
          rmSync(dbPath, { force: true });
        }
        return runSql(dbPath, query, options);
      },
    };
    const entries = runBatch(
      [
        { kind: 'sql', query: 'SELECT n FROM t' },
        { kind: 'sql', query: 'SELECT n FROM t -- second' },
        { kind: 'sql', query: 'SELECT n FROM t' },
      ],
      { runners }
    );

    assert.equal(entries.length, 3, 'every statement is still accounted for');
    assert.equal(entries[0].result.ok, true);
    assert.equal(
      entries[0].result.rows[0].n,
      1,
      'its work was not thrown away'
    );
    assert.equal(entries[1].result.ok, false);
    assert.match(entries[1].result.error, /unable to open database file/u);
    assert.equal(batchExitCode(entries), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Cuts must not split a surrogate pair (A5) --

test('an expression cut mid-emoji still emits well-formed text', () => {
  // 119 ASCII characters then an emoji: the slice lands between the pair, and
  // there is no space, comma or paren in the head for the boundary rule to
  // fall back on.
  const expression = `${'a'.repeat(119)}\u{1F600} trailing text`;
  const summary = summarizeSearchExpression(expression);

  assert.equal(summary.isWellFormed(), true, 'no lone surrogate may survive');
  assert.equal(
    Buffer.from(summary, 'utf8').toString('utf8'),
    summary,
    'the summary must round-trip through UTF-8'
  );
  assert.ok(!summary.includes('\uFFFD'), 'and must not contain U+FFFD');
});

test('a BMP-only expression is unaffected by the surrogate rule', () => {
  // Every character here is one UTF-16 unit, so the cut was already safe and
  // must stay exactly where it was.
  const expression = '\u6f22\u5b57'.repeat(200);
  const summary = summarizeSearchExpression(expression);

  assert.equal(summary.isWellFormed(), true);
  assert.equal(
    summary.split(' \u2026 ')[0],
    expression.slice(0, SEARCH_EXPRESSION_LIMIT),
    'the BMP cut is untouched'
  );
});

// -- Note budgets are counted in UTF-8 bytes, not UTF-16 length (A1) --

test('eight non-Latin searches stay inside the reserved note budget', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'm.sqlite');
  buildDatabase(
    [
      {
        table: 'info_view_measures',
        grain: '',
        dax: '',
        rows: Array.from({ length: 20 }, (_, index) => ({
          Table: '\u58f2\u4e0a',
          Name: `\u6307\u6a19 ${index}`,
          Expression: 'SUM(1)',
        })),
      },
    ],
    dbPath
  );

  // One term the model has (so the relaxed pass answers and emits the note),
  // plus terms it does not. Every term is 3 UTF-8 bytes per character, which
  // is what a UTF-16 length cap under a byte reserve gets wrong.
  const absent = Array.from(
    { length: 6 },
    (_, index) => `${'\u3042'.repeat(40)}${index}`
  ).join(' ');
  const batch = Array.from({ length: MAX_BATCH_STATEMENTS }, () => ({
    kind: 'search',
    query: `\u6307\u6a19 ${absent}`,
  }));

  const entries = runBatch(batch, { runners: runnersFor(dbPath) });
  const bytes = Buffer.byteLength(formatBatch(entries), 'utf8');

  assert.equal(entries.length, MAX_BATCH_STATEMENTS);
  assert.ok(bytes <= MAX_RESULT_BYTES, `batch emitted ${bytes} bytes`);
  for (const entry of entries) {
    assert.equal(entry.result.ok, true);
    assert.equal(entry.result.totalRows, 20, 'the relaxed pass still answered');
    assert.match(entry.result.notes[0], /no object matched all/u);
    assert.ok(
      Buffer.byteLength(entry.result.notes[0], 'utf8') <= 400,
      'each note is bounded in bytes, whatever script it quotes'
    );
  }
  t.diagnostic(`eight CJK searches: ${bytes}/${MAX_RESULT_BYTES} bytes`);
});

// -- Containment has to survive a link (A2) --

test('a --file reached through an in-app link to outside is refused', (t) => {
  const app = tempDir();
  const outside = tempDir();
  t.after(() => {
    rmSync(app, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, 'secret.txt'), 'NOT-A-REAL-CREDENTIAL', 'utf8');

  const linkPath = join(app, 'link');
  try {
    symlinkSync(outside, linkPath, 'junction');
  } catch {
    t.skip('this filesystem or account cannot create a directory link');
    return;
  }

  // Lexically the path is under the app root, so a resolve+startsWith check
  // passes it. Containment that a link walks around is not containment.
  const escaped = join(linkPath, 'secret.txt');
  assert.ok(escaped.startsWith(app + sep), 'the test targets the lexical gap');

  const plan = planStatements({ file: [escaped], root: app });
  assert.match(plan.error, /--file must be inside the app/u);
  assert.ok(!plan.error.includes('NOT-A-REAL-CREDENTIAL'));
});

test('an ordinary in-app --file still resolves through a linked app root', (t) => {
  // tmpdir() is itself a link on some platforms, so the root must be resolved
  // too or every legitimate read would be refused.
  const app = tempDir();
  t.after(() => rmSync(app, { recursive: true, force: true }));
  writeFileSync(join(app, 'q.sql'), 'SELECT 1', 'utf8');

  const plan = planStatements({ file: ['q.sql'], root: app });
  assert.equal(plan.mode, 'batch');
  assert.equal(plan.batch[0].query, 'SELECT 1');
  assert.equal(plan.batch[0].source, 'q.sql');
});

// -- A reclaimer must not remove a lock it did not judge (A3) --

test('releasing a lock does not remove one another process now holds', async () => {
  const dir = tempDir();
  try {
    const lockPath = join(dir, '.refresh.lock');
    await withCatalogLock(dir, async () => {
      // Another process reclaimed and took the lock while we were working.
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: process.pid, token: 'someone-else' }),
        'utf8'
      );
    });

    assert.equal(
      existsSync(lockPath),
      true,
      'releasing must not delete a live lock that replaced ours'
    );
    assert.equal(
      JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token,
      'someone-else'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale reclaim re-reads before removing, so it cannot steal a new lock', async () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, '.refresh.lock');
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, 'owner.json'),
      JSON.stringify({ pid: 999_999, token: 'abandoned' }),
      'utf8'
    );

    let checks = 0;
    await assert.rejects(
      withCatalogLock(dir, async () => 'must not run', {
        timeoutMs: 50,
        pollMs: 1,
        processAlive: () => {
          checks += 1;
          if (checks === 1) {
            // Another reclaimer wins the race and installs its own live lock
            // between our decision and our removal.
            writeFileSync(
              join(lockPath, 'owner.json'),
              JSON.stringify({ pid: process.pid, token: 'winner' }),
              'utf8'
            );
          }
          return false;
        },
      }),
      /Timed out waiting/u
    );

    assert.equal(existsSync(lockPath), true, 'the winner keeps its lock');
    assert.equal(
      JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).token,
      'winner'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication waits out a reader holding the destination open', () => {
  // Windows reports a sharing violation under more than one code, so all three
  // have to be waited out rather than whichever one a local run happened to
  // produce.
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const dir = tempDir();
    try {
      const dbPath = join(dir, 'model.sqlite');
      const temporaryPath = join(dir, 'next.tmp');
      writeFileSync(dbPath, 'previous', 'utf8');
      writeFileSync(temporaryPath, 'next', 'utf8');

      let attempts = 0;
      const rename = (from, to) => {
        if (to === dbPath && attempts++ < 3) {
          const error = new Error(`${code}: rename blocked`);
          error.code = code;
          throw error;
        }
        renameSync(from, to);
      };

      publishFiles([{ temporaryPath, destinationPath: dbPath }], {
        rename,
        retry: { attempts: 10, delayMs: 0, sleep: () => {} },
      });

      assert.equal(attempts, 4, `${code} retried rather than giving up`);
      assert.equal(readFileSync(dbPath, 'utf8'), 'next');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('publication still gives up once the retry bound is reached', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    const temporaryPath = join(dir, 'next.tmp');
    writeFileSync(dbPath, 'previous', 'utf8');
    writeFileSync(temporaryPath, 'next', 'utf8');

    const rename = (from, to) => {
      if (to === dbPath) {
        const error = new Error('EPERM: operation not permitted, rename');
        error.code = 'EPERM';
        throw error;
      }
      renameSync(from, to);
    };

    assert.throws(
      () =>
        publishFiles([{ temporaryPath, destinationPath: dbPath }], {
          rename,
          retry: { attempts: 3, delayMs: 0, sleep: () => {} },
        }),
      /EPERM/u
    );
    // The previous generation is restored, not left behind a backup link.
    assert.equal(readFileSync(dbPath, 'utf8'), 'previous');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rename failure that is not a sharing violation is not retried', () => {
  let attempts = 0;
  const rename = () => {
    attempts += 1;
    const error = new Error('ENOSPC: no space left on device');
    error.code = 'ENOSPC';
    throw error;
  };
  assert.throws(
    () =>
      publishFiles([{ temporaryPath: 'a', destinationPath: 'b' }], {
        exists: () => false,
        rename,
        retry: { attempts: 10, delayMs: 0, sleep: () => {} },
      }),
    /ENOSPC/u
  );
  assert.equal(attempts, 1, 'only a sharing violation is worth waiting out');
});

// -- An over-budget expression must still be recoverable --

test('an expression larger than the budget is reconstructible in chunks', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    // Non-ASCII, quotes and newlines, so a reconstruction that mangles
    // encoding or drops the tail cannot pass. Well past MAX_RESULT_BYTES.
    const unit = `"\u6f22\u5b57" & \u{1F600} & '\u00e9\u00e0'\nRETURN `;
    const expression = `SWITCH(USERCULTURE(), ${unit.repeat(2_000)})`;
    assert.ok(
      Buffer.byteLength(expression, 'utf8') > MAX_RESULT_BYTES * 2,
      'the fixture has to actually exceed the budget'
    );
    buildDatabase(
      [
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: [
            { Table: 'Sales', Name: 'Localized Label', Expression: expression },
          ],
        },
      ],
      dbPath
    );

    const where =
      "FROM info_view_measures WHERE [Table] = 'Sales' " +
      "AND [Name] = 'Localized Label'";

    // The dead end the documented recovery used to walk into: a single cell
    // has nothing left to narrow, so the row matches but cannot be returned.
    const whole = runSql(dbPath, `SELECT [Expression] ${where}`);
    assert.equal(whole.ok, true);
    assert.equal(whole.totalRows, 1);
    assert.equal(
      whole.returnedRows,
      0,
      'whole rows are dropped, not shortened'
    );
    assert.equal(whole.truncated, true);

    const size = runSql(
      dbPath,
      `SELECT length([Expression]) AS chars ${where}`
    );
    const chars = size.rows[0].chars;
    // SQLite counts code points; the size in the search summary comes from
    // JavaScript and counts UTF-16 units, so an expression with astral
    // characters reports fewer here. length() is the authoritative bound for
    // substr() offsets, which are themselves code-point based.
    assert.ok(chars > 0);
    assert.equal(
      chars,
      [...expression].length,
      'length() counts code points, not UTF-16 units'
    );
    assert.ok(chars < expression.length, 'the fixture exercises that gap');

    const stride = 1000;
    const parts = [];
    for (let offset = 1; offset <= chars; offset += stride) {
      const chunk = runSql(
        dbPath,
        `SELECT substr([Expression], ${offset}, ${stride}) AS part ${where}`
      );
      assert.equal(chunk.ok, true, `chunk at ${offset} failed`);
      assert.equal(chunk.truncated, false, `chunk at ${offset} was truncated`);
      assert.equal(chunk.returnedRows, 1, `chunk at ${offset} was dropped`);
      parts.push(chunk.rows[0].part);
    }

    assert.equal(
      parts.join(''),
      expression,
      'the reconstruction must equal the original exactly, tail included'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- Search payload trimming --

test('a short expression survives verbatim apart from whitespace collapsing', () => {
  assert.equal(
    summarizeSearchExpression('SUM(Sales[Amount])'),
    'SUM(Sales[Amount])'
  );
  assert.equal(
    summarizeSearchExpression('SUM(\n    Sales[Amount]\n)'),
    'SUM( Sales[Amount] )'
  );
  assert.equal(summarizeSearchExpression(null), '');
});

test('a long expression keeps a readable head and says where the rest is', () => {
  const long = `SWITCH(USERCULTURE(), ${Array.from(
    { length: 40 },
    (_, index) => `"loc-${index}", "a translated sentence"`
  ).join(', ')})`;
  const summary = summarizeSearchExpression(long);

  assert.ok(
    summary.length < long.length / 4,
    'the summary must actually be smaller'
  );
  assert.match(
    summary,
    /^SWITCH\(USERCULTURE\(\)/u,
    'the head identifies what the measure does'
  );
  assert.match(
    summary,
    new RegExp(`${long.length} chars`, 'u'),
    'the original size is stated'
  );
  assert.match(
    summary,
    /substr\(\[Expression\], <offset>, 1000\)/u,
    'the named next step must be one that can actually succeed'
  );
});

test('the head is cut at a token boundary when the text offers one', () => {
  // Only a guarantee when a separator falls in the second half of the head; a
  // single unbroken token has nowhere to cut and is truncated as-is.
  const separated = `CALCULATE(${'SUM(Sales[Amount]), '.repeat(30)})`;
  const head = summarizeSearchExpression(separated).split(' \u2026 ')[0];
  // The cut lands ON the separator, so the head ends with a whole token and the
  // next source character is the separator itself - `SUM` rather than `SU`.
  // Asserting the head's own last character instead would be wrong: a cut at
  // `(` leaves `SUM`, which ends in no separator at all.
  assert.ok(separated.startsWith(head), 'the head is a prefix of the source');
  assert.match(
    separated[head.length],
    /[\s,(]/u,
    'the character the cut landed on is a separator'
  );
  assert.ok(head.length <= SEARCH_EXPRESSION_LIMIT);

  const unbroken = 'A'.repeat(400);
  const unbrokenHead = summarizeSearchExpression(unbroken).split(' \u2026 ')[0];
  assert.equal(unbrokenHead, 'A'.repeat(SEARCH_EXPRESSION_LIMIT));
});

test('expressions at the limit are untouched, one character over are not', () => {
  const atLimit = 'A'.repeat(SEARCH_EXPRESSION_LIMIT);
  assert.equal(summarizeSearchExpression(atLimit), atLimit);
  assert.notEqual(summarizeSearchExpression(`${atLimit}B`), `${atLimit}B`);
});

test('boilerplate is a description repeated across the model, not merely a common word', () => {
  const shared = 'Localized label. Do not use for calculations.';
  const rows = [
    ...Array.from({ length: 20 }, () => ({ description: shared })),
    { description: 'Net revenue after returns' },
    { description: 'Gross margin percentage' },
    { description: '' },
  ];
  const boilerplate = boilerplateDescriptions(rows);
  assert.equal(boilerplate.has(shared), true);
  assert.equal(boilerplate.has('Net revenue after returns'), false);
  assert.equal(boilerplate.size, 1);
});

test('a description repeated only a handful of times is left alone', () => {
  const rows = Array.from({ length: 4 }, () => ({
    description: 'Shared by a few',
  }));
  assert.equal(boilerplateDescriptions(rows).size, 0);
});

test('the row floor is exact: one below keeps the description, one at it drops', () => {
  // Both thresholds are shipped constants, so the boundary is part of the
  // contract rather than an implementation detail. Asserting it against the
  // exported value means retuning the constant cannot silently change behaviour
  // without this test being read.
  const shared = 'Repeated';
  const below = Array.from({ length: BOILERPLATE_MIN_ROWS - 1 }, () => ({
    description: shared,
  }));
  const at = Array.from({ length: BOILERPLATE_MIN_ROWS }, () => ({
    description: shared,
  }));

  assert.equal(boilerplateDescriptions(below).has(shared), false);
  assert.equal(boilerplateDescriptions(at).has(shared), true);
});

test('a description on many rows is still kept when it describes a small share of them', () => {
  // The count alone is not enough. On a large model a genuine description can
  // easily appear on eight measures while still telling them apart from the
  // other hundreds, and suppressing it there would remove information rather
  // than noise.
  const shared = 'Appears often but not everywhere';
  const repeats = BOILERPLATE_MIN_ROWS;
  // Sized so the share lands clearly under the floor rather than adjacent to it.
  const others = Math.ceil(repeats / BOILERPLATE_MIN_SHARE);
  const rows = [
    ...Array.from({ length: repeats }, () => ({ description: shared })),
    ...Array.from({ length: others }, (_, index) => ({
      description: `Distinct ${index}`,
    })),
  ];

  const share = repeats / (repeats + others);
  assert.ok(share < BOILERPLATE_MIN_SHARE, `share ${share} is below the floor`);
  assert.equal(boilerplateDescriptions(rows).has(shared), false);
});

test('the share floor is exact: at it the description drops, just under it survives', () => {
  // The row floor alone is asserted above. This pins the other half of the
  // conjunction, so neither threshold can be retuned without a test being read.
  const shared = 'Repeated';
  const repeats = BOILERPLATE_MIN_ROWS;
  const describedAtFloor = Math.floor(repeats / BOILERPLATE_MIN_SHARE);
  const atFloor = [
    ...Array.from({ length: repeats }, () => ({ description: shared })),
    ...Array.from({ length: describedAtFloor - repeats }, (_, index) => ({
      description: `Distinct ${index}`,
    })),
  ];
  const justUnder = [
    ...atFloor,
    { description: `Distinct ${describedAtFloor}` },
  ];

  assert.equal(repeats / describedAtFloor >= BOILERPLATE_MIN_SHARE, true);
  assert.equal(boilerplateDescriptions(atFloor).has(shared), true);

  assert.equal(repeats / (describedAtFloor + 1) < BOILERPLATE_MIN_SHARE, true);
  assert.equal(boilerplateDescriptions(justUnder).has(shared), false);
});

// -- Trimming has to be proportional to the model, not tuned to one of them --

test('trimming is inert on a model whose expressions are already short', () => {
  // Measured upstream against three bound models by reading INFO.VIEW.MEASURES()
  // directly:
  //
  //   model           measures  median  max      over the cap   chars removed
  //   EYReport_PBIR   2560      400     104916   2366 (92.4%)   81.3%
  //   RetailBenchmark 56        38.5    205      1    (1.8%)     3.5%
  //   HRBenchmark     31        34      111      0    (0.0%)     0.0%
  //
  // The cap earns its keep on the model that has bytes to give up and does
  // nothing on the ones that do not. This encodes the HR shape so a future
  // retune cannot start charging small models for a problem they do not have.
  const catalog = Array.from({ length: 31 }, (_, index) => ({
    object_name: `Measure ${index}`,
    description: `Distinct description ${index}`,
    expression: 'A'.repeat(34 + (index % 3)),
  }));

  const { rows, notes } = trimSearchRows(catalog, catalog);

  assert.deepEqual(rows, catalog, 'nothing should have been rewritten');
  assert.deepEqual(notes, [], 'and nothing should be reported');
});

test('trimming engages on a model whose expressions are long', () => {
  // The EY shape: expressions well past the cap, and one description repeated
  // across enough of the model to discriminate nothing.
  const shared = 'Localized label. Do not use for calculations.';
  const catalog = Array.from({ length: 40 }, (_, index) => ({
    object_name: `Measure ${index}`,
    description: shared,
    expression: 'A'.repeat(400),
  }));

  const { rows, notes } = trimSearchRows(catalog, catalog);

  assert.equal(
    rows.every((row) => row.description === null),
    true
  );
  assert.equal(
    rows.every((row) => row.expression.length < 400),
    true
  );
  assert.equal(
    notes.length,
    2,
    'one note for descriptions, one for expressions'
  );
});

test('trimming nulls boilerplate, keeps real descriptions, and reports itself once', () => {
  const shared = 'Localized label. Do not use for calculations.';
  const catalog = [
    ...Array.from({ length: 20 }, (_, index) => ({
      object_name: `loc-${index}`,
      description: shared,
      expression: 'x',
    })),
    {
      object_name: 'Revenue',
      description: 'Net revenue after returns',
      expression: 'SUM(Sales[Amount])',
    },
  ];
  const { rows, notes } = trimSearchRows(catalog, catalog);

  assert.equal(rows[0].description, null);
  assert.equal(rows.at(-1).description, 'Net revenue after returns');
  assert.equal(notes.length, 1, 'no expression was long enough to summarize');
  assert.match(notes[0], /description omitted on 20 row\(s\)/u);
  // Every row keeps every key, or the TSV encoding collapses into JSON.
  assert.deepEqual(Object.keys(rows[0]), Object.keys(rows.at(-1)));
});

test('trimming reports a summarized expression separately from a dropped description', () => {
  const catalog = [
    { object_name: 'm', description: 'unique', expression: 'A'.repeat(500) },
  ];
  const { rows, notes } = trimSearchRows(catalog, catalog);
  assert.equal(rows[0].description, 'unique');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /expression shortened on 1 row\(s\)/u);
});

// -- The regression this whole design exists to avoid --

test('ranking sees the full expression, not the summarized one', () => {
  // The sharp form of the property. The discriminating term appears ONLY past
  // the cut, so a ranker fed trimmed text could not possibly match it. Placing
  // the term near the front - as the upstream fixture does - would let this
  // test pass even if trimming happened before ranking.
  const term = 'reconciliation';
  const prefix = `SWITCH(USERCULTURE(), ${'"padding-locale", "unrelated text", '.repeat(8)}`;
  assert.ok(
    prefix.length > SEARCH_EXPRESSION_LIMIT * 2,
    'the term must sit well past the cut'
  );
  const expression = `${prefix}"en-US", "${term} of journal entries")`;
  assert.ok(
    !summarizeSearchExpression(expression).includes(term),
    'the trimmed form must not contain the term, or this proves nothing'
  );

  const catalog = [
    {
      kind: 'measure',
      parent_name: 'LocalizedLabels',
      object_name: 'Label 0',
      description: 'Localized label.',
      expression,
      display_folder: '',
      data_type: '',
      synonyms: '',
    },
  ];
  const { rows } = trimSearchRows(catalog, catalog);

  assert.equal(rankSemanticSearchRows(catalog, term).length, 1);
  assert.equal(
    rankSemanticSearchRows(rows, term).length,
    0,
    'ranking the trimmed rows finds nothing - so the order is load-bearing'
  );
});

test('an object findable only through its long expression is still findable after trimming', () => {
  // Dropping these rows is what an earlier attempt did. It saved more bytes and
  // made a hundred measures invisible, which is a global regression traded for
  // a local gain. Ranking therefore still sees the full text.
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    const prefix = `SWITCH(USERCULTURE(), ${'"padding-locale", "unrelated text", '.repeat(8)}`;
    const localized = Array.from({ length: 20 }, (_, index) => ({
      Table: 'LocalizedLabels',
      Name: `Label ${index}`,
      Description: 'Localized label. Do not use for calculations.',
      Expression: `${prefix}"en-US", "reconciliation of journal entries")`,
    }));
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: 'INFO.VIEW.TABLES()',
          rows: [{ Name: 'LocalizedLabels', Description: 'Labels' }],
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: 'INFO.VIEW.MEASURES()',
          rows: localized,
        },
      ],
      dbPath
    );

    const out = searchCatalog(dbPath, 'reconciliation', { limit: 50 });
    assert.equal(out.ok, true);
    assert.ok(
      out.totalRows >= 20,
      'the rows are still matched by their full expression'
    );

    const row = out.rows.find(
      (candidate) => candidate.object_name === 'Label 0'
    );
    assert.ok(row, 'the object is still returned');
    assert.equal(
      row.description,
      null,
      'the shared boilerplate is not reprinted'
    );
    assert.match(row.expression, /substr\(\[Expression\], <offset>, 1000\)/u);
    assert.ok(
      !row.expression.includes('reconciliation'),
      'the printed expression no longer carries the term it was found by'
    );
    assert.ok(out.notes.length >= 1, 'the payload says what it did');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trimming shrinks the search payload it is meant to shrink', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'm.sqlite');
    const rows = Array.from({ length: 30 }, (_, index) => ({
      Table: 'LocalizedLabels',
      Name: `Label ${index}`,
      Description:
        'Localized label. Do not use for calculations. It exists only for display.',
      Expression: `SWITCH(USERCULTURE(), ${Array.from(
        { length: 30 },
        (_, locale) => `"l-${locale}", "journal entries"`
      ).join(', ')})`,
    }));
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: 'INFO.VIEW.TABLES()',
          rows: [{ Name: 'LocalizedLabels' }],
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: 'INFO.VIEW.MEASURES()',
          rows,
        },
      ],
      dbPath
    );

    const out = searchCatalog(dbPath, 'journal', { limit: 50 });
    // Compare like with like: the two fields this trims, before and after.
    const targetedBytes = (records, expressionKey, descriptionKey) =>
      records.reduce(
        (total, record) =>
          total +
          Buffer.byteLength(
            `${record[expressionKey] ?? ''}${record[descriptionKey] ?? ''}`,
            'utf8'
          ),
        0
      );
    const before = targetedBytes(rows, 'Expression', 'Description');
    const after = targetedBytes(out.rows, 'expression', 'description');
    assert.ok(
      after < before / 4,
      `expected expression+description to shrink at least 4x: ${after} vs ${before}`
    );
    // Every matched row is still returned - smaller, not fewer.
    assert.equal(out.returnedRows, out.totalRows);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
