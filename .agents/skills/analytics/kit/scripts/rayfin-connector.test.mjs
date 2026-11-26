//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import {
  invokeConnector,
  listConfiguredConnectors,
  rayfinErrorMessage,
  resolveRayfinCliEntry,
} from './rayfin-connector.mjs';

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  queueMicrotask(() => onStart(child));
  return child;
}

test('rayfinErrorMessage extracts only error envelopes', () => {
  assert.equal(
    rayfinErrorMessage({
      status: 'error',
      error: { message: 'Access denied' },
    }),
    'Access denied'
  );
  assert.equal(
    rayfinErrorMessage({ status: 'ok', output: { ignored: true } }),
    null
  );
});

test('resolveRayfinCliEntry reads the extensionless package bin', () => {
  const packagePath = join(
    'C:',
    'app',
    'node_modules',
    '@microsoft',
    'rayfin-cli',
    'package.json'
  );
  const createRequireImpl = () => ({
    resolve(specifier) {
      assert.equal(specifier, '@microsoft/rayfin-cli/package.json');
      return packagePath;
    },
  });
  const entry = resolveRayfinCliEntry({
    createRequireImpl,
    readFileSyncImpl: () => JSON.stringify({ bin: { rayfin: 'scripts/main' } }),
  });
  assert.equal(
    entry,
    join(
      'C:',
      'app',
      'node_modules',
      '@microsoft',
      'rayfin-cli',
      'scripts',
      'main'
    )
  );
});

test('connector list treats empty stdout as a resolution error', async () => {
  const result = await listConfiguredConnectors({
    cliEntry: 'rayfin-entry',
    spawnImpl: (_command, args) =>
      fakeChild((child) => {
        assert.deepEqual(args.slice(1), ['connector', 'list', '--json']);
        child.emit('close', 0, null);
      }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not return a JSON array/i);
  assert.match(result.error, /app root/i);
});

test('connector list accepts a valid project with no connectors', async () => {
  const result = await listConfiguredConnectors({
    cliEntry: 'rayfin-entry',
    spawnImpl: () =>
      fakeChild((child) => {
        child.stdout.emit('data', '[]\n');
        child.emit('close', 0, null);
      }),
  });
  assert.deepEqual(result.connectors, []);
});

test('invokeConnector spawns Node directly and reads the full spilled result', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rayfin-project-'));
  const fullRows = Array.from({ length: 120 }, (_, index) => [
    index,
    'x'.repeat(100),
  ]);
  const fullOutput = {
    status: 'success',
    table: {
      columns: [{ name: '[Id]' }, { name: '[Value]' }],
      rows: fullRows,
    },
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(fullOutput), 'utf8') > 8 * 1024,
    "the fixture must exceed Rayfin's default inline threshold"
  );

  let payloadPath;
  let outputPath;
  let command;
  let payload;
  const spawnImpl = (receivedCommand, args, options) => {
    command = receivedCommand;
    assert.equal(options.cwd, cwd);
    assert.equal(options.shell, false);
    assert.equal(args[0], 'rayfin-entry');
    payloadPath = args[args.indexOf('--file') + 1];
    outputPath = args[args.indexOf('--output-file') + 1];
    assert.ok(!relative(cwd, payloadPath).startsWith('..'));
    assert.ok(!relative(cwd, outputPath).startsWith('..'));
    payload = JSON.parse(readFileSync(payloadPath, 'utf8'));

    return fakeChild((child) => {
      writeFileSync(outputPath, JSON.stringify(fullOutput), 'utf8');
      child.stdout.emit(
        'data',
        JSON.stringify({
          status: 'ok',
          output: {
            ...fullOutput,
            table: {
              ...fullOutput.table,
              rows: fullRows.slice(0, 20),
            },
          },
          outputFile: outputPath,
          outputBytes: Buffer.byteLength(JSON.stringify(fullOutput)),
          outputTruncated: true,
          previewItems: 20,
        })
      );
      child.emit('close', 0, null);
    });
  };

  try {
    const result = await invokeConnector({
      connector: 'sales',
      query: 'EVALUATE INFO.VIEW.COLUMNS()',
      cwd,
      cliEntry: 'rayfin-entry',
      spawnImpl,
    });
    assert.equal(command, process.execPath);
    assert.equal(result.ok, true);
    assert.equal(result.outputTruncated, true);
    assert.equal(result.output.table.rows.length, 120);
    assert.equal(
      result.output.table.rows[119][0],
      119,
      'the full file must win over the 20-row stdout preview'
    );
    assert.deepEqual(payload, {
      query: 'EVALUATE INFO.VIEW.COLUMNS()',
    });
    assert.equal(existsSync(payloadPath), false);
    assert.equal(existsSync(outputPath), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('invokeConnector refuses an unverified output file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rayfin-project-'));
  try {
    const result = await invokeConnector({
      connector: 'sales',
      query: 'EVALUATE INFO.VIEW.TABLES()',
      cwd,
      cliEntry: 'rayfin-entry',
      spawnImpl: () =>
        fakeChild((child) => {
          child.stdout.emit(
            'data',
            JSON.stringify({
              status: 'ok',
              output: { preview: true },
              outputFile: join(cwd, 'wrong.json'),
              outputTruncated: true,
            })
          );
          child.emit('close', 0, null);
        }),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /Refusing to trust/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('invokeConnector cleans its directory when payload serialization fails', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rayfin-project-'));
  try {
    await assert.rejects(
      invokeConnector({
        connector: 'sales',
        query: 1n,
        cwd,
        cliEntry: 'rayfin-entry',
      }),
      /BigInt/
    );
    assert.deepEqual(
      readdirSync(cwd).filter((name) =>
        name.startsWith('.rayfin-schema-query-')
      ),
      []
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
