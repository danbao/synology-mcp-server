#!/usr/bin/env node
/**
 * Real-NAS smoke tests through the MCP stdio transport.
 *
 * Usage:
 *   pnpm smoke:readonly
 *   pnpm smoke:write
 *
 * The write mode creates resources named synology-mcp-smoke-<timestamp> and
 * attempts cleanup in reverse order. Existing non-smoke user data is not used
 * for destructive operations.
 */

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { Agent, fetch as undiciFetch } from 'undici';

const mode = process.argv[2] === 'write' ? 'write' : 'readonly';
const smokeId = `synology-mcp-smoke-${Date.now()}`;
const serverPath = resolve('dist/index.js');

if (!existsSync(serverPath)) {
  console.error('Missing dist/index.js. Run pnpm build first.');
  process.exit(1);
}

const env = normalizeEnv(loadRuntimeEnv());
const results = [];
const cleanups = [];
let initialTotpCounter;
let lastDirectDsmLoginCounter;

function loadRuntimeEnv() {
  const next = { ...process.env };
  const zshrc = resolve(homedir(), '.zshrc');
  if (!existsSync(zshrc)) return next;

  const text = readFileSync(zshrc, 'utf8');
  for (const line of text.split('\n')) {
    const match = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (!key || next[key]) continue;
    const raw = (match[2] ?? '').trim();
    if (raw.includes('$(') || raw.includes('`')) continue;
    next[key] = unquote(raw);
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

function normalizeEnv(input) {
  const next = { ...input, MCP_TRANSPORT: 'stdio' };
  const endpoint = next.SYNO_DSM_HOST ?? next.SYNO_HOST;
  if (!endpoint) {
    console.error('Missing SYNO_HOST or SYNO_DSM_HOST.');
    process.exit(1);
  }

  const parsed = parseDsmEndpoint(endpoint);
  next.SYNO_HOST = next.SYNO_HOST ?? parsed.host;
  next.SYNO_PORT = next.SYNO_PORT ?? String(parsed.port);
  next.SYNO_HTTPS = next.SYNO_HTTPS ?? String(parsed.https);
  next.SYNO_IGNORE_CERT = next.SYNO_IGNORE_CERT ?? 'true';

  next.SYNO_SS_HOST = next.SYNO_SS_HOST ?? next.SYNO_HOST;
  next.SYNO_SS_PORT = next.SYNO_SS_PORT ?? '3000';
  next.SYNO_SS_HTTPS = next.SYNO_SS_HTTPS ?? 'false';
  next.SYNO_SS_DSM_HOST = next.SYNO_SS_DSM_HOST ?? next.SYNO_HOST;
  next.SYNO_SS_DSM_PORT = next.SYNO_SS_DSM_PORT ?? '5000';
  next.SYNO_SS_DSM_HTTPS = next.SYNO_SS_DSM_HTTPS ?? 'false';

  for (const key of ['SYNO_USERNAME', 'SYNO_PASSWORD']) {
    if (!next[key]) {
      console.error(`Missing ${key}.`);
      process.exit(1);
    }
  }
  return next;
}

function parseDsmEndpoint(value) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 5001 : 5000,
    https: url.protocol === 'https:',
  };
}

class McpStdioClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.child = spawn('node', [serverPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server exited before response (code=${code}, signal=${signal})`));
      }
      this.pending.clear();
    });
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params, timeoutMs = 45_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'synology-office-mcp-smoke', version: '1.0.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async callTool(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args }, 90_000);
    if (response.error) {
      throw new Error(`${name}: ${response.error.message}`);
    }
    const text = response.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      throw new Error(`${name}: missing text result`);
    }
    const payload = JSON.parse(text);
    if (payload?.error) {
      throw new Error(`${name}: ${payload.code ?? 'ERROR'} ${payload.message ?? ''}`.trim());
    }
    return payload;
  }

  close() {
    this.child.stdin.end();
    setTimeout(() => {
      if (!this.child.killed) this.child.kill('SIGTERM');
    }, 1000).unref();
  }
}

function pass(product, tool, detail) {
  results.push({ product, tool, status: 'pass', detail });
  console.log(`PASS ${product}.${tool} - ${detail}`);
}

function fail(product, tool, err) {
  const detail = err instanceof Error ? err.message : String(err);
  results.push({ product, tool, status: 'fail', detail });
  console.log(`FAIL ${product}.${tool} - ${detail}`);
}

function skip(product, tool, detail) {
  results.push({ product, tool, status: 'skipped', detail });
  console.log(`SKIP ${product}.${tool} - ${detail}`);
}

async function step(product, tool, fn) {
  try {
    const detail = await fn();
    pass(product, tool, detail ?? 'ok');
  } catch (err) {
    fail(product, tool, err);
  }
}

async function requiredStep(product, tool, fn) {
  try {
    const detail = await fn();
    pass(product, tool, detail ?? 'ok');
    return true;
  } catch (err) {
    fail(product, tool, err);
    return false;
  }
}

async function readonlySmoke(mcp, state) {
  await step('drive', 'drive_list_files', async () => {
    const r = await mcp.callTool('drive_list_files', { folder_path: '/mydrive', limit: 20 });
    state.driveFiles = r.files ?? [];
    return `${r.total ?? state.driveFiles.length} item(s)`;
  });

  await step('drive', 'drive_list_labels', async () => {
    const r = await mcp.callTool('drive_list_labels', {});
    state.driveLabels = r.labels ?? [];
    return `${state.driveLabels.length} label(s)`;
  });

  await step('drive', 'drive_get_file_info', async () => {
    const r = await mcp.callTool('drive_get_file_info', { path: '/mydrive' });
    return r.name ? `name=${r.name}` : 'root ok';
  });

  const smallFile = (state.driveFiles ?? []).find(
    (f) =>
      f.type === 'file' && typeof f.path === 'string' && Number(f.size ?? 0) <= maxDownloadBytes(),
  );
  if (smallFile) {
    await step('drive', 'drive_download_file', async () => {
      const r = await mcp.callTool('drive_download_file', { path: smallFile.path });
      return `${r.file_name ?? smallFile.path} ${r.size ?? 0} byte(s)`;
    });
  } else {
    skip('drive', 'drive_download_file', 'no small file found in /mydrive');
  }

  await step('spreadsheet', 'spreadsheet_list', async () => {
    const r = await mcp.callTool('spreadsheet_list', { limit: 20 });
    state.spreadsheets = r.files ?? [];
    return `${r.total ?? state.spreadsheets.length} spreadsheet(s)`;
  });

  const listedSpreadsheetId = state.spreadsheets?.[0]?.file_id;
  const spreadsheetId =
    env.SMOKE_SPREADSHEET_ID ??
    (usesDifferentSpreadsheetAccount() ? undefined : listedSpreadsheetId);
  if (spreadsheetId && usesMainDsmOtpAccountForSpreadsheet()) {
    skip(
      'spreadsheet',
      'spreadsheet_get_info',
      'Spreadsheet /authorize does not accept OTP; set SYNO_SS_USERNAME/SYNO_SS_PASSWORD to deep-read spreadsheets',
    );
  } else if (spreadsheetId) {
    const hasInfo = await requiredStep('spreadsheet', 'spreadsheet_get_info', async () => {
      const r = await mcp.callTool('spreadsheet_get_info', { file_id: spreadsheetId });
      state.readonlySheetName = r.sheets?.[0]?.name ?? 'Sheet1';
      return `${r.sheets?.length ?? 0} sheet(s)`;
    });
    if (!hasInfo) return;
    await step('spreadsheet', 'spreadsheet_read_sheet', async () => {
      const r = await mcp.callTool('spreadsheet_read_sheet', {
        file_id: spreadsheetId,
        sheet_name: state.readonlySheetName,
        range: 'A1:B2',
        include_formulas: false,
      });
      return `${r.rows?.length ?? 0} row(s)`;
    });
    await step('spreadsheet', 'spreadsheet_get_styles', async () => {
      const r = await mcp.callTool('spreadsheet_get_styles', {
        file_id: spreadsheetId,
        sheet_name: state.readonlySheetName,
        range: 'A1:B2',
      });
      return `${r.styles?.length ?? 0} row(s)`;
    });
    await step('spreadsheet', 'spreadsheet_export', async () => {
      const r = await mcp.callTool('spreadsheet_export', {
        file_id: spreadsheetId,
        format: 'xlsx',
      });
      return `${r.file_name ?? 'export'} ${r.size ?? 0} byte(s)`;
    });
  } else {
    skip(
      'spreadsheet',
      'spreadsheet_get_info',
      usesDifferentSpreadsheetAccount()
        ? 'set SMOKE_SPREADSHEET_ID to a spreadsheet accessible by SYNO_SS_USERNAME for read-only deep checks'
        : 'set SMOKE_SPREADSHEET_ID or create a sheet first',
    );
  }

  await step('calendar', 'calendar_list_calendars', async () => {
    const r = await mcp.callTool('calendar_list_calendars', {});
    state.calendars = r.calendars ?? [];
    return `${state.calendars.length} calendar(s)`;
  });

  if (state.calendars?.[0]?.id) {
    await step('calendar', 'calendar_list_events', async () => {
      const start = new Date(Date.now() - 30 * 86400_000).toISOString();
      const end = new Date(Date.now() + 365 * 86400_000).toISOString();
      const r = await mcp.callTool('calendar_list_events', {
        calendar_id: state.calendars[0].id,
        start_date: start,
        end_date: end,
        limit: 20,
      });
      state.events = r.events ?? [];
      return `${state.events.length} event(s)`;
    });
    if (state.events?.[0]?.id) {
      await step('calendar', 'calendar_get_event', async () => {
        const r = await mcp.callTool('calendar_get_event', {
          event_id: state.events[0].id,
          calendar_id: state.calendars[0].id,
        });
        return r.title ?? state.events[0].id;
      });
    }
  }

  await step('mailplus', 'mailplus_list_folders', async () => {
    const r = await mcp.callTool('mailplus_list_folders', {});
    state.mailFolders = r.folders ?? [];
    return `${state.mailFolders.length} folder(s)`;
  });

  await step('mailplus', 'mailplus_list_messages', async () => {
    const r = await mcp.callTool('mailplus_list_messages', { folder_path: 'INBOX', limit: 5 });
    state.mailMessages = r.messages ?? [];
    return `${r.total ?? state.mailMessages.length} message(s)`;
  });

  if (state.mailMessages?.[0]?.id) {
    await step('mailplus', 'mailplus_get_message', async () => {
      const r = await mcp.callTool('mailplus_get_message', {
        message_id: state.mailMessages[0].id,
        include_attachments: false,
      });
      return r.subject ?? state.mailMessages[0].id;
    });
  }
}

async function writeSmoke(mcp, state) {
  await driveWriteSmoke(mcp, state);
  await spreadsheetWriteSmoke(mcp, state);
  await calendarWriteSmoke(mcp, state);
  await mailplusWriteSmoke(mcp);
}

async function driveWriteSmoke(mcp, state) {
  const folder = `/mydrive/${smokeId}`;
  const moved = `${folder}/moved`;
  const file = `${folder}/smoke.txt`;
  const movedFile = `${moved}/smoke-renamed.txt`;

  if (
    !(await requiredStep('drive', 'drive_create_folder', async () => {
      await mcp.callTool('drive_create_folder', { folder_path: '/mydrive', name: smokeId });
      cleanups.push(async () => {
        await mcp.callTool('drive_delete_file', { path: folder, permanent: false, confirm: true });
      });
      return folder;
    }))
  )
    return;

  await step('drive', 'drive_create_folder', async () => {
    await mcp.callTool('drive_create_folder', { folder_path: folder, name: 'moved' });
    return moved;
  });
  await step('drive', 'drive_upload_file', async () => {
    const r = await mcp.callTool('drive_upload_file', {
      dest_folder_path: folder,
      file_name: 'smoke.txt',
      content_base64: Buffer.from(`hello ${smokeId}`).toString('base64'),
      mime_type: 'text/plain',
      conflict_action: 'version',
    });
    return r.file_path ?? file;
  });
  await step('drive', 'drive_download_file', async () => {
    const r = await mcp.callTool('drive_download_file', { path: file });
    return `${r.file_name ?? 'smoke.txt'} ${r.size ?? 0} byte(s)`;
  });
  let label = state.driveLabels?.[0]?.name;
  if (!label && env.SMOKE_DRIVE_AUTOCREATE_LABEL !== 'false') {
    await step('drive', 'drive_create_temp_label', async () => {
      const created = await createTemporaryDriveLabel();
      state.driveLabels = [created];
      label = created.name;
      return created.name;
    });
  }
  if (label) {
    await step('drive', 'drive_add_label', async () => {
      await mcp.callTool('drive_add_label', { path: file, label_name: label });
      return label;
    });
  } else {
    skip('drive', 'drive_add_label', 'no Drive labels configured');
  }
  await step('drive', 'drive_move_file', async () => {
    await mcp.callTool('drive_move_file', {
      path: file,
      dest_folder_path: moved,
      new_name: 'smoke-renamed.txt',
      conflict_action: 'autorename',
      confirm: true,
    });
    return movedFile;
  });
}

async function createTemporaryDriveLabel() {
  const name = `${smokeId}-label`;
  const label = await withDirectDsmSession(async ({ proto, dispatcher, sid }) => {
    const params = new URLSearchParams({
      api: 'SYNO.SynologyDrive.Labels',
      version: '1',
      method: 'create',
      name,
      color: '#ffcc00',
      position: '0',
    });
    const response = await undiciFetch(
      `${proto}://${env.SYNO_HOST}:${env.SYNO_PORT}/webapi/entry.cgi?${params.toString()}`,
      {
        method: 'PUT',
        headers: { Cookie: `id=${sid}` },
        dispatcher,
      },
    );
    const payload = await response.json();
    if (!payload.success) {
      throw new Error(`Drive label create failed with code ${payload.error?.code ?? 'unknown'}`);
    }

    const id = payload.data?.label_id ?? payload.data?.id ?? payload.data?.label?.label_id;
    if (!id) throw new Error('Drive label create returned no label id');
    return { id: String(id), name, color: '#ffcc00' };
  });

  cleanups.push(async () => {
    await deleteTemporaryDriveLabel(label.id);
  });
  return label;
}

async function deleteTemporaryDriveLabel(labelId) {
  await withDirectDsmSession(async ({ proto, dispatcher, sid }) => {
    const params = new URLSearchParams({
      api: 'SYNO.SynologyDrive.Labels',
      version: '1',
      method: 'delete',
      label_id: labelId,
    });
    const response = await undiciFetch(
      `${proto}://${env.SYNO_HOST}:${env.SYNO_PORT}/webapi/entry.cgi?${params.toString()}`,
      {
        method: 'DELETE',
        headers: { Cookie: `id=${sid}` },
        dispatcher,
      },
    );
    const payload = await response.json();
    if (!payload.success) {
      throw new Error(`Drive label delete failed with code ${payload.error?.code ?? 'unknown'}`);
    }
  });
}

async function spreadsheetWriteSmoke(mcp, state) {
  if (usesMainDsmOtpAccountForSpreadsheet()) {
    skip(
      'spreadsheet',
      'spreadsheet_create',
      'Spreadsheet /authorize does not accept OTP; set SYNO_SS_USERNAME/SYNO_SS_PASSWORD to a no-2FA service account',
    );
    return;
  }

  const name = `${smokeId}-sheet`;
  let fileId;
  let sheetName = 'Sheet1';
  let sheetId;
  let addedSheetId;

  if (
    !(await requiredStep('spreadsheet', 'spreadsheet_create', async () => {
      const r = await mcp.callTool('spreadsheet_create', { name });
      fileId = r.file_id;
      cleanups.push(async () => {
        if (fileId)
          await mcp.callTool('spreadsheet_delete_file', { file_id: fileId, confirm: true });
      });
      return fileId;
    }))
  )
    return;

  await step('spreadsheet', 'spreadsheet_get_info', async () => {
    const r = await mcp.callTool('spreadsheet_get_info', { file_id: fileId });
    sheetName = r.sheets?.[0]?.name ?? sheetName;
    sheetId = r.sheets?.[0]?.sheet_id;
    return `${sheetName}/${sheetId ?? 'no-id'}`;
  });
  await step('spreadsheet', 'spreadsheet_write_cells', async () => {
    await mcp.callTool('spreadsheet_write_cells', {
      file_id: fileId,
      sheet_name: sheetName,
      start_cell: 'A1',
      values: [
        ['name', 'value'],
        ['smoke', smokeId],
      ],
      confirm: true,
    });
    return 'A1:B2';
  });
  await step('spreadsheet', 'spreadsheet_append_rows', async () => {
    await mcp.callTool('spreadsheet_append_rows', {
      file_id: fileId,
      sheet_name: sheetName,
      rows: [['append', 1]],
      confirm: true,
    });
    return '1 row';
  });
  await step('spreadsheet', 'spreadsheet_write_styles', async () => {
    await mcp.callTool('spreadsheet_write_styles', {
      file_id: fileId,
      sheet_name: sheetName,
      start_row: 0,
      start_col: 0,
      styles: [[{ textFormat: { bold: true }, bg: 'ffff00' }]],
    });
    return 'A1';
  });
  await step('spreadsheet', 'spreadsheet_get_styles', async () => {
    const r = await mcp.callTool('spreadsheet_get_styles', {
      file_id: fileId,
      sheet_name: sheetName,
      range: 'A1:B2',
    });
    return `${r.styles?.length ?? 0} row(s)`;
  });
  await step('spreadsheet', 'spreadsheet_export', async () => {
    const r = await mcp.callTool('spreadsheet_export', { file_id: fileId, format: 'xlsx' });
    return `${r.file_name ?? 'xlsx'} ${r.size ?? 0} byte(s)`;
  });
  if (sheetId) {
    await step('spreadsheet', 'spreadsheet_batch_update', async () => {
      await mcp.callTool('spreadsheet_batch_update', {
        file_id: fileId,
        sheet_id: sheetId,
        action: 'insert_rows',
        index: 1,
        count: 1,
        confirm: true,
      });
      return 'insert row';
    });
  }
  await step('spreadsheet', 'spreadsheet_add_sheet', async () => {
    const r = await mcp.callTool('spreadsheet_add_sheet', {
      file_id: fileId,
      sheet_name: 'SmokeTab',
    });
    addedSheetId = r.sheet_id;
    return addedSheetId ?? 'created';
  });
  if (addedSheetId) {
    await step('spreadsheet', 'spreadsheet_rename_sheet', async () => {
      await mcp.callTool('spreadsheet_rename_sheet', {
        file_id: fileId,
        sheet_id: addedSheetId,
        new_name: 'SmokeRenamed',
        confirm: true,
      });
      return 'SmokeRenamed';
    });
    await step('spreadsheet', 'spreadsheet_delete_sheet', async () => {
      await mcp.callTool('spreadsheet_delete_sheet', {
        file_id: fileId,
        sheet_id: addedSheetId,
        confirm: true,
      });
      return addedSheetId;
    });
  }
}

function usesMainDsmOtpAccountForSpreadsheet() {
  const hasMainOtp = Boolean(env.SYNO_OTP_CODE || env.SYNO_OTP_SECRET);
  const hasSpreadsheetCreds = Boolean(env.SYNO_SS_USERNAME && env.SYNO_SS_PASSWORD);
  return hasMainOtp && !hasSpreadsheetCreds;
}

function usesDifferentSpreadsheetAccount() {
  return Boolean(
    env.SYNO_SS_USERNAME &&
    env.SYNO_SS_PASSWORD &&
    env.SYNO_USERNAME &&
    env.SYNO_SS_USERNAME !== env.SYNO_USERNAME,
  );
}

async function calendarWriteSmoke(mcp, state) {
  const calendarId = state.calendars?.[0]?.id;
  if (!calendarId) {
    skip('calendar', 'calendar_create_event', 'no calendar available');
    return;
  }
  const start = new Date(Date.now() + 2 * 3600_000).toISOString();
  const end = new Date(Date.now() + 3 * 3600_000).toISOString();
  let eventId;
  if (
    !(await requiredStep('calendar', 'calendar_create_event', async () => {
      const r = await mcp.callTool('calendar_create_event', {
        calendar_id: calendarId,
        title: smokeId,
        start,
        end,
        all_day: false,
        description: 'temporary smoke event',
        confirm: true,
      });
      eventId = r.event_id;
      cleanups.push(async () => {
        if (eventId) {
          await mcp.callTool('calendar_delete_event', {
            event_id: eventId,
            calendar_id: calendarId,
            confirm: true,
          });
        }
      });
      return eventId;
    }))
  )
    return;
  await step('calendar', 'calendar_get_event', async () => {
    const r = await mcp.callTool('calendar_get_event', {
      event_id: eventId,
      calendar_id: calendarId,
    });
    return r.title ?? eventId;
  });
  await step('calendar', 'calendar_update_event', async () => {
    await mcp.callTool('calendar_update_event', {
      event_id: eventId,
      calendar_id: calendarId,
      title: `${smokeId}-updated`,
      confirm: true,
    });
    return 'updated';
  });
}

async function mailplusWriteSmoke(mcp) {
  const recipient = await resolveMailplusSmokeRecipient();
  if (!recipient) {
    skip(
      'mailplus',
      'mailplus_send_message',
      'set SMOKE_MAILPLUS_RECIPIENT, use an email SYNO_USERNAME, or configure a default MailPlus SMTP sender',
    );
    return;
  }
  const subject = `${smokeId} mailplus`;
  let sentMessageId;
  await step('mailplus', 'mailplus_send_message', async () => {
    const r = await mcp.callTool('mailplus_send_message', {
      to: [recipient],
      subject,
      body: `temporary smoke message ${smokeId}`,
      body_format: 'text',
      confirm: true,
    });
    sentMessageId = r.message_id;
    return r.message_id ?? 'sent';
  });

  let message;
  for (let i = 0; i < 6; i += 1) {
    const r = await mcp.callTool('mailplus_list_messages', {
      folder_path: 'INBOX',
      limit: 10,
      search: subject,
    });
    message = (r.messages ?? []).find((m) => m.subject === subject) ?? r.messages?.[0];
    if (message?.id) break;
    await delay(5000);
  }
  if (!message?.id && sentMessageId) {
    message = { id: sentMessageId };
  }
  if (!message?.id) {
    skip('mailplus', 'mailplus_mark_messages', 'sent message id unavailable');
    return;
  }

  for (const action of ['read', 'unread', 'flag', 'unflag']) {
    await step('mailplus', `mailplus_mark_messages:${action}`, async () => {
      await mcp.callTool('mailplus_mark_messages', { message_ids: [message.id], action });
      return message.id;
    });
  }
  await step('mailplus', 'mailplus_move_messages', async () => {
    await mcp.callTool('mailplus_move_messages', {
      message_ids: [message.id],
      dest_folder: 'Trash',
      confirm: true,
    });
    return 'Trash';
  });
}

async function resolveMailplusSmokeRecipient() {
  if (env.SMOKE_MAILPLUS_RECIPIENT) return env.SMOKE_MAILPLUS_RECIPIENT;
  if (String(env.SYNO_USERNAME).includes('@')) return env.SYNO_USERNAME;
  if (env.SMOKE_MAILPLUS_AUTODISCOVER_RECIPIENT === 'false') return '';
  if (env.SYNO_OTP_CODE) return '';

  try {
    return await discoverDefaultMailplusSender();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    skip('mailplus', 'mailplus_recipient_autodiscover', detail);
    return '';
  }
}

async function discoverDefaultMailplusSender() {
  return await withDirectDsmSession(async ({ proto, dispatcher, sid }) => {
    const params = new URLSearchParams({
      api: 'SYNO.MailClient.Setting.SMTP',
      version: '2',
      method: 'list',
    });
    const smtp = await undiciFetch(
      `${proto}://${env.SYNO_HOST}:${env.SYNO_PORT}/webapi/entry.cgi?${params.toString()}`,
      {
        headers: { Cookie: `id=${sid}` },
        dispatcher,
      },
    );
    const smtpJson = await smtp.json();
    if (!smtpJson.success) {
      throw new Error(`MailPlus SMTP list failed with code ${smtpJson.error?.code ?? 'unknown'}`);
    }

    const accounts = smtpJson.data?.smtp ?? [];
    const defaultId = String(smtpJson.data?.smtp_default_id ?? '');
    const selected =
      accounts.find((item) => defaultId.length > 0 && String(item.id ?? '') === defaultId) ??
      accounts[0];
    const address = selected?.mail ?? selected?.email ?? selected?.address;
    if (!address) throw new Error('MailPlus has no default SMTP sender address');
    return String(address);
  });
}

async function runCleanups() {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ product: 'cleanup', tool: 'cleanup', status: 'fail', detail });
      console.log(`FAIL cleanup.cleanup - ${detail}`);
    }
  }
}

function maxDownloadBytes() {
  return Number(env.SMOKE_MAX_DOWNLOAD_BYTES ?? 1_000_000);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withDirectDsmSession(fn) {
  await waitForFreshTotpWindowAfter(lastDirectDsmLoginCounter ?? initialTotpCounter);

  const proto = env.SYNO_HTTPS === 'true' ? 'https' : 'http';
  const dispatcher =
    env.SYNO_IGNORE_CERT === 'true'
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  let sid;

  try {
    const authBody = new URLSearchParams({
      api: 'SYNO.API.Auth',
      version: '6',
      method: 'login',
      account: env.SYNO_USERNAME,
      passwd: env.SYNO_PASSWORD,
      format: 'sid',
    });
    const otpCode = resolveCurrentOtpCode();
    if (otpCode) authBody.set('otp_code', otpCode);

    const login = await undiciFetch(
      `${proto}://${env.SYNO_HOST}:${env.SYNO_PORT}/webapi/auth.cgi`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: authBody,
        dispatcher,
      },
    );
    const loginJson = await login.json();
    if (!loginJson.success || !loginJson.data?.sid) {
      throw new Error(`DSM login failed with code ${loginJson.error?.code ?? 'unknown'}`);
    }
    sid = loginJson.data.sid;
    if (env.SYNO_OTP_SECRET && !env.SYNO_OTP_CODE) {
      lastDirectDsmLoginCounter = currentTotpCounter();
    }

    return await fn({ proto, dispatcher, sid });
  } finally {
    if (sid) {
      await logoutSid(proto, sid, dispatcher).catch(() => undefined);
    }
    await dispatcher?.close();
  }
}

async function waitForFreshTotpWindowIfNeeded() {
  if (!env.SYNO_OTP_SECRET || env.SYNO_OTP_CODE) return;

  const elapsed = Math.floor(Date.now() / 1000) % 30;
  const targetSecond = 12;
  const waitSeconds = elapsed < targetSecond ? targetSecond - elapsed : 30 - elapsed + targetSecond;
  const waitMs = waitSeconds * 1000;
  console.log(`Waiting ${waitSeconds}s for a stable DSM TOTP window`);
  await delay(waitMs);
  initialTotpCounter = currentTotpCounter();
}

async function waitForFreshTotpWindowAfter(previousCounter) {
  if (!env.SYNO_OTP_SECRET || env.SYNO_OTP_CODE || previousCounter === undefined) return;

  while (currentTotpCounter() <= previousCounter || Math.floor(Date.now() / 1000) % 30 < 12) {
    const currentCounter = currentTotpCounter();
    const elapsed = Math.floor(Date.now() / 1000) % 30;
    const waitMs =
      currentCounter <= previousCounter
        ? previousCounter * 30_000 + 42_000 - Date.now()
        : (12 - elapsed) * 1000;
    const boundedWaitMs = Math.max(1000, waitMs);
    console.log(`Waiting ${Math.ceil(boundedWaitMs / 1000)}s for a fresh DSM TOTP window`);
    await delay(boundedWaitMs);
  }
}

function currentTotpCounter() {
  return Math.floor(Date.now() / 30_000);
}

function resolveCurrentOtpCode() {
  if (env.SYNO_OTP_CODE) return env.SYNO_OTP_CODE;
  if (!env.SYNO_OTP_SECRET) return '';
  return generateTotpCode(env.SYNO_OTP_SECRET);
}

function generateTotpCode(secret) {
  const key = decodeBase32(secret);
  const counter = currentTotpCounter();
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(msg).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(value % 1_000_000).padStart(6, '0');
}

function decodeBase32(input) {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('invalid base32 secret');
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

async function logoutSid(proto, sid, dispatcher) {
  const body = new URLSearchParams({
    api: 'SYNO.API.Auth',
    version: '6',
    method: 'logout',
    _sid: sid,
  });
  await undiciFetch(`${proto}://${env.SYNO_HOST}:${env.SYNO_PORT}/webapi/auth.cgi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    dispatcher,
  });
}

function printSummary() {
  const counts = results.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('');
  console.log(
    `Summary: ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${counts.skipped ?? 0} skipped`,
  );
  const failures = results.filter((item) => item.status === 'fail');
  if (failures.length > 0) {
    console.log('');
    for (const failure of failures) {
      console.log(`- ${failure.product}.${failure.tool}: ${failure.detail}`);
    }
  }
}

let mcp;
try {
  console.log(`Running ${mode} smoke with id ${smokeId}`);
  await waitForFreshTotpWindowIfNeeded();
  mcp = new McpStdioClient();
  await mcp.initialize();
  const state = {};
  await readonlySmoke(mcp, state);
  if (mode === 'write') {
    await writeSmoke(mcp, state);
  }
  await runCleanups();
  printSummary();
  if (results.some((item) => item.status === 'fail')) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
} finally {
  mcp?.close();
}
