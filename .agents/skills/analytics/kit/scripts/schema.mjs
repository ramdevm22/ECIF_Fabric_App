//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import {
  invokeConnector,
  listConfiguredConnectors,
} from './rayfin-connector.mjs';

export function normalizeColName(name) {
  const match = String(name).match(/\[([^\]]+)\]\s*$/);
  return match ? match[1] : String(name);
}

export function isFabricGuid(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(String(value));
}

export function parseQueryOutput(value) {
  if (!value) {
    return { ok: false, error: 'No output from query.' };
  }
  if (value.status === 'error') {
    const message = value.error?.message ?? value.error;
    return {
      ok: false,
      error: String(message || 'Unknown query error.'),
    };
  }
  const table =
    value.table ?? (Array.isArray(value.tables) ? value.tables[0] : undefined);
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    return {
      ok: false,
      error: 'Query result did not contain a table.',
    };
  }
  const columns = table.columns.map((column) => ({
    name: normalizeColName(column?.name),
    dataType:
      typeof column?.dataType === 'string' ? column.dataType : 'unknown',
  }));
  const rows = table.rows.map((row) => {
    const record = {};
    columns.forEach((column, index) => {
      record[column.name] = Array.isArray(row) ? row[index] : undefined;
    });
    return record;
  });
  return { ok: true, columns, rows };
}

export async function runFabricQuery(dax, options = {}) {
  const {
    alias,
    limit,
    cwd = process.cwd(),
    invoke = invokeConnector,
  } = options;
  const result = await invoke({
    connector: alias,
    query: dax,
    limit,
    cwd,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return parseQueryOutput(result.output);
}

async function semanticModelConnectors(options = {}) {
  const result = await listConfiguredConnectors(options);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    connectors: result.connectors.filter(
      (connector) =>
        connector?.type === 'fabric-semanticmodel' &&
        typeof connector.name === 'string' &&
        connector.name.length > 0
    ),
  };
}

export async function resolveAlias(cwd, explicit, options = {}) {
  if (explicit) {
    return { alias: explicit };
  }
  const result = await semanticModelConnectors({ cwd, ...options });
  if (!result.ok) {
    return { error: result.error };
  }
  const aliases = result.connectors.map((connector) => connector.name);
  if (aliases.length === 0) {
    return {
      error:
        'No semantic model connector is configured. Connect one first:\n\n' +
        '  npx rayfin connector add --type fabric-semanticmodel ' +
        '--workspace-id <workspace-id> --item-id <item-id> --name model',
    };
  }
  if (aliases.length > 1) {
    return {
      error:
        `This app is connected to ${aliases.length} semantic models: ` +
        `${aliases.join(', ')}.\n\n` +
        `  npm run --silent schema:sql -- --alias ${aliases[0]} "SELECT ..."`,
    };
  }
  // Hand back the connector too: resolveIdentity needs the same record, and
  // re-listing costs another CLI spawn on every command.
  return { alias: aliases[0], connector: result.connectors[0] };
}

export async function resolveIdentity(options = {}) {
  const {
    alias,
    connector: known,
    cwd = process.cwd(),
    list = listConfiguredConnectors,
  } = options;
  if (!alias) {
    return {};
  }
  let connector = known;
  if (!connector) {
    const result = await list({ cwd });
    if (!result.ok) {
      return { error: result.error };
    }
    connector = result.connectors.find(
      (entry) =>
        entry?.type === 'fabric-semanticmodel' &&
        typeof entry.name === 'string' &&
        entry.name.toLocaleLowerCase() === String(alias).toLocaleLowerCase()
    );
  }
  if (!connector) {
    return {
      error:
        `Semantic model connector "${alias}" was not found. ` +
        'Run `npx rayfin connector list --json` from the app root.',
    };
  }
  const datasetId = connector.config?.itemId;
  if (!isFabricGuid(datasetId)) {
    return {
      error:
        `Semantic model connector "${alias}" has an invalid itemId. ` +
        'Reconnect it with `npx rayfin connector add`.',
    };
  }
  return {
    datasetId,
    workspaceId:
      typeof connector.config?.workspaceId === 'string'
        ? connector.config.workspaceId
        : null,
  };
}
