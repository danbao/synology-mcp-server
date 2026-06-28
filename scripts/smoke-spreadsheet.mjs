#!/usr/bin/env node
/**
 * Focused smoke test for the synology/spreadsheet-api container.
 *
 * Prefer `pnpm smoke:write` for end-to-end MCP validation. This script is a
 * lower-level Spreadsheet API probe for debugging the container itself.
 *
 * Required:
 *   SYNO_DSM_HOST or SYNO_HOST
 *   SYNO_USERNAME/SYNO_PASSWORD, or SYNO_SS_USERNAME/SYNO_SS_PASSWORD
 *
 * Notes:
 *   /spreadsheets/authorize accepts username/password/host/protocol only. It
 *   does not accept OTP, so an OTP-protected main DSM account needs a dedicated
 *   no-2FA account in SYNO_SS_USERNAME/SYNO_SS_PASSWORD.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Agent, request, setGlobalDispatcher } from 'undici';

const isTrue = (value) => value === '1' || String(value).toLowerCase() === 'true';

const env = loadRuntimeEnv();
const hasPartialSpreadsheetCreds = Boolean(env.SYNO_SS_USERNAME) !== Boolean(env.SYNO_SS_PASSWORD);
if (hasPartialSpreadsheetCreds) {
  console.error('SYNO_SS_USERNAME and SYNO_SS_PASSWORD must be set together.');
  process.exit(1);
}

const hasDedicatedSpreadsheetCreds = Boolean(env.SYNO_SS_USERNAME && env.SYNO_SS_PASSWORD);
const dsm = parseDsmEndpoint(env.SYNO_DSM_HOST ?? env.SYNO_HOST);
const cfg = {
  dsmHost: dsm.host,
  dsmPort: Number(env.SYNO_PORT ?? dsm.port),
  dsmHttps: env.SYNO_HTTPS === undefined ? dsm.https : isTrue(env.SYNO_HTTPS),
  dsmBackHost: env.SYNO_SS_DSM_HOST ?? dsm.host,
  dsmBackPort: Number(env.SYNO_SS_DSM_PORT ?? 5000),
  dsmBackHttps: isTrue(env.SYNO_SS_DSM_HTTPS ?? 'false'),
  user: hasDedicatedSpreadsheetCreds ? env.SYNO_SS_USERNAME : env.SYNO_USERNAME,
  pass: hasDedicatedSpreadsheetCreds ? env.SYNO_SS_PASSWORD : env.SYNO_PASSWORD,
  hasDedicatedSpreadsheetCreds,
  hasMainOtp: Boolean(env.SYNO_OTP_CODE || env.SYNO_OTP_SECRET),
  ignoreCert: isTrue(env.SYNO_IGNORE_CERT ?? 'false'),
  ssHost: env.SYNO_SS_HOST ?? dsm.host,
  ssPort: Number(env.SYNO_SS_PORT ?? 3000),
  ssHttps: isTrue(env.SYNO_SS_HTTPS ?? 'false'),
};

if (!cfg.user || !cfg.pass) {
  console.error(
    'Missing DSM credentials: set SYNO_USERNAME/SYNO_PASSWORD or SYNO_SS_USERNAME/SYNO_SS_PASSWORD.',
  );
  process.exit(1);
}

if (cfg.hasMainOtp && !cfg.hasDedicatedSpreadsheetCreds) {
  console.error(
    'Spreadsheet /authorize does not accept OTP. Set SYNO_SS_USERNAME/SYNO_SS_PASSWORD to a dedicated no-2FA DSM account.',
  );
  process.exit(1);
}

if (cfg.ignoreCert) {
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

const ssBase = `${cfg.ssHttps ? 'https' : 'http'}://${cfg.ssHost}:${cfg.ssPort}`;
const dsmHostField =
  (cfg.dsmBackHttps && cfg.dsmBackPort === 443) || (!cfg.dsmBackHttps && cfg.dsmBackPort === 80)
    ? cfg.dsmBackHost
    : `${cfg.dsmBackHost}:${cfg.dsmBackPort}`;

let token;
let fileId;
let firstSheetName = 'Sheet1';
let firstSheetId;
let addedSheetId;

function loadRuntimeEnv() {
  const next = { ...process.env };
  const zshrc = resolve(homedir(), '.zshrc');
  if (!existsSync(zshrc)) return next;

  for (const line of readFileSync(zshrc, 'utf8').split('\n')) {
    const match = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (!match || next[match[1]]) continue;
    const raw = (match[2] ?? '').trim();
    if (raw.includes('$(') || raw.includes('`')) continue;
    next[match[1]] = unquote(raw);
  }
  return next;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDsmEndpoint(value) {
  if (!value) {
    console.error('Missing SYNO_DSM_HOST or SYNO_HOST.');
    process.exit(1);
  }
  const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 5001 : 5000,
    https: url.protocol === 'https:',
  };
}

async function step(label, fn) {
  process.stdout.write(`${label} ... `);
  const output = await fn();
  console.log('OK');
  return output;
}

async function ssRequest(method, path, { body, raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const response = await request(`${ssBase}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.statusCode >= 400) {
    const text = await response.body.text();
    throw new Error(`${method} ${path} -> ${response.statusCode}: ${text}`);
  }
  if (raw) return Buffer.from(await response.body.arrayBuffer());
  if (response.statusCode === 204) return null;
  const contentType = response.headers['content-type'] ?? '';
  if (String(contentType).includes('application/json')) return response.body.json();
  return response.body.text();
}

async function cleanup() {
  if (fileId && token) {
    await step('Delete temporary spreadsheet', async () => {
      await ssRequest('POST', '/spreadsheets/delete', { body: { spreadsheetId: fileId } });
      fileId = undefined;
    }).catch((err) => console.error(`cleanup delete failed: ${err.message}`));
  }
  if (token) {
    await step('Revoke token', async () => {
      await ssRequest('POST', '/spreadsheets/authorize/token/revoke');
      token = undefined;
    }).catch((err) => console.error(`cleanup revoke failed: ${err.message}`));
  }
}

try {
  await step('Authorize Spreadsheet API', async () => {
    const body = await ssRequest('POST', '/spreadsheets/authorize', {
      body: {
        username: cfg.user,
        password: cfg.pass,
        host: dsmHostField,
        protocol: cfg.dsmBackHttps ? 'https' : 'http',
      },
    });
    if (!body?.token) throw new Error(`No token: ${JSON.stringify(body)}`);
    token = body.token;
  });

  await step('Create spreadsheet', async () => {
    const body = await ssRequest('POST', '/spreadsheets/create', {
      body: { name: `synology-mcp-smoke-${Date.now()}-sheet` },
    });
    if (!body?.spreadsheetId) throw new Error(`No spreadsheetId: ${JSON.stringify(body)}`);
    fileId = body.spreadsheetId;
  });

  await step('Get spreadsheet info', async () => {
    const body = await ssRequest('GET', `/spreadsheets/${encodeURIComponent(fileId)}`);
    const firstSheet = body?.sheets?.[0]?.properties ?? body?.sheets?.[0];
    if (!firstSheet) throw new Error(`No sheets: ${JSON.stringify(body)}`);
    firstSheetName = firstSheet.title ?? firstSheet.name ?? firstSheetName;
    firstSheetId = firstSheet.sheetId ?? firstSheet.sheet_id;
  });

  await step('Write A1:B2', async () => {
    const range = `${firstSheetName}!A1:B2`;
    await ssRequest(
      'PUT',
      `/spreadsheets/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
      {
        body: {
          values: [
            ['name', 'value'],
            ['smoke', Date.now()],
          ],
        },
      },
    );
  });

  await step('Read A1:B2', async () => {
    const range = `${firstSheetName}!A1:B2`;
    const body = await ssRequest(
      'GET',
      `/spreadsheets/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}`,
    );
    if (!Array.isArray(body?.values)) throw new Error(`No values: ${JSON.stringify(body)}`);
  });

  await step('Append row', async () => {
    const range = `${firstSheetName}!A1:B2`;
    await ssRequest(
      'PUT',
      `/spreadsheets/${encodeURIComponent(fileId)}/values/${encodeURIComponent(range)}/append`,
      { body: { values: [['append', 1]] } },
    );
  });

  await step('Write styles', async () => {
    await ssRequest('PUT', `/spreadsheets/${encodeURIComponent(fileId)}/styles`, {
      body: {
        sheetName: firstSheetName,
        startRow: 0,
        startCol: 0,
        rows: [{ values: [{ userEnteredFormat: { textFormat: { bold: true }, bg: 'ffff00' } }] }],
      },
    });
  });

  await step('Get styles', async () => {
    const range = `${firstSheetName}!A1:B2`;
    await ssRequest(
      'GET',
      `/spreadsheets/${encodeURIComponent(fileId)}/styles/${encodeURIComponent(range)}`,
    );
  });

  if (firstSheetId !== undefined) {
    await step('Batch update', async () => {
      await ssRequest('POST', `/spreadsheets/${encodeURIComponent(fileId)}/batchUpdate`, {
        body: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: firstSheetId,
                  dimension: 'ROWS',
                  startIndex: 1,
                  endIndex: 2,
                },
                inheritFromBefore: true,
              },
            },
          ],
        },
      });
    });
  }

  await step('Add sheet', async () => {
    const body = await ssRequest('POST', `/spreadsheets/${encodeURIComponent(fileId)}/sheet/add`, {
      body: { sheetName: 'Smoke2' },
    });
    addedSheetId = body?.addSheet?.properties?.sheetId;
    if (!addedSheetId) throw new Error(`No added sheetId: ${JSON.stringify(body)}`);
  });

  await step('Rename sheet', async () => {
    await ssRequest('POST', `/spreadsheets/${encodeURIComponent(fileId)}/sheet/rename`, {
      body: { sheetId: addedSheetId, sheetName: 'SmokeRenamed' },
    });
  });

  await step('Delete sheet', async () => {
    await ssRequest('POST', `/spreadsheets/${encodeURIComponent(fileId)}/sheet/delete`, {
      body: { sheetId: addedSheetId },
    });
    addedSheetId = undefined;
  });

  await step('Export xlsx', async () => {
    const buffer = await ssRequest('GET', `/spreadsheets/${encodeURIComponent(fileId)}/xlsx`, {
      raw: true,
    });
    if (!buffer?.length) throw new Error('Empty xlsx export');
  });

  console.log('\nAll Spreadsheet smoke checks passed.');
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  await cleanup();
}
