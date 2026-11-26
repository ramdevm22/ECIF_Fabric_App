//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

// End-to-end coverage of the `schema:sql` entry point.
//
// These spawn the real script rather than importing it, so argument wiring,
// stdout payloads and exit statuses are covered. The runtime scripts are copied
// into a temporary app with a fake `@microsoft/rayfin-cli` beside them, so
// ordinary module resolution finds the fake by construction and no request can
// reach a real tenant.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SCRIPTS = [
  'schema-sql.mjs',
  'schema.mjs',
  'rayfin-connector.mjs',
];
const DATASET_ID = '11111111-2222-3333-4444-555555555555';
const CALL_LOG = 'cli-calls.log';

const SOURCE_TABLES = {
  'INFO.VIEW.TABLES()': {
    columns: ['Name', 'Description'],
    rows: [
      ['Sales', 'Sales facts'],
      ['Date', 'Date dimension'],
    ],
  },
  'INFO.VIEW.COLUMNS()': {
    columns: ['Table', 'Name', 'DataType'],
    rows: [['Sales', 'Amount', 'Decimal']],
  },
  'INFO.VIEW.MEASURES()': {
    columns: ['Table', 'Name', 'Expression', 'Description', 'DisplayFolder'],
    rows: [
      ['Sales', 'Revenue', "SUM('Sales'[Amount])", 'Total revenue', 'Finance'],
    ],
  },
  'INFO.VIEW.RELATIONSHIPS()': {
    columns: ['FromTable', 'FromColumn', 'ToTable', 'ToColumn'],
    rows: [['Sales', 'DateKey', 'Date', 'DateKey']],
  },
  COLUMNSTATISTICS: {
    columns: [
      'Table Name',
      'Column Name',
      'Min',
      'Max',
      'Cardinality',
      'Max Length',
    ],
    rows: [['Sales', 'Amount', '1', '99', 42, 0]],
  },
};

// `deny` names a source whose DAX should fail. Every invocation is logged so a
// test can prove the fake, not a real CLI, was what answered.
function fakeCliSource(deny) {
  return `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const tables = ${JSON.stringify(SOURCE_TABLES)};
const deny = ${JSON.stringify(deny)};
const log = (entry) => appendFileSync(
  join(process.cwd(), ${JSON.stringify(CALL_LOG)}),
  JSON.stringify(entry) + '\\n',
  'utf8'
);

if (argv[0] === 'connector' && argv[1] === 'list') {
  log({ command: 'list' });
  process.stdout.write(JSON.stringify([
    {
      name: 'model',
      type: 'fabric-semanticmodel',
      config: { itemId: ${JSON.stringify(DATASET_ID)}, workspaceId: 'ws' },
    },
  ]));
  process.exit(0);
}

if (argv[0] === 'connector' && argv[1] === 'invoke') {
  const payload = JSON.parse(readFileSync(argv[argv.indexOf('--file') + 1], 'utf8'));
  const outputPath = argv[argv.indexOf('--output-file') + 1];
  const key = Object.keys(tables).find((name) => payload.query.includes(name));
  log({ command: 'invoke', source: key });
  if (deny && payload.query.includes(deny)) {
    writeFileSync(outputPath, JSON.stringify({
      status: 'error',
      error: { message: 'denied: caller lacks read permission' },
    }), 'utf8');
    process.stdout.write(JSON.stringify({ status: 'ok', outputFile: outputPath }));
    process.exit(0);
  }
  const table = tables[key];
  writeFileSync(outputPath, JSON.stringify({
    status: 'ok',
    table: {
      columns: table.columns.map((name) => ({ name, dataType: 'String' })),
      rows: table.rows,
    },
  }), 'utf8');
  // The real CLI spills large results and leaves a preview on stdout, so the
  // envelope is all the caller may trust.
  process.stdout.write(JSON.stringify({
    status: 'ok',
    outputFile: outputPath,
    outputBytes: 1234,
  }));
  process.exit(0);
}

process.stderr.write('unexpected argv: ' + JSON.stringify(argv));
process.exit(1);
`;
}

function writeFakeCli(app, deny) {
  const cliDir = join(app, 'node_modules', '@microsoft', 'rayfin-cli');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify({
      name: '@microsoft/rayfin-cli',
      version: '0.0.0-test',
      bin: { rayfin: './rayfin.mjs' },
    }),
    'utf8'
  );
  writeFileSync(join(cliDir, 'rayfin.mjs'), fakeCliSource(deny), 'utf8');
}

// The scripts are copied into the app the way `pack:add` installs them, so the
// fake CLI is found by ordinary parent-directory lookup rather than a NODE_PATH
// fallback that a really installed package would pre-empt.
function makeApp(deny) {
  const app = mkdtempSync(join(tmpdir(), 'schema-sql-cli-'));
  mkdirSync(join(app, 'scripts'), { recursive: true });
  for (const name of RUNTIME_SCRIPTS) {
    copyFileSync(join(KIT, name), join(app, 'scripts', name));
  }
  writeFakeCli(app, deny);
  return app;
}

function cliCalls(app) {
  const path = join(app, CALL_LOG);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function invokeCount(app) {
  return cliCalls(app).filter((call) => call.command === 'invoke').length;
}

function runCli(app, args, environment = {}) {
  const child = spawn(
    process.execPath,
    [join(app, 'scripts', 'schema-sql.mjs'), ...args],
    {
      cwd: app,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...environment },
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  return once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
}

test('the CLI builds a catalog on a cold cache and answers SQL', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const cold = await runCli(app, [
    'SELECT [Table], [Name] FROM info_view_measures ORDER BY [Name]',
  ]);
  assert.equal(cold.code, 0, `stderr: ${cold.stderr}`);
  assert.match(cold.stderr, /Building the model catalog/u);
  assert.match(cold.stdout, /^# \{"ok":true/u);
  assert.match(cold.stdout, /Table\tName\nSales\tRevenue\n$/u);

  // Were the fake bypassed these counters would stay at zero and the run would
  // have reached a real tenant, so this is what proves the test is offline.
  assert.equal(invokeCount(app), 5, 'the five hardcoded sources were fetched');
  // Exactly one: resolveAlias hands its connector record to resolveIdentity, so
  // a single run must not spawn the connector list twice.
  assert.equal(
    cliCalls(app).filter((call) => call.command === 'list').length,
    1,
    'one run resolves the connector once'
  );

  const warm = await runCli(app, [
    'SELECT [Table], [Name] FROM info_view_measures ORDER BY [Name]',
  ]);
  assert.equal(warm.code, 0, `stderr: ${warm.stderr}`);
  assert.ok(
    !/Building the model catalog/u.test(warm.stderr),
    'a fresh catalog must not be rebuilt'
  );
  assert.equal(warm.stdout, cold.stdout, 'the payload is stable');
  assert.equal(invokeCount(app), 5, 'a warm cache fetches nothing');
});

test('the CLI applies owned-measure enrichment end to end', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  // info_view_tables carries an ownedMeasures array, so this payload is JSON
  // rather than TSV.
  const result = await runCli(app, [
    'SELECT [Name] FROM info_view_tables ORDER BY [Name]',
  ]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  const byName = Object.fromEntries(
    JSON.parse(result.stdout).rows.map((row) => [row.Name, row])
  );

  assert.equal(byName.Sales.ownedMeasureCount, 1);
  assert.equal(byName.Sales.ownedMeasuresNeedDetail, true);
  assert.deepEqual(byName.Sales.ownedMeasures, [
    { name: 'Revenue', displayFolder: 'Finance' },
  ]);
  assert.equal(byName.Date.ownedMeasureCount, 0);
  assert.equal(byName.Date.ownedMeasuresNeedDetail, false);
});

test('the CLI answers a real batch in one process', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const result = await runCli(app, [
    '--search',
    'revenue',
    '--sql',
    'SELECT [Name] FROM info_view_tables ORDER BY [Name]',
    '--sql',
    'SELEKT broken',
  ]);

  const lines = result.stdout.split('\n');
  assert.deepEqual(JSON.parse(lines[0].slice(2)), {
    ok: false,
    batch: true,
    statements: 3,
  });
  const labels = lines
    .filter((line) => line.startsWith('## '))
    .map((line) => JSON.parse(line.slice(3)));
  assert.deepEqual(
    labels.map((label) => label.kind),
    ['search', 'sql', 'sql']
  );
  assert.match(result.stdout, /Revenue/u);
  assert.match(result.stdout, /syntax error/u);
  assert.equal(result.code, 1, 'one failed statement fails the invocation');
  assert.equal(invokeCount(app), 5, 'one process, one build, three answers');
});

test('the CLI rejects an argument mistake before building anything', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const result = await runCli(app, ['SELECT 1', '--sql', 'SELECT 2']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /not both/u);
  assert.equal(result.stdout, '');
  assert.deepEqual(cliCalls(app), [], 'planning happens before any fetch');
});

test('--help prints usage and exits successfully', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const result = await runCli(app, ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage:/u);
  assert.match(result.stdout, /--sql <text>/u);
  assert.match(result.stdout, /shares one byte budget/u);
  // Exit 2 covers two conditions; the help must not describe only one.
  assert.match(result.stdout, /truncated OR an explicitly requested/u);
  assert.deepEqual(cliCalls(app), []);
});

test('exit 2 covers truncation and an unsatisfied refresh alike', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const truncated = await runCli(app, [
    '--limit',
    '1',
    'SELECT [Name] FROM info_view_tables ORDER BY [Name]',
  ]);
  assert.equal(truncated.code, 2, 'a truncated preview exits 2');
  assert.match(truncated.stdout, /"reason":"row_limit"/u);

  const tolerated = await runCli(app, [
    '--limit',
    '1',
    '--allow-truncated',
    'SELECT [Name] FROM info_view_tables ORDER BY [Name]',
  ]);
  assert.equal(tolerated.code, 0, '--allow-truncated accepts a preview');
});

test('an explicit --refresh that could not refresh says so and fails', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const built = await runCli(app, ['--refresh']);
  assert.equal(built.code, 0, `stderr: ${built.stderr}`);

  writeFakeCli(app, 'COLUMNSTATISTICS');
  const denied = await runCli(app, ['--refresh']);

  assert.match(
    denied.stderr,
    /COLUMNSTATISTICS/u,
    'the failing source is named'
  );
  assert.match(denied.stderr, /denied/u, 'the underlying reason survives');
  assert.match(denied.stderr, /Refresh not completed/u);
  assert.equal(
    denied.code,
    2,
    'an explicitly requested refresh that did not happen cannot exit 0'
  );

  // The retained catalog and its status row describe the earlier generation
  // accurately, and must not be rewritten to look degraded.
  const status = await runCli(app, [
    'SELECT status, incomplete FROM catalog_status',
  ]);
  assert.match(status.stdout, /complete\t0/u);
});

test('a failed automatic refresh does not re-fetch on the next command', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  const stale = { RAYFIN_SCHEMA_TTL_MINUTES: '0' };
  const built = await runCli(app, ['--refresh']);
  assert.equal(built.code, 0, `stderr: ${built.stderr}`);

  writeFakeCli(app, 'COLUMNSTATISTICS');
  const first = await runCli(
    app,
    ['SELECT [Table], [Name] FROM info_view_measures'],
    stale
  );
  assert.equal(first.code, 0, 'nobody asked for freshness, so this succeeds');
  assert.match(first.stderr, /COLUMNSTATISTICS/u, 'the reason is reported');
  assert.ok(
    !/Refresh not completed/u.test(first.stderr),
    'an automatic rebuild is not a failed request'
  );
  const afterFirst = invokeCount(app);

  // Throttling is the usual cause, so retrying on the very next command would
  // extend the block it is reacting to.
  const second = await runCli(
    app,
    ['SELECT [Table], [Name] FROM info_view_measures'],
    stale
  );
  assert.equal(second.code, 0);
  assert.match(second.stdout, /Sales\tRevenue/u, 'it still answers locally');
  assert.equal(
    invokeCount(app),
    afterFirst,
    'the failed refresh is not retried on every subsequent command'
  );
  assert.match(second.stderr, /not retrying until/u);
});

test('a cooldown cannot suppress a rebuild when no catalog exists', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  // A marker left behind from an earlier failure, with the catalog since gone
  // or never built. Honouring it would answer from a database that is not
  // there, for the whole window.
  const cacheDir = join(app, '.schema', 'models', DATASET_ID);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, '.refresh-cooldown.json'),
    JSON.stringify({
      retryAfter: new Date(Date.now() + 60 * 60_000).toISOString(),
      reason: 'an earlier failure',
    }),
    'utf8'
  );

  const result = await runCli(app, [
    'SELECT [Table], [Name] FROM info_view_measures',
  ]);
  assert.equal(result.code, 0, `stderr: ${result.stderr}`);
  assert.match(result.stderr, /Building the model catalog/u);
  assert.match(result.stdout, /Sales\tRevenue/u);
  assert.ok(
    !/not retrying until/u.test(result.stderr),
    'with nothing to serve, the cooldown must not apply'
  );
});

test('a cold start that failed can recover without --refresh', async (t) => {
  const app = makeApp('INFO.VIEW.TABLES');
  t.after(() => rmSync(app, { recursive: true, force: true }));

  // Table discovery is fatal, so nothing is ever written: there is no catalog
  // to fall back to.
  const failed = await runCli(app, [
    'SELECT [Table], [Name] FROM info_view_measures',
  ]);
  assert.equal(failed.code, 1);
  assert.equal(invokeCount(app), 1, 'the fatal source stopped discovery');

  // A cooldown here would skip the rebuild and then fail to open a database
  // that was never created, locking the user out for the whole window.
  writeFakeCli(app, null);
  const recovered = await runCli(app, [
    'SELECT [Table], [Name] FROM info_view_measures',
  ]);
  assert.equal(
    recovered.code,
    0,
    `an ordinary command must recover once the cause clears: ${recovered.stderr}`
  );
  assert.match(recovered.stderr, /Building the model catalog/u);
  assert.match(recovered.stdout, /Sales\tRevenue/u);
  assert.ok(
    !/not retrying until/u.test(recovered.stderr),
    'there was no catalog to serve, so nothing may be suppressed'
  );
});

test('an explicit --refresh retries even during a cooldown', async (t) => {
  const app = makeApp(null);
  t.after(() => rmSync(app, { recursive: true, force: true }));

  await runCli(app, ['--refresh']);
  writeFakeCli(app, 'COLUMNSTATISTICS');
  await runCli(app, ['--refresh']);
  const afterFirst = invokeCount(app);

  const second = await runCli(app, ['--refresh']);
  assert.equal(second.code, 2);
  assert.ok(
    invokeCount(app) > afterFirst,
    'an explicit refresh is never suppressed by the cooldown'
  );
});
