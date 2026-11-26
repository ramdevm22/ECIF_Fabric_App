//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  assertSupportedNodeVersion,
  boundRows,
  buildDatabase,
  cacheStatus,
  CATALOG_SOURCES,
  columnNamesOf,
  createTable,
  discoverRaw,
  formatResult,
  inferColumnType,
  isRateLimited,
  materializeCatalog,
  modelCacheDir,
  publishFiles,
  quoteIdentifier,
  rankSemanticSearchRows,
  rawQuery,
  renderCatalog,
  resultExitCode,
  retryDelayMs,
  runSql,
  searchCatalog,
  selectsOnlyTableRows,
  semanticSearchRows,
  toSqlValue,
  ttlMinutes,
  withRateLimitRetry,
  withCatalogLock,
} from './schema-sql.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'schema-sql-'));
}

test('every read-only SQLite connection goes through the query-only helper', () => {
  const source = readFileSync(
    new URL('./schema-sql.mjs', import.meta.url),
    'utf8'
  );
  const rawReadOnlyOpens =
    source.match(
      /new DatabaseSync\([^)]*,\s*\{\s*readOnly:\s*true\s*\}\s*\)/gu
    ) ?? [];
  assert.equal(
    rawReadOnlyOpens.length,
    1,
    'new read paths must use openReadOnlyDatabase so query_only is applied'
  );
  assert.match(
    source,
    /function openReadOnlyDatabase[\s\S]*PRAGMA query_only = ON/u
  );
});

function sampleRowsFor(source) {
  switch (source.table) {
    case 'info_view_tables':
      return [{ Name: 'Sales', Description: 'Sales facts' }];
    case 'info_view_columns':
      return [
        {
          Table: 'Sales',
          Name: 'Amount',
          DataType: 'Decimal',
          IsHidden: false,
        },
      ];
    case 'info_view_measures':
      return [
        {
          Table: 'Sales',
          Name: 'Revenue',
          Expression: "SUM('Sales'[Amount])",
          Description: 'Total revenue',
          FormatString: '$#,0',
          DisplayFolder: 'Finance',
        },
      ];
    case 'info_view_relationships':
      return [
        {
          FromTable: 'Sales',
          FromColumn: 'DateKey',
          ToTable: 'Date',
          ToColumn: 'DateKey',
        },
      ];
    case 'column_statistics':
      return [
        {
          'Table Name': 'Sales',
          'Column Name': 'Amount',
          Min: '1',
          Max: '99',
          Cardinality: 42,
          'Max Length': 0,
        },
      ];
    default:
      throw new Error(`Unknown source: ${source.table}`);
  }
}

function sampleColumnsFor(source) {
  return Object.keys(sampleRowsFor(source)[0]).map((name) => ({
    name,
    dataType:
      name === 'IsHidden'
        ? 'Boolean'
        : name === 'Cardinality' || name === 'Max Length'
          ? 'Double'
          : 'String',
  }));
}

test('the catalog build path contains exactly five hardcoded schema sources', () => {
  assert.equal(Object.isFrozen(CATALOG_SOURCES), true);
  assert.equal(CATALOG_SOURCES.every(Object.isFrozen), true);
  assert.deepEqual(
    CATALOG_SOURCES.map((source) => source.table),
    [
      'info_view_tables',
      'info_view_columns',
      'info_view_measures',
      'info_view_relationships',
      'column_statistics',
    ]
  );
  for (const source of CATALOG_SOURCES) {
    assert.equal(
      Object.hasOwn(source, 'batchColumn'),
      false,
      'the Rayfin connector has no default row cap, so batching is not allowed'
    );
  }
});

test('INFO.VIEW sources stay unprojected', () => {
  for (const source of CATALOG_SOURCES.filter(
    ({ table }) => table !== 'column_statistics'
  )) {
    assert.equal(
      rawQuery(source.dax).includes('SELECTCOLUMNS'),
      false,
      `${source.table} must preserve native column names`
    );
  }
  assert.equal(rawQuery('INFO.VIEW.TABLES()'), 'EVALUATE INFO.VIEW.TABLES()');
});

test('column statistics normalize values before JSON serialization', () => {
  const source = CATALOG_SOURCES.find(
    ({ table }) => table === 'column_statistics'
  );
  assert.match(source.dax, /SELECTCOLUMNS\(\s*COLUMNSTATISTICS\(\)/);
  assert.match(source.dax, /"Min", CONVERT\(\[Min\], STRING\)/);
  assert.match(source.dax, /"Max", CONVERT\(\[Max\], STRING\)/);
  assert.match(source.dax, /"Cardinality", CONVERT\(\[Cardinality\], DOUBLE\)/);
});

test('the Node guard fails with a readable minimum-version error', () => {
  assert.throws(
    () => assertSupportedNodeVersion('22.12.0'),
    /requires Node\.js >=22\.13\.0.*22\.12\.0/i
  );
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.13.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.0.0'));
});

test('values are coercible by node:sqlite', () => {
  assert.equal(toSqlValue(true), 1);
  assert.equal(toSqlValue(false), 0);
  assert.equal(toSqlValue(null), null);
  assert.equal(toSqlValue(Number.NaN), null);
  assert.equal(toSqlValue({ a: 1 }), '{"a":1}');
  assert.equal(
    toSqlValue(new Date('2024-01-01T00:00:00Z')),
    '2024-01-01T00:00:00.000Z'
  );
});

test('column types preserve numeric ordering', () => {
  assert.equal(inferColumnType([1, 2, 3]), 'INTEGER');
  assert.equal(inferColumnType([1, 2.5]), 'REAL');
  assert.equal(inferColumnType(['a', 1]), 'TEXT');
  assert.equal(inferColumnType([true, false]), 'INTEGER');
  assert.equal(inferColumnType([null, '', null]), 'TEXT');
});

test('identifiers and sparse rows preserve native columns', () => {
  assert.equal(quoteIdentifier('Max Length'), '"Max Length"');
  assert.equal(quoteIdentifier('od"d'), '"od""d"');
  assert.deepEqual(columnNamesOf([{ a: 1 }, { a: 2, b: 3 }]), ['a', 'b']);
});

test('native column spellings and booleans survive SQLite', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_columns',
          grain: '',
          dax: 'INFO.VIEW.COLUMNS()',
          rows: [
            {
              'Table Name': 'Sales',
              'Max Length': 12,
              IsHidden: false,
            },
          ],
        },
      ],
      dbPath
    );
    const result = runSql(
      dbPath,
      'SELECT "Table Name", "Max Length" FROM info_view_columns WHERE IsHidden = 0'
    );
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]['Table Name'], 'Sales');
    assert.equal(result.rows[0]['Max Length'], 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a successful empty view creates a queryable table from returned columns', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_relationships',
          grain: '',
          dax: 'INFO.VIEW.RELATIONSHIPS()',
          columns: [
            { name: 'FromTable', dataType: 'String' },
            { name: 'FromColumn', dataType: 'String' },
            { name: 'IsActive', dataType: 'Boolean' },
          ],
          rows: [],
        },
      ],
      dbPath
    );
    const result = runSql(dbPath, 'SELECT * FROM info_view_relationships');
    assert.equal(result.ok, true);
    assert.deepEqual(result.rows, []);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare('PRAGMA table_info("info_view_relationships")')
          .all()
          .map((column) => [column.name, column.type]),
        [
          ['FromTable', 'TEXT'],
          ['FromColumn', 'TEXT'],
          ['IsActive', 'INTEGER'],
        ]
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed rebuild leaves the previous complete database', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 't',
          grain: '',
          dax: 'x',
          rows: [{ value: 'old' }],
        },
      ],
      dbPath
    );
    const circular = {};
    circular.self = circular;
    assert.throws(() =>
      buildDatabase(
        [
          {
            table: 't',
            grain: '',
            dax: 'x',
            rows: [{ value: circular }],
          },
        ],
        dbPath
      )
    );
    assert.equal(runSql(dbPath, 'SELECT * FROM t').rows[0].value, 'old');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('table population is one transaction and rolls back failed replacement', () => {
  const dir = tempDir();
  const dbPath = join(dir, 'model.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    createTable(db, 't', [{ value: 'old' }]);
    const circular = {};
    circular.self = circular;
    assert.throws(() => createTable(db, 't', [{ value: circular }]));
    assert.equal(db.prepare('SELECT value FROM t').get().value, 'old');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed multi-file publication restores the previous generation', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    const catalogPath = join(dir, 'catalog.md');
    const temporaryDbPath = join(dir, 'next.sqlite');
    const temporaryCatalogPath = join(dir, 'next.md');
    writeFileSync(dbPath, 'old database');
    writeFileSync(catalogPath, 'old catalog');
    writeFileSync(temporaryDbPath, 'new database');
    writeFileSync(temporaryCatalogPath, 'new catalog');

    assert.throws(
      () =>
        publishFiles(
          [
            { temporaryPath: temporaryDbPath, destinationPath: dbPath },
            {
              temporaryPath: temporaryCatalogPath,
              destinationPath: catalogPath,
            },
          ],
          {
            rename(from, to) {
              if (from === temporaryCatalogPath && to === catalogPath) {
                const error = new Error('simulated second publish failure');
                error.code = 'EPERM';
                throw error;
              }
              renameSync(from, to);
            },
          }
        ),
      /simulated second publish failure/
    );
    assert.equal(readFileSync(dbPath, 'utf8'), 'old database');
    assert.equal(readFileSync(catalogPath, 'utf8'), 'old catalog');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selected tables expose bounded owned-measure context', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: '',
          rows: [{ Name: 'Sales' }],
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: sampleRowsFor({
            table: 'info_view_measures',
          }),
        },
      ],
      dbPath
    );
    const result = runSql(dbPath, 'SELECT "Name" FROM info_view_tables');
    assert.equal(result.rows[0].ownedMeasureCount, 1);
    assert.equal(result.rows[0].ownedMeasures[0].name, 'Revenue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second statement is rejected rather than silently ignored', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: '',
          rows: [{ Name: 'Sales' }, { Name: 'Date' }],
        },
      ],
      dbPath
    );

    // prepare() compiles only the first statement, so the agent asked two
    // questions, got one answer, and nothing said the rest never ran.
    const two = runSql(
      dbPath,
      'SELECT "Name" FROM info_view_tables; SELECT 1 AS other'
    );
    assert.equal(two.ok, false);
    assert.match(two.error, /only one statement runs per --sql/iu);
    assert.match(two.error, /SELECT/u, 'the ignored text is named');

    // A semicolon that is not a separator must still run.
    for (const sql of [
      'SELECT "Name" FROM info_view_tables;',
      'SELECT "Name" FROM info_view_tables WHERE "Name" <> \'a;b\'',
      'SELECT "Name" FROM info_view_tables -- ; SELECT 1',
    ]) {
      assert.equal(runSql(dbPath, sql).ok, true, sql);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enrichment does not decorate rows a join returned from another table', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: '',
          rows: [{ Name: 'Sales', Description: 'facts' }],
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: Array.from({ length: 10 }, (_, index) => ({
            Table: 'Sales',
            Name: `Revenue ${index}`,
            Expression: 'SUM(x)',
          })),
        },
        {
          table: 'info_view_columns',
          grain: '',
          dax: '',
          rows: Array.from({ length: 6 }, (_, index) => ({
            Table: 'Sales',
            Name: `Column ${index}`,
          })),
        },
      ],
      dbPath
    );

    // catalog.md tells the agent these tables join, so this is a query it is
    // invited to write. The rows are column rows; treating each one as a
    // selected table attached ten measures apiece and blew the byte budget.
    const joined = runSql(
      dbPath,
      'SELECT c."Table", c."Name" FROM info_view_columns c ' +
        'JOIN info_view_tables t ON c."Table" = t."Name"'
    );
    assert.equal(joined.ok, true);
    assert.equal(joined.rows.length, 6);
    for (const row of joined.rows) {
      assert.deepEqual(
        Object.keys(row),
        ['Table', 'Name'],
        'a column row carries no owned-measure fields'
      );
    }

    // The ordinary table query is unaffected.
    const direct = runSql(dbPath, 'SELECT "Name" FROM info_view_tables');
    assert.equal(direct.rows[0].ownedMeasureCount, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the enrichment gate reads SQL structure, not the table name', () => {
  // Matching the name anywhere fired on comments, string literals and joins.
  for (const sql of [
    'SELECT [Name] FROM info_view_tables',
    "SELECT t.[Name] FROM info_view_tables t WHERE t.[Name] = 'Sales'",
    'SELECT t.[Name] FROM info_view_tables AS t',
    'SELECT "Name" FROM "info_view_tables"',
    'SELECT [Name] FROM info_view_tables;',
    'SELECT [Name] FROM info_view_tables ORDER BY [Name]',
  ]) {
    assert.equal(selectsOnlyTableRows(sql), true, sql);
  }
  for (const sql of [
    'SELECT * FROM info_view_columns c JOIN info_view_tables t ON 1 = 1',
    'SELECT * FROM info_view_tables, info_view_measures',
    'SELECT [Name] FROM info_view_tables UNION SELECT [Name] FROM info_view_measures',
    "SELECT [Name] FROM info_view_measures WHERE [Expression] LIKE '%info_view_tables%'",
    'SELECT [Name] FROM info_view_measures -- info_view_tables',
    'SELECT [Name] FROM info_view_measures /* info_view_tables */',
    'SELECT [Name] FROM info_view_measures WHERE [Table] IN (SELECT [Name] FROM info_view_tables)',
  ]) {
    assert.equal(selectsOnlyTableRows(sql), false, sql);
  }
});

test('owned-measure enrichment keeps the documented table query under budget', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    const tables = ['Sales North', 'Sales South'];
    buildDatabase(
      [
        {
          table: 'info_view_tables',
          grain: '',
          dax: '',
          rows: tables.map((Name) => ({
            Name,
            Description: `${Name} facts`,
            IsHidden: false,
          })),
        },
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: tables.flatMap((Table) =>
            Array.from({ length: 10 }, (_, index) => ({
              Table,
              Name: `Revenue ${index}`,
              Expression: `CALCULATE(SUM('Sales'[Amount]), ${'x'.repeat(1200)})`,
              Description: 'y'.repeat(600),
              DisplayFolder: 'Revenue',
            }))
          ),
        },
      ],
      dbPath
    );

    const result = runSql(
      dbPath,
      "SELECT [Name], [Description], [IsHidden] FROM info_view_tables WHERE lower([Name]) LIKE '%sales%'"
    );
    assert.equal(result.totalRows, 2);
    assert.equal(result.returnedRows, 2);
    assert.equal(result.truncated, false);
    assert.equal(result.rows[0].ownedMeasureCount, 10);
    assert.deepEqual(Object.keys(result.rows[0].ownedMeasures[0]), [
      'name',
      'displayFolder',
    ]);
    assert.equal(result.rows[0].ownedMeasuresNeedDetail, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverRaw performs exactly one request per source', async () => {
  const calls = [];
  const result = await discoverRaw({
    run: async (dax) => {
      calls.push(dax);
      const source = CATALOG_SOURCES.find(
        (candidate) => rawQuery(candidate.dax) === dax
      );
      return {
        ok: true,
        columns: sampleColumnsFor(source),
        rows: sampleRowsFor(source),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls,
    CATALOG_SOURCES.map((source) => rawQuery(source.dax))
  );
  assert.equal(result.incomplete, false);
  assert.equal(result.resultSets.at(-1).table, 'catalog_status');
});

test('a failed non-table view is cached with a persistent incomplete marker', async () => {
  const result = await discoverRaw({
    run: async (dax) => {
      if (dax.includes('INFO.VIEW.MEASURES')) {
        return { ok: false, error: '429 rate limit' };
      }
      const source = CATALOG_SOURCES.find(
        (candidate) => rawQuery(candidate.dax) === dax
      );
      return {
        ok: true,
        columns: sampleColumnsFor(source),
        rows: sampleRowsFor(source),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.incomplete, true);
  assert.equal(
    result.resultSets.some((set) => set.table === 'info_view_measures'),
    false
  );
  assert.deepEqual(result.resultSets.at(-1).rows, [
    {
      status: 'incomplete',
      incomplete: true,
      notes: JSON.stringify(result.notes),
    },
  ]);
});

test('successful empty discovery remains distinct from a failed view', async () => {
  const successful = await discoverRaw({
    run: async (dax) => {
      const source = CATALOG_SOURCES.find(
        (candidate) => rawQuery(candidate.dax) === dax
      );
      return {
        ok: true,
        columns: sampleColumnsFor(source),
        rows:
          source.table === 'info_view_relationships'
            ? []
            : sampleRowsFor(source),
      };
    },
  });
  assert.equal(successful.incomplete, false);
  const relationships = successful.resultSets.find(
    (set) => set.table === 'info_view_relationships'
  );
  assert.deepEqual(relationships.rows, []);
  assert.ok(relationships.columns.length > 0);

  const failed = await discoverRaw({
    run: async (dax) => {
      const source = CATALOG_SOURCES.find(
        (candidate) => rawQuery(candidate.dax) === dax
      );
      if (source.table === 'info_view_relationships') {
        return { ok: false, error: 'denied' };
      }
      return {
        ok: true,
        columns: sampleColumnsFor(source),
        rows: sampleRowsFor(source),
      };
    },
  });
  assert.equal(failed.incomplete, true);
  assert.equal(
    failed.resultSets.some((set) => set.table === 'info_view_relationships'),
    false
  );
});

test('table discovery failure remains fatal', async () => {
  const result = await discoverRaw({
    run: async () => ({ ok: false, error: 'denied' }),
  });
  assert.deepEqual(result, {
    ok: false,
    error: 'Table discovery failed: denied',
  });
});

test('materializeCatalog writes the database, catalog and status table', async () => {
  const dir = tempDir();
  const calls = [];
  try {
    const result = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) => {
        calls.push(dax);
        const source = CATALOG_SOURCES.find(
          (candidate) => rawQuery(candidate.dax) === dax
        );
        return {
          ok: true,
          columns: sampleColumnsFor(source),
          rows: sampleRowsFor(source),
        };
      },
    });
    assert.equal(calls.length, 5);
    assert.equal(result.ok, true);
    assert.equal(
      runSql(result.dbPath, 'SELECT status, incomplete FROM catalog_status')
        .rows[0].status,
      'complete'
    );
    const catalog = readFileSync(result.catalogPath, 'utf8');
    assert.match(catalog, /Catalog status: \*\*complete\*\*/);
    assert.match(catalog, /Dataset: `ds-1`/);
    assert.match(catalog, /actual Min\/Max/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent refreshes coalesce after the first complete catalog', async () => {
  const dir = tempDir();
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });

  test('an abandoned refresh lock is reclaimed when its owner process is gone', async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);
    try {
      await once(child, 'spawn');
      const deadPid = child.pid;
      child.kill();
      await once(child, 'exit');

      const lockPath = join(dir, '.refresh.lock');
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, 'owner.json'),
        JSON.stringify({ pid: deadPid }),
        'utf8'
      );

      const result = await withCatalogLock(
        dir,
        async ({ waited }) => ({ acquired: true, waited }),
        {
          sleep: async () => {
            throw new Error('a dead owner should be reclaimed without polling');
          },
        }
      );
      assert.deepEqual(result, { acquired: true, waited: true });
      assert.equal(existsSync(lockPath), false);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstCalls = 0;
  let secondCalls = 0;
  const response = (dax) => {
    const source = CATALOG_SOURCES.find(
      (candidate) => rawQuery(candidate.dax) === dax
    );
    return {
      ok: true,
      columns: sampleColumnsFor(source),
      rows: sampleRowsFor(source),
    };
  };

  try {
    const first = materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      lockOptions: { pollMs: 1, jitter: () => 0 },
      run: async (dax) => {
        firstCalls += 1;
        if (firstCalls === 1) {
          markFirstStarted();
          await firstGate;
        }
        return response(dax);
      },
    });
    await firstStarted;
    const second = materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      lockOptions: { pollMs: 1, jitter: () => 0 },
      run: async (dax) => {
        secondCalls += 1;
        return response(dax);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.reused, undefined);
    assert.equal(secondResult.reused, true);
    assert.equal(firstCalls, 5);
    assert.equal(secondCalls, 0);
    assert.match(secondResult.notes[0], /another process refreshed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an incomplete refresh cannot overwrite a complete catalog', async () => {
  const dir = tempDir();
  const response = (dax) => {
    const source = CATALOG_SOURCES.find(
      (candidate) => rawQuery(candidate.dax) === dax
    );
    return {
      ok: true,
      columns: sampleColumnsFor(source),
      rows: sampleRowsFor(source),
    };
  };
  try {
    const complete = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) => response(dax),
    });
    assert.equal(complete.incomplete, false);

    const preserved = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) =>
        dax.includes('INFO.VIEW.MEASURES')
          ? { ok: false, error: 'rate limited' }
          : response(dax),
    });
    assert.equal(preserved.reused, true);
    assert.equal(preserved.incomplete, false);
    assert.match(preserved.notes[0], /previous catalog was preserved/i);
    assert.equal(
      runSql(complete.dbPath, 'SELECT status FROM catalog_status').rows[0]
        .status,
      'complete'
    );
    assert.equal(
      runSql(
        complete.dbPath,
        'SELECT COUNT(*) AS count FROM info_view_measures'
      ).rows[0].count,
      1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an optional view the previous catalog never had does not freeze it', async () => {
  const dir = tempDir();
  const response = (dax) => {
    const source = CATALOG_SOURCES.find(
      (candidate) => rawQuery(candidate.dax) === dax
    );
    return {
      ok: true,
      columns: sampleColumnsFor(source),
      rows: sampleRowsFor(source),
    };
  };
  // COLUMNSTATISTICS is optional and has never worked on this model.
  const withoutStatistics = async (dax) =>
    dax.includes('COLUMNSTATISTICS')
      ? { ok: false, error: 'not supported' }
      : response(dax);
  try {
    const first = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: withoutStatistics,
    });
    assert.equal(first.incomplete, true, 'the optional view is missing');

    // A later rebuild is still incomplete for the same reason. Preserving the
    // earlier snapshot here would discard every future refresh, so the fresh
    // measures and columns must be published.
    const second = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: withoutStatistics,
    });
    assert.notEqual(
      second.reused,
      true,
      'a rebuild that loses nothing is published'
    );

    // But losing a view the catalog does have still preserves it.
    const losesMeasures = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) =>
        dax.includes('INFO.VIEW.MEASURES')
          ? { ok: false, error: 'rate limited' }
          : withoutStatistics(dax),
    });
    assert.equal(losesMeasures.reused, true);

    // The bug this guards: with an optional view permanently missing the
    // status never reaches "complete", which used to switch the protection
    // off entirely and let this rebuild delete info_view_measures.
    assert.equal(
      runSql(first.dbPath, 'SELECT COUNT(*) AS count FROM info_view_measures')
        .rows[0].count,
      1,
      'the measures the previous catalog had survive'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh that throws still answers from the previous catalog', async () => {
  const dir = tempDir();
  const response = (dax) => {
    const source = CATALOG_SOURCES.find(
      (candidate) => rawQuery(candidate.dax) === dax
    );
    return {
      ok: true,
      columns: sampleColumnsFor(source),
      rows: sampleRowsFor(source),
    };
  };
  try {
    await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) => response(dax),
    });

    // On Windows a process holding model.sqlite open makes the publish rename
    // fail with EPERM after its retries, and the exception escaped the whole
    // command rather than falling back like a returned error does.
    const threw = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async () => {
        throw new Error('EPERM: operation not permitted');
      },
    });
    assert.equal(threw.ok, true, 'the command is not lost');
    assert.equal(threw.reused, true);
    assert.equal(threw.refreshIncomplete, true, 'a cooldown is still recorded');
    assert.match(threw.notes[1], /EPERM/u, 'the reason survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh that throws with no catalog on disk is still fatal', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      materializeCatalog({
        dir,
        datasetId: 'ds-1',
        alias: 'sales',
        retry: (run) => run,
        run: async () => {
          throw new Error('EPERM: operation not permitted');
        },
      }),
      /EPERM/u
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed refresh answers from the previous complete catalog', async () => {
  const dir = tempDir();
  const response = (dax) => {
    const source = CATALOG_SOURCES.find(
      (candidate) => rawQuery(candidate.dax) === dax
    );
    return {
      ok: true,
      columns: sampleColumnsFor(source),
      rows: sampleRowsFor(source),
    };
  };
  try {
    const complete = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async (dax) => response(dax),
    });
    assert.equal(complete.incomplete, false);

    // Table discovery itself fails, which is what throttling looks like on the
    // first request after the TTL expires. With a good catalog on disk the
    // command must still answer instead of losing the caller's query.
    const survived = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async () => ({ ok: false, error: 'rate limited' }),
    });
    assert.equal(survived.ok, true, 'the command is not lost');
    assert.equal(survived.reused, true);
    assert.equal(survived.incomplete, false);
    assert.equal(
      survived.refreshIncomplete,
      true,
      'the caller still records a cooldown'
    );
    assert.match(survived.notes[0], /refresh failed/i);
    assert.match(
      survived.notes[1],
      /rate limited/i,
      'the reason survives for the cooldown note'
    );
    assert.equal(
      runSql(
        complete.dbPath,
        'SELECT COUNT(*) AS count FROM info_view_measures'
      ).rows[0].count,
      1,
      'the earlier snapshot is intact'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed refresh with no catalog on disk is still fatal', async () => {
  const dir = tempDir();
  try {
    const result = await materializeCatalog({
      dir,
      datasetId: 'ds-1',
      alias: 'sales',
      retry: (run) => run,
      run: async () => ({ ok: false, error: 'rate limited' }),
    });
    assert.equal(result.ok, false, 'a cold start has nothing to fall back to');
    assert.match(result.error, /rate limited/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderCatalog surfaces incomplete status prominently', () => {
  const catalog = renderCatalog(
    [
      {
        table: 'catalog_status',
        rowCount: 1,
        columns: [{ name: 'status', type: 'TEXT' }],
        grain: 'status',
        dax: 'derived',
      },
    ],
    {
      incomplete: true,
      notes: ['measures failed'],
    }
  );
  assert.match(catalog, /Catalog status: \*\*INCOMPLETE\*\*/);
  assert.match(catalog, /measures failed/);
});

test('rate-limit retry honors hints and then succeeds', async () => {
  let calls = 0;
  const waits = [];
  const run = withRateLimitRetry(
    async () => {
      calls += 1;
      return calls < 3
        ? {
            ok: false,
            error: '429 rate limit. Retry in 60 seconds.',
          }
        : { ok: true, rows: [] };
    },
    {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      jitter: () => 1,
    }
  );
  assert.equal(isRateLimited(await run('x')), false);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [62_000, 64_000]);
  assert.equal(
    retryDelayMs({ ok: false, error: '429. Retry in 60 seconds.' }, 0, {
      base: 2_000,
      jitter: () => 0,
    }),
    60_000,
    'the service hint is a minimum, not a jitter window'
  );
  assert.equal(
    retryDelayMs({ ok: false, error: '429. Retry in 60 seconds.' }, 0, {
      base: 2_000,
      jitter: () => 1,
    }),
    62_000
  );
  assert.equal(
    retryDelayMs(
      {
        ok: false,
        error:
          'Fabric API error: 429. Request is blocked by the upstream ' +
          'service until: 9/22/2026 4:15:38 AM (UTC)',
      },
      0,
      {
        base: 2_000,
        jitter: () => 0,
        now: () => Date.UTC(2026, 8, 22, 4, 14, 38),
      }
    ),
    60_000,
    'an absolute UTC deadline is also a minimum wait'
  );
  assert.equal(
    retryDelayMs(
      {
        ok: false,
        error:
          'Fabric API error: 429. Request is blocked by the upstream ' +
          'service until: 9/22/2026 4:15:38 AM (UTC)',
      },
      0,
      {
        base: 2_000,
        jitter: () => 1,
        now: () => Date.UTC(2026, 8, 22, 4, 14, 38),
      }
    ),
    62_000
  );
  assert.equal(
    retryDelayMs({ ok: false, error: 'too many requests' }, 1, {
      base: 100,
      jitter: () => 0,
    }),
    100
  );
  assert.equal(
    retryDelayMs({ ok: false, error: 'too many requests' }, 1, {
      base: 100,
      jitter: () => 1,
    }),
    200
  );
});

test('result formatting uses TSV only when lossless', () => {
  const tsv = formatResult({
    ok: true,
    totalRows: 1,
    returnedRows: 1,
    truncated: false,
    rows: [{ Name: 'Revenue', Count: 3 }],
  });
  assert.match(tsv, /^# \{"ok":true/u);
  assert.match(tsv, /Name\tCount\nRevenue\t3\n$/u);

  const json = formatResult({
    ok: true,
    totalRows: 1,
    returnedRows: 1,
    truncated: false,
    rows: [{ Name: 'line\nbreak' }],
  });
  assert.match(json, /^\{"ok":true/u);
});

test('row and byte bounds cannot silently report a complete preview', () => {
  const rowBound = boundRows(
    Array.from({ length: 5 }, (_, index) => ({
      index,
    })),
    { limit: 2 }
  );
  assert.equal(rowBound.truncated, true);
  assert.equal(rowBound.truncation.reason, 'row_limit');

  const byteBound = boundRows(
    [{ text: 'x'.repeat(1000) }, { text: 'y'.repeat(1000) }],
    { maxBytes: 300 }
  );
  assert.equal(byteBound.truncated, true);
  assert.equal(byteBound.truncation.reason, 'byte_budget');
  assert.equal(resultExitCode(byteBound), 2);
  assert.equal(resultExitCode(byteBound, { allowTruncated: true }), 0);
});

test('semantic search ranks exact shipped measures first', () => {
  const resultSets = [
    {
      table: 'info_view_tables',
      rows: [{ Name: 'Sales' }],
    },
    {
      table: 'info_view_columns',
      rows: [
        {
          Table: 'Sales',
          Name: 'Revenue Category',
        },
      ],
    },
    {
      table: 'info_view_measures',
      rows: [
        {
          Table: 'Sales',
          Name: 'Revenue',
          Expression: "SUM('Sales'[Amount])",
        },
      ],
    },
  ];
  const rows = semanticSearchRows(resultSets);
  const ranked = rankSemanticSearchRows(rows, 'revenue');
  assert.equal(ranked[0].kind, 'measure');
  assert.equal(ranked[0].object_name, 'Revenue');
});

test('searchCatalog queries the derived search table', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    buildDatabase(
      [
        {
          table: 'info_view_measures',
          grain: '',
          dax: '',
          rows: sampleRowsFor({
            table: 'info_view_measures',
          }),
        },
      ],
      dbPath
    );
    const result = searchCatalog(dbPath, 'revenue');
    assert.equal(result.ok, true);
    assert.equal(result.rows[0].object_name, 'Revenue');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSql is read-only', () => {
  const dir = tempDir();
  try {
    const dbPath = join(dir, 'model.sqlite');
    const db = new DatabaseSync(dbPath);
    createTable(db, 't', [{ value: 1 }]);
    db.close();
    const result = runSql(dbPath, 'INSERT INTO t VALUES (2)');
    assert.equal(result.ok, false);
    assert.match(result.error, /read.?only|readonly/i);

    const copiedPath = join(dir, 'exfiltrated.sqlite');
    const escapedPath = copiedPath.replace(/'/gu, "''");
    const vacuum = runSql(dbPath, `VACUUM INTO '${escapedPath}'`);
    assert.equal(vacuum.ok, false);
    assert.match(vacuum.error, /read.?only|readonly/i);
    assert.equal(
      existsSync(copiedPath) ? statSync(copiedPath).size : 0,
      0,
      'query_only may leave an empty destination, but no catalog data may escape'
    );

    const bypassPath = join(dir, 'multi-statement.sqlite');
    const escapedBypassPath = bypassPath.replace(/'/gu, "''");
    runSql(
      dbPath,
      `PRAGMA query_only = OFF; VACUUM INTO '${escapedBypassPath}'`
    );
    // The first statement succeeds as a no-op PRAGMA. The guarantee is that
    // prepare().all() never compiles the second statement; exec() would.
    assert.equal(
      existsSync(bypassPath) && statSync(bypassPath).size > 0,
      false,
      'one prepared statement per connection is load-bearing: exec would run both statements'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TTL defaults to 15 minutes and staleness is timestamp-only', () => {
  assert.equal(ttlMinutes(undefined), 15);
  assert.equal(ttlMinutes('0'), 0);
  assert.equal(cacheStatus(null).reason, 'no cached catalog on disk');
  assert.equal(
    cacheStatus(Date.now() - 14 * 60_000, {
      ttl: 15,
    }).fresh,
    true
  );
  assert.equal(
    cacheStatus(Date.now() - 16 * 60_000, {
      ttl: 15,
    }).fresh,
    false
  );
});

test('model cache paths require a GUID and stay inside the cache root', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal(modelCacheDir('.schema', id), join('.schema', 'models', id));
  assert.throws(
    () => modelCacheDir('.schema', '../outside'),
    /Invalid.*itemId/i
  );
});
