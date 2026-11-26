//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  isFabricGuid,
  normalizeColName,
  parseQueryOutput,
  resolveAlias,
  resolveIdentity,
  runFabricQuery,
} from './schema.mjs';

const DATASET_ID = '11111111-2222-3333-4444-555555555555';
const WORKSPACE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const connectors = [
  {
    name: 'sales',
    type: 'fabric-semanticmodel',
    config: { workspaceId: WORKSPACE_ID, itemId: DATASET_ID },
  },
  {
    name: 'sql',
    type: 'fabric-sql',
    config: { workspaceId: 'ws-2', itemId: 'wh-1' },
  },
];

test('resolveIdentity uses connector list output instead of parsing rayfin.yml', async () => {
  const identity = await resolveIdentity({
    alias: 'SALES',
    list: async () => ({ ok: true, connectors }),
  });
  assert.deepEqual(identity, {
    datasetId: DATASET_ID,
    workspaceId: WORKSPACE_ID,
  });
});

test('resolveIdentity rejects a connector itemId that is not a GUID', async () => {
  const identity = await resolveIdentity({
    alias: 'sales',
    list: async () => ({
      ok: true,
      connectors: [
        {
          name: 'sales',
          type: 'fabric-semanticmodel',
          config: { itemId: '../outside' },
        },
      ],
    }),
  });
  assert.match(identity.error, /invalid itemId/i);
  assert.equal(isFabricGuid('../outside'), false);
  assert.equal(isFabricGuid(DATASET_ID), true);
});

test('resolveIdentity returns a readable resolution error', async () => {
  const identity = await resolveIdentity({
    alias: 'sales',
    list: async () => ({
      ok: false,
      error:
        'Could not resolve connectors because connector list returned empty stdout.',
    }),
  });
  assert.match(identity.error, /Could not resolve connectors/i);
});

test('resolveAlias treats a list launch failure as a resolution error', async () => {
  const out = await resolveAlias('.', undefined, {
    cliEntry: 'rayfin-entry',
    spawnImpl: () => {
      throw new Error('This test injects at the list boundary instead.');
    },
  });
  assert.match(
    out.error,
    /Could not run the Rayfin CLI/i,
    'a failed list command must be a resolution error, not zero connectors'
  );
});

test('resolveAlias selects the only semantic-model connector', async () => {
  const out = await resolveAlias('.', undefined, {
    cliEntry: 'rayfin-entry',
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify(connectors));
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(out.alias, 'sales');
  assert.equal(out.connector?.name, 'sales');
});

test('resolveAlias gives a valid connector add command when none exist', async () => {
  const out = await resolveAlias('.', undefined, {
    cliEntry: 'rayfin-entry',
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', '[]');
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.match(out.error, /--type fabric-semanticmodel/u);
  assert.match(out.error, /--workspace-id <workspace-id>/u);
  assert.match(out.error, /--item-id <item-id>/u);
  assert.doesNotMatch(out.error, /--url/u);
});

test('resolveAlias honors an explicit alias without running the CLI', async () => {
  assert.deepEqual(await resolveAlias('.', 'sales'), { alias: 'sales' });
});

test('parseQueryOutput preserves Rayfin column names', () => {
  const result = parseQueryOutput({
    status: 'success',
    table: {
      columns: [{ name: '[Table]' }, { name: '[Max Length]' }],
      rows: [['Sales', 12]],
    },
  });
  assert.deepEqual(result, {
    ok: true,
    columns: [
      { name: 'Table', dataType: 'unknown' },
      { name: 'Max Length', dataType: 'unknown' },
    ],
    rows: [{ Table: 'Sales', 'Max Length': 12 }],
  });
  assert.equal(normalizeColName('plain'), 'plain');
});

test('parseQueryOutput does not implement the dead _cliWarning branch', () => {
  const result = parseQueryOutput({
    status: 'success',
    _cliWarning: 'Result trimmed to first 1000 of 1492 rows',
    table: {
      columns: [{ name: '[Name]' }],
      rows: [['Sales']],
    },
  });
  assert.deepEqual(result, {
    ok: true,
    columns: [{ name: 'Name', dataType: 'unknown' }],
    rows: [{ Name: 'Sales' }],
  });
  assert.equal(
    Object.hasOwn(result, 'truncated'),
    false,
    'Rayfin reports query overflow as a hard error, not _cliWarning'
  );
});

test('runFabricQuery imports invokeConnector directly and makes one invoke', async () => {
  const calls = [];
  const result = await runFabricQuery('EVALUATE INFO.VIEW.TABLES()', {
    alias: 'sales',
    cwd: 'C:\\app',
    invoke: async (options) => {
      calls.push(options);
      return {
        ok: true,
        output: {
          status: 'success',
          table: {
            columns: [{ name: '[Name]', dataType: 'String' }],
            rows: [['Sales']],
          },
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    connector: 'sales',
    query: 'EVALUATE INFO.VIEW.TABLES()',
    limit: undefined,
    cwd: 'C:\\app',
  });
  assert.deepEqual(result.columns, [{ name: 'Name', dataType: 'String' }]);
  assert.deepEqual(result.rows, [{ Name: 'Sales' }]);
});

test('one CLI spawn resolves both the alias and the dataset id', async () => {
  // resolveAlias already holds the connector record; re-listing it in
  // resolveIdentity doubled the spawn count on every schema:sql call.
  const connectors = [
    {
      name: 'model',
      type: 'fabric-semanticmodel',
      config: { itemId: '11111111-2222-3333-4444-555555555555' },
    },
  ];
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify(connectors));
      child.emit('close', 0, null);
    });
    return child;
  };
  const cli = { cliEntry: 'rayfin-entry', spawnImpl };

  const resolved = await resolveAlias('.', undefined, cli);
  assert.equal(resolved.alias, 'model');
  assert.equal(spawns, 1);

  const identity = await resolveIdentity({
    alias: resolved.alias,
    connector: resolved.connector,
    ...cli,
  });
  assert.equal(identity.datasetId, '11111111-2222-3333-4444-555555555555');
  assert.equal(spawns, 1, 'the second lookup reuses the first result');
});

test('an explicit --alias still resolves its dataset id', async () => {
  // resolveAlias returns early for an explicit alias and has no record to
  // pass on, so resolveIdentity falls back to its own lookup.
  let calls = 0;
  const list = async () => {
    calls += 1;
    return {
      ok: true,
      connectors: [
        {
          name: 'model',
          type: 'fabric-semanticmodel',
          config: { itemId: '11111111-2222-3333-4444-555555555555' },
        },
      ],
    };
  };

  const resolved = await resolveAlias('.', 'model');
  assert.equal(resolved.alias, 'model');
  assert.equal(resolved.connector, undefined);

  const identity = await resolveIdentity({
    alias: resolved.alias,
    connector: resolved.connector,
    list,
  });
  assert.equal(identity.datasetId, '11111111-2222-3333-4444-555555555555');
  assert.equal(calls, 1);
});
