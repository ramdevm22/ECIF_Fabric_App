//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

function parseJson(text) {
  try {
    return JSON.parse(String(text).trim());
  } catch {
    return null;
  }
}

function samePath(left, right) {
  const normalize = (value) => {
    const path = resolve(String(value));
    return process.platform === 'win32' ? path.toLocaleLowerCase() : path;
  };
  return normalize(left) === normalize(right);
}

export function rayfinErrorMessage(value) {
  if (value?.status === 'error') {
    return String(
      value.error?.message ??
        value.error ??
        'Rayfin connector invocation failed.'
    );
  }
  return null;
}

export function resolveRayfinCliEntry({
  moduleUrl = import.meta.url,
  createRequireImpl = createRequire,
  readFileSyncImpl = readFileSync,
} = {}) {
  const require = createRequireImpl(moduleUrl);
  const packagePath = require.resolve('@microsoft/rayfin-cli/package.json');
  const packageJson = JSON.parse(readFileSyncImpl(packagePath, 'utf8'));
  const relativeEntry =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.rayfin;
  if (typeof relativeEntry !== 'string' || relativeEntry.length === 0) {
    throw new Error(
      '@microsoft/rayfin-cli does not declare a rayfin executable.'
    );
  }
  return join(dirname(packagePath), relativeEntry);
}

function launchError(error) {
  const code = error?.code ? ` (${error.code})` : '';
  return (
    `Could not run the Rayfin CLI${code}. ` +
    'Install the app dependencies, then retry. ' +
    `Details: ${error?.message ?? String(error)}`
  );
}

export function runRayfinCli({
  args,
  cwd = process.cwd(),
  cliEntry,
  spawnImpl = spawn,
  environment = process.env,
}) {
  return new Promise((resolveResult) => {
    let commandEntry;
    try {
      commandEntry = cliEntry ?? resolveRayfinCliEntry();
    } catch (error) {
      resolveResult({ ok: false, error: launchError(error) });
      return;
    }

    let child;
    try {
      child = spawnImpl(process.execPath, [commandEntry, ...args], {
        cwd,
        env: environment,
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      resolveResult({ ok: false, error: launchError(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    // Pipe chunks do not respect character boundaries, so a multi-byte
    // character split across two reads decodes as U+FFFD under a per-chunk
    // toString(). StringDecoder holds the partial sequence back until the rest
    // arrives.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    child.stdout?.on('data', (chunk) => {
      stdout += outDecoder.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += errDecoder.write(chunk);
    });
    child.on('error', (error) => {
      finish({
        ok: false,
        error: launchError(error),
        stdout,
        stderr,
      });
    });
    child.on('close', (code, signal) => {
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      const parsed = parseJson(stdout);
      if (code === 0 && signal == null) {
        finish({ ok: true, value: parsed, stdout, stderr });
        return;
      }
      const rayfinError = parsed ? rayfinErrorMessage(parsed) : null;
      const message = rayfinError || stderr.trim() || stdout.trim();
      const status = signal
        ? `Rayfin terminated by signal ${signal}`
        : `Rayfin exited with code ${code ?? 'unknown'}`;
      finish({
        ok: false,
        error: message ? `${status}: ${message}` : `${status}.`,
        stdout,
        stderr,
        exitCode: code,
        signal,
      });
    });
  });
}

export async function listConfiguredConnectors(options = {}) {
  const result = await runRayfinCli({
    ...options,
    args: ['connector', 'list', '--json'],
  });
  if (!result.ok) {
    return result;
  }
  if (!Array.isArray(result.value)) {
    return {
      ok: false,
      error:
        'Could not resolve connectors because `rayfin connector list --json` ' +
        'did not return a JSON array. Run this command from the app root.',
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
  return {
    ok: true,
    connectors: result.value,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function invokeConnector({
  connector,
  query,
  limit,
  cwd = process.cwd(),
  cliEntry,
  spawnImpl = spawn,
}) {
  // Rayfin rejects --file paths outside the project root. Keep both the
  // request and the explicit full-result file inside the app.
  const temporaryDirectory = mkdtempSync(join(cwd, '.rayfin-schema-query-'));
  const payloadPath = join(temporaryDirectory, 'query.json');
  const outputPath = join(temporaryDirectory, 'result.json');
  const payload = {
    query,
    ...(limit ? { resultSetRowCountLimit: Number(limit) } : {}),
  };

  try {
    writeFileSync(payloadPath, JSON.stringify(payload), 'utf8');
    const result = await runRayfinCli({
      args: [
        'connector',
        'invoke',
        connector,
        'executeQuery',
        '--file',
        payloadPath,
        '--output-file',
        outputPath,
        '--json',
      ],
      cwd,
      cliEntry,
      spawnImpl,
    });
    if (!result.ok) {
      return result;
    }

    const envelope = result.value;
    if (!envelope || envelope.status !== 'ok') {
      return {
        ok: false,
        error:
          rayfinErrorMessage(envelope) ??
          'Rayfin connector invoke returned an invalid JSON envelope.',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    if (
      typeof envelope.outputFile !== 'string' ||
      !samePath(envelope.outputFile, outputPath)
    ) {
      return {
        ok: false,
        error:
          'Rayfin did not write the connector result to the requested ' +
          'output file. Refusing to trust the inline preview.',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    const output = parseJson(readFileSync(outputPath, 'utf8'));
    if (output === null) {
      return {
        ok: false,
        error: 'Rayfin wrote a connector result that was not valid JSON.',
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    return {
      ok: true,
      output,
      outputFile: envelope.outputFile,
      outputBytes: envelope.outputBytes,
      outputTruncated: envelope.outputTruncated === true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
