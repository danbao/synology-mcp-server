/**
 * MSW request handlers simulating Synology DSM API responses.
 * All SYNO.* endpoints are handled in a single consolidated GET + POST
 * handler to avoid MSW "first match wins" ordering conflicts across
 * handler arrays. Import `driveHandlers` or `allHandlers` in tests.
 */

import { http, HttpResponse } from 'msw';

const ENTRY_CGI = 'http://nas.local:5000/webapi/entry.cgi';
const DOWNLOAD_INFO_CGI = 'http://nas.local:5000/webapi/DownloadStation/info.cgi';
const DOWNLOAD_TASK_CGI = 'http://nas.local:5000/webapi/DownloadStation/task.cgi';

/** Minimal Synology success envelope */
function ok<T>(data: T) {
  return HttpResponse.json({ success: true, data });
}

/** Synology error envelope */
function synoError(code: number) {
  return HttpResponse.json({ success: false, error: { code } });
}

export interface MailplusRecordedRequest {
  api: string | null;
  version: string | null;
  method: string | null;
  source: 'query' | 'form' | 'multipart';
  params: Record<string, string>;
}

export const mailplusRequestLog: MailplusRecordedRequest[] = [];

export function clearMailplusRequestLog(): void {
  mailplusRequestLog.length = 0;
}

export interface DsmRecordedRequest {
  api: string | null;
  version: string | null;
  method: string | null;
  httpMethod: 'GET' | 'POST';
  source: 'query' | 'form' | 'multipart';
  params: Record<string, string>;
}

export interface SpreadsheetRecordedRequest {
  httpMethod: string;
  path: string;
  body?: unknown;
}

export const dsmRequestLog: DsmRecordedRequest[] = [];
export const spreadsheetRequestLog: SpreadsheetRecordedRequest[] = [];
const deletedDrivePaths = new Set<string>();

export function clearDsmRequestLog(): void {
  dsmRequestLog.length = 0;
  deletedDrivePaths.clear();
}

export function clearSpreadsheetRequestLog(): void {
  spreadsheetRequestLog.length = 0;
}

interface RequestParams {
  source: 'query' | 'form' | 'multipart';
  get(name: string): string | null;
  hasBodyParam(name: string): boolean;
  toRecord(): Record<string, string>;
}

async function readPostParams(request: Request): Promise<RequestParams> {
  const url = new URL(request.url);
  const query = url.searchParams;
  const contentType = request.headers.get('content-type') ?? '';
  const body = new URLSearchParams();
  let source: 'query' | 'form' | 'multipart' = 'query';

  if (contentType.includes('application/x-www-form-urlencoded')) {
    source = 'form';
    const text = await request.text();
    const parsed = new URLSearchParams(text);
    for (const [key, value] of parsed.entries()) body.append(key, value);
  } else if (contentType.includes('multipart/form-data')) {
    source = 'multipart';
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      body.append(key, typeof value === 'string' ? value : value.name);
    }
  }

  return {
    source,
    get(name: string): string | null {
      return body.get(name) ?? query.get(name);
    },
    hasBodyParam(name: string): boolean {
      return body.has(name);
    },
    toRecord(): Record<string, string> {
      const record: Record<string, string> = {};
      for (const [key, value] of query.entries()) record[key] = value;
      for (const [key, value] of body.entries()) record[key] = value;
      return record;
    },
  };
}

function recordMailplusRequest(
  params: RequestParams,
  api: string | null,
  method: string | null,
): void {
  if (api?.startsWith('SYNO.MailClient.') !== true) return;
  mailplusRequestLog.push({
    api,
    version: params.get('version'),
    method,
    source: params.source,
    params: params.toRecord(),
  });
}

function recordDsmPost(params: RequestParams, api: string | null, method: string | null): void {
  dsmRequestLog.push({
    api,
    version: params.get('version'),
    method,
    httpMethod: 'POST',
    source: params.source,
    params: params.toRecord(),
  });
}

function recordMailplusGet(url: URL, api: string | null, method: string | null): void {
  if (api?.startsWith('SYNO.MailClient.') !== true) return;
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;
  mailplusRequestLog.push({
    api,
    version: url.searchParams.get('version'),
    method,
    source: 'query',
    params,
  });
}

function recordDsmGet(url: URL, api: string | null, method: string | null): void {
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;
  dsmRequestLog.push({
    api,
    version: url.searchParams.get('version'),
    method,
    httpMethod: 'GET',
    source: 'query',
    params,
  });
}

function recordSpreadsheetRequest(request: Request, body?: unknown): void {
  const url = new URL(request.url);
  spreadsheetRequestLog.push({
    httpMethod: request.method,
    path: `${url.pathname}${url.search}`,
    ...(body !== undefined ? { body } : {}),
  });
}

function parseJsonParam<T>(params: RequestParams, name: string, fallback: T): T {
  const value = params.get(name);
  if (value === null) return fallback;
  return JSON.parse(value) as T;
}

// ---------------------------------------------------------------------------
// MailPlus availability toggle (set false to simulate missing package)
// ---------------------------------------------------------------------------

/** Set to false in tests to simulate MailPlus Server not installed. */
export let mailplusAvailable = true;
export let downloadStationAvailable = true;

/** Toggle MailPlus availability for a test. Restore via afterEach. */
export function setMailplusAvailable(value: boolean): void {
  mailplusAvailable = value;
}

/** Toggle Download Station availability for a test. Restore via afterEach. */
export function setDownloadStationAvailable(value: boolean): void {
  downloadStationAvailable = value;
}

// ---------------------------------------------------------------------------
// Fixture data — must be declared before handler functions that reference them
// ---------------------------------------------------------------------------

const FILE_FIXTURE = {
  file_id: 'file-001',
  name: 'report.osheet',
  path: '/report.osheet',
  display_path: '/mydrive/report.osheet',
  dsm_path: '/volume1/homes/admin/Drive/report.osheet',
  type: 'file' as const,
  content_type: 'application/vnd.synology.spreadsheet',
  size: 2048,
  access_time: 1700000000,
  modified_time: 1700000000,
  created_time: 1699000000,
  owner: { name: 'admin', uid: 1024 },
  shared: false,
  capabilities: {
    can_read: true,
    can_write: true,
    can_delete: true,
    can_organize: true,
  },
  labels: [{ label_id: 'label-1', name: 'Important' }],
};

const FOLDER_FIXTURE = {
  file_id: 'dir-001',
  name: 'projects',
  path: '/projects',
  display_path: '/mydrive/projects',
  type: 'dir' as const,
  content_type: 'dir',
  size: 0,
  access_time: 1700000000,
  modified_time: 1700000000,
  created_time: 1699000000,
  owner: { name: 'admin', uid: 1024 },
  shared: false,
  capabilities: {
    can_read: true,
    can_write: true,
    can_delete: true,
    can_organize: true,
  },
};

const DEST_FOLDER_FIXTURE = {
  ...FOLDER_FIXTURE,
  file_id: 'dir-dest',
  name: 'dest',
  path: '/dest',
  display_path: '/mydrive/dest',
};

const LABEL_FIXTURE = { id: 'label-1', name: 'Important', color: 'red' as const };

const SHEET_INFO_FIXTURE = {
  file_id: 'sheet-001',
  name: 'Budget.osheet',
  sheets: [
    { sheet_id: 's1', name: 'Sheet1', row_count: 10, col_count: 4, hidden: false },
    { sheet_id: 's2', name: 'Summary', row_count: 5, col_count: 2, hidden: false },
  ],
};

const CELL_DATA_FIXTURE = {
  sheet_name: 'Sheet1',
  range: 'A1:D3',
  values: [
    ['Name', 'Age', 'City', 'Score'],
    ['Alice', 30, 'NYC', 95],
    ['Bob', 25, 'LA', 87],
  ],
};

const MAIL_FOLDER_FIXTURE = [
  { id: 'folder-inbox', name: 'INBOX', path: 'INBOX', unread: 3, total: 10, has_children: false },
  { id: 'folder-sent', name: 'Sent', path: 'Sent', unread: 0, total: 5, has_children: false },
];

const MAILBOX_V7_FIXTURE = [
  { id: -1, name: 'INBOX', path: 'INBOX' },
  { id: -4, name: 'Sent', path: 'Sent' },
  { id: 42, name: 'Projects', path: 'Projects' },
];

const MAIL_THREAD_FIXTURE = {
  id: 9001,
  star: 0,
  unread: 0,
  last_modified: 1700000000,
  draft: [],
  message: [
    {
      id: 1001,
      subject: 'Hello World',
      from: 'Alice <alice@example.com>',
      recipients: ['Bob <bob@example.com>'],
      arrival_time: 1700000000,
      last_modified: 1700000000,
      mailbox_id: -1,
      read: true,
      star: 0,
      attachment: [],
      body_preview: 'This is a preview of the message body.',
      type: 1,
    },
  ],
};

const MAIL_DETAIL_FIXTURE = {
  id: 'msg-001',
  subject: 'Hello World',
  from: 'Alice <alice@example.com>',
  to: ['Bob <bob@example.com>'],
  cc: [],
  bcc: [],
  arrival_time: 1700000000,
  body: {
    plain: 'Hello, this is the message body.',
    html: '<p>Hello, this is the message body.</p>',
  },
  attachment: [
    {
      id: 'att-001',
      name: 'file.txt',
      mime_type: 'text/plain',
      size: 100,
      md5: 'mock-md5-001',
    },
  ],
};

// ---------------------------------------------------------------------------
// Calendar fixture data
// ---------------------------------------------------------------------------

const CALENDAR_FIXTURE = {
  cal_id: 'cal-001',
  original_cal_id: 'cal-001',
  name: 'Personal',
  cal_displayname: 'Personal',
  color: '#4A90E2',
  cal_color: '#4A90E2',
  is_owner: true,
  is_shared: false,
  description: 'My personal calendar',
  cal_description: 'My personal calendar',
};

const EVENT_FIXTURE = {
  evt_id: 'evt-001',
  cal_id: 'cal-001',
  original_cal_id: 'cal-001',
  cal_name: 'Personal',
  title: 'Team Meeting',
  summary: 'Team Meeting',
  desc: 'Weekly sync',
  description: 'Weekly sync',
  location: 'Conference Room A',
  location_info: {
    name: 'Conference Room A',
    address: '',
    placeId: '',
    mapType: '',
    gps: { lat: -1, lng: -1 },
  },
  dtstart: 1700000000,
  dtend: 1700003600,
  is_all_day: false,
  rrule: undefined as string | undefined,
  attendee: [{ email: 'alice@example.com', name: 'Alice', status: 'accepted' }],
  participant: [],
  notify_setting: [],
  dav_etag: 'mock-etag-001',
  color: '',
  tz_id: 'Asia/Shanghai',
  is_repeat_evt: false,
  attachments: [],
};

// ---------------------------------------------------------------------------
// Download Station fixture data
// ---------------------------------------------------------------------------

const DOWNLOAD_TASK_FIXTURE = {
  id: 'dbid_001',
  type: 'http',
  username: 'admin',
  title: 'ubuntu.iso',
  size: 1024,
  status: 'downloading',
  status_extra: {
    error_detail: '',
  },
  additional: {
    detail: {
      destination: 'downloads',
      uri: 'https://example.com/ubuntu.iso',
      create_time: 1700000000,
      started_time: 1700000100,
      total_peers: 0,
      connected_seeders: 0,
      connected_leechers: 0,
    },
    transfer: {
      size_downloaded: 256,
      size_uploaded: 0,
      speed_download: 1024,
      speed_upload: 0,
    },
    file: [
      {
        filename: 'ubuntu.iso',
        size: 1024,
        size_downloaded: 256,
        priority: 'normal',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Consolidated request handlers
// ---------------------------------------------------------------------------

/**
 * Handles all GET requests to entry.cgi, routing by api + method query params.
 * Consolidated to avoid MSW "first match wins" issues when multiple handler
 * arrays are registered.
 */
function handleGet(request: Request): Response {
  const url = new URL(request.url);
  const api = url.searchParams.get('api');
  const method = url.searchParams.get('method');
  recordDsmGet(url, api, method);
  recordMailplusGet(url, api, method);

  // --- SYNO.SynologyDrive.Files ---
  if (api === 'SYNO.SynologyDrive.Files') {
    if (method === 'list') {
      return ok({ total: 2, items: [FILE_FIXTURE, FOLDER_FIXTURE] });
    }
    if (method === 'get') {
      const path = url.searchParams.get('path');
      if (path === '/mydrive/notfound') return synoError(408);
      if (path !== null && deletedDrivePaths.has(path)) return synoError(1003);
      if (path === '/mydrive/dest') return ok(DEST_FOLDER_FIXTURE);
      if (path === '/mydrive') {
        return ok({
          ...FOLDER_FIXTURE,
          file_id: 'dir-root',
          name: 'mydrive',
          path: '/',
          display_path: '/mydrive',
        });
      }
      return ok({ ...FILE_FIXTURE, labels: [{ label_id: 'label-1', name: 'Important' }] });
    }
    if (method === 'search') {
      return ok({ total: 1, items: [FILE_FIXTURE] });
    }
    if (method === 'download') {
      const path = url.searchParams.get('path');
      if (path === '/mydrive/notfound') {
        return HttpResponse.json({ success: false, error: { code: 408 } });
      }
      const buf = Buffer.from('hello');
      return new HttpResponse(buf, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="report.osheet"',
        },
      });
    }
  }

  // --- SYNO.SynologyDrive.Labels ---
  if (api === 'SYNO.SynologyDrive.Labels') {
    if (method === 'list') {
      return ok({ items: [LABEL_FIXTURE], total: 1 });
    }
  }

  // --- SYNO.Office.Sheet.Snapshot ---
  if (api === 'SYNO.Office.Sheet.Snapshot') {
    if (method === 'get_info') {
      const file_id = url.searchParams.get('file_id');
      if (file_id === 'not-found') return synoError(408);
      return ok(SHEET_INFO_FIXTURE);
    }
    if (method === 'get_cells') {
      const file_id = url.searchParams.get('file_id');
      if (file_id === 'not-found') return synoError(408);
      return ok(CELL_DATA_FIXTURE);
    }
  }

  // --- SYNO.Office.Export ---
  if (api === 'SYNO.Office.Export' && method === 'export') {
    const file_id = url.searchParams.get('file_id');
    // HTTP 404 so exportFile sees response.ok=false and throws
    if (file_id === 'not-found') return new HttpResponse(null, { status: 404 });
    const buf = Buffer.from('PK mock xlsx content');
    return new HttpResponse(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="Budget.xlsx"',
      },
    });
  }

  // --- SYNO.API.Info (module availability probes) ---
  if (api === 'SYNO.API.Info' && method === 'query') {
    const allApis: Record<string, { path: string; minVersion: number; maxVersion: number }> = {
      'SYNO.SynologyDrive.Files': { path: 'entry.cgi', minVersion: 1, maxVersion: 10 },
      'SYNO.SynologyDrive.Labels': { path: 'entry.cgi', minVersion: 1, maxVersion: 3 },
      'SYNO.Cal.Cal': { path: 'entry.cgi', minVersion: 1, maxVersion: 5 },
      'SYNO.Cal.Event': { path: 'entry.cgi', minVersion: 1, maxVersion: 6 },
    };
    if (mailplusAvailable) {
      Object.assign(allApis, {
      'SYNO.MailClient.Mailbox': { path: 'entry.cgi', minVersion: 1, maxVersion: 1 },
      'SYNO.MailClient.Message': { path: 'entry.cgi', minVersion: 1, maxVersion: 10 },
      'SYNO.MailClient.Thread': { path: 'entry.cgi', minVersion: 1, maxVersion: 10 },
      'SYNO.MailClient.Draft': { path: 'entry.cgi', minVersion: 1, maxVersion: 6 },
      'SYNO.MailClient.Attachment': { path: 'entry.cgi', minVersion: 1, maxVersion: 8 },
      });
    }
    if (downloadStationAvailable) {
      Object.assign(allApis, {
        'SYNO.DownloadStation.Info': {
          path: 'DownloadStation/info.cgi',
          minVersion: 1,
          maxVersion: 1,
        },
        'SYNO.DownloadStation.Task': {
          path: 'DownloadStation/task.cgi',
          minVersion: 1,
          maxVersion: 1,
        },
      });
    }

    const query = url.searchParams.get('query');
    if (query === null || query === 'all') return ok(allApis);
    const requested = query.split(',').map((item) => item.trim());
    const filtered: typeof allApis = {};
    for (const name of requested) {
      if (Object.hasOwn(allApis, name)) filtered[name] = allApis[name]!;
    }
    return ok(filtered);
  }

  // --- SYNO.DownloadStation.Info ---
  if (api === 'SYNO.DownloadStation.Info' && method === 'getinfo') {
    if (!downloadStationAvailable) return synoError(102);
    return ok({ version: 1, version_string: '3.9.7', is_manager: true });
  }

  // --- SYNO.DownloadStation.Task ---
  if (api === 'SYNO.DownloadStation.Task') {
    if (!downloadStationAvailable) return synoError(102);
    if (method === 'list') {
      return ok({ tasks: [DOWNLOAD_TASK_FIXTURE], total: 1, offset: 0 });
    }
    if (method === 'getinfo') {
      const ids = (url.searchParams.get('id') ?? '').split(',').filter(Boolean);
      if (ids.includes('not-found')) return synoError(102);
      return ok({ tasks: [DOWNLOAD_TASK_FIXTURE], total: 1, offset: 0 });
    }
  }

  // --- SYNO.MailClient.Mailbox ---
  if (api === 'SYNO.MailClient.Mailbox' && method === 'list') {
    if (url.searchParams.get('version') === '7') {
      return ok({ mailbox: MAILBOX_V7_FIXTURE, total: MAILBOX_V7_FIXTURE.length });
    }
    return ok(MAIL_FOLDER_FIXTURE);
  }

  // --- SYNO.MailClient.Thread ---
  if (api === 'SYNO.MailClient.Thread' && method === 'list') {
    const condition = JSON.parse(url.searchParams.get('condition') ?? '[]') as Array<{
      name?: string;
      value?: string;
    }>;
    const mailboxId = condition.find((item) => item.name === 'mailbox')?.value;
    if (mailboxId !== '-1' && mailboxId !== '42') return synoError(120);
    return ok({
      keyword: '',
      matched_ids: [],
      split_keyword: '',
      thread: [MAIL_THREAD_FIXTURE],
      total: 1,
    });
  }

  // --- SYNO.MailClient.Message ---
  if (api === 'SYNO.MailClient.Message') {
    if (method === 'list') {
      return synoError(103);
    }
    if (method === 'get') {
      const ids = JSON.parse(url.searchParams.get('id') ?? '[]') as string[];
      if (ids.length === 0) return synoError(120);
      if (ids.includes('not-found')) return synoError(408);
      return ok({ message: [MAIL_DETAIL_FIXTURE] });
    }
  }

  // --- SYNO.MailClient.Attachment ---
  if (api === 'SYNO.MailClient.Attachment' && method === 'get') {
    return synoError(103);
  }
  if (
    api === 'SYNO.MailClient.Attachment' &&
    method === 'download' &&
    url.searchParams.get('version') === '8'
  ) {
    if (url.searchParams.get('md5') !== 'mock-md5-001') return synoError(120);
    const buf = Buffer.from('attachment content');
    return new HttpResponse(buf, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  // --- SYNO.MailClient.Setting.SMTP ---
  if (api === 'SYNO.MailClient.Setting.SMTP' && method === 'list') {
    return ok({
      smtp_default_id: 1,
      smtp: [{ id: 1, mail: 'sender@example.com', display_name: 'Sender' }],
    });
  }

  // --- SYNO.Cal.Cal ---
  if (api === 'SYNO.Cal.Cal' && method === 'list') {
    return ok([CALENDAR_FIXTURE]);
  }

  // --- SYNO.Cal.Event ---
  if (api === 'SYNO.Cal.Event') {
    if (method === 'list') {
      if (url.searchParams.get('version') !== '6') return synoError(104);
      return ok({ list: [EVENT_FIXTURE] });
    }
    if (method === 'get') {
      return synoError(103);
    }
  }

  // --- SYNO.Cal.Setting ---
  if (api === 'SYNO.Cal.Setting' && method === 'get') {
    return ok({ time_zone: 'Asia/Shanghai' });
  }

  return synoError(103); // unknown api/method fallback
}

/**
 * Handles all POST requests to entry.cgi, routing by api + method params.
 */
async function handlePost(request: Request): Promise<Response> {
  const params = await readPostParams(request);
  const api = params.get('api');
  const method = params.get('method');
  recordDsmPost(params, api, method);
  recordMailplusRequest(params, api, method);

  // --- SYNO.SynologyDrive.Files ---
  if (api === 'SYNO.SynologyDrive.Files') {
    if (method === 'upload') {
      if (
        params.source !== 'multipart' ||
        params.get('path')?.startsWith('/mydrive/uploads/') !== true ||
        params.get('type') !== 'file'
      ) {
        return synoError(101);
      }
      return ok({
        file_id: 'new-file-001',
        path: '/uploads/test.txt',
        display_path: '/mydrive/uploads/test.txt',
        name: 'test.txt',
      });
    }
    if (method === 'create_folder') {
      return synoError(103);
    }
    if (method === 'create') {
      if (
        params.source !== 'form' ||
        params.get('path') !== '/mydrive/projects/new-folder' ||
        params.get('type') !== 'folder'
      ) {
        return synoError(101);
      }
      return ok({
        file_id: 'dir-new',
        path: '/projects/new-folder',
        display_path: '/mydrive/projects/new-folder',
        name: 'new-folder',
      });
    }
    if (method === 'move') {
      if (
        params.source !== 'form' ||
        params.get('files') !== '["id:file-001"]' ||
        params.get('to_parent_folder') !== 'id:dir-dest'
      ) {
        return synoError(101);
      }
      return ok({ async_task_id: 'task-move-001' });
    }
    if (method === 'update') {
      if (
        params.source !== 'form' ||
        params.get('path') !== 'id:file-001' ||
        params.get('name') !== 'renamed.osheet'
      ) {
        return synoError(101);
      }
      return ok({ file_id: 'file-001', display_path: '/mydrive/dest/renamed.osheet' });
    }
    if (method === 'delete') {
      if (
        params.source !== 'form' ||
        params.get('files') !== '["id:file-001"]' ||
        (params.get('permanent') !== 'false' && params.get('permanent') !== 'true')
      ) {
        return synoError(101);
      }
      if (params.get('version') !== '10') return synoError(104);
      if (params.get('permanent') === 'true') {
        return ok({ async_task_id: 'task-delete-failed' });
      }
      deletedDrivePaths.add('/mydrive/report.osheet');
      return ok({ async_task_id: 'task-delete-001' });
    }
    if (method === 'add_label') return synoError(103);
    if (method === 'label') {
      if (
        params.source !== 'form' ||
        params.get('files') !== '["id:file-001"]' ||
        params.get('labels') !== '[{"action":"add","label_id":"label-1"}]'
      ) {
        return synoError(101);
      }
      return HttpResponse.json({ success: true });
    }
  }

  // --- SYNO.Entry.Request compound task status ---
  if (api === 'SYNO.Entry.Request' && method === 'request') {
    const compound = JSON.parse(params.get('compound') ?? '[]') as Array<{
      api?: string;
      method?: string;
      task_id?: string;
      version?: number;
    }>;
    const task = compound[0];
    if (task?.api !== 'SYNO.SynologyDrive.Tasks' || task.method !== 'get') {
      return synoError(101);
    }

    if (task.task_id === 'task-delete-failed') {
      return ok({
        has_fail: false,
        result: [
          {
            api: 'SYNO.SynologyDrive.Tasks',
            method: 'get',
            version: 1,
            success: true,
            data: {
              task_id: 'task-delete-failed',
              status: 'finished',
              progress: 100,
              result: {
                action: 'delete',
                errors: [{ code: 1004, message: 'can not delete existing file permanently' }],
              },
            },
          },
        ],
      });
    }

    return ok({
      has_fail: false,
      result: [
        {
          api: 'SYNO.SynologyDrive.Tasks',
          method: 'get',
          version: 1,
          success: true,
          data: {
            task_id: task?.task_id ?? 'task-delete-001',
            status: 'finished',
            progress: 100,
            result: { action: 'delete', errors: null },
          },
        },
      ],
    });
  }

  // --- SYNO.DownloadStation.Task mutations ---
  if (api === 'SYNO.DownloadStation.Task') {
    if (!downloadStationAvailable) return synoError(102);
    if (method === 'create') {
      if (
        params.get('version') !== '1' ||
        params.source !== 'form' ||
        params.get('uri') !== 'https://example.com/ubuntu.iso'
      ) {
        return synoError(101);
      }
      return ok({ task_id: 'dbid_002' });
    }
    if (method === 'pause' || method === 'resume') {
      if (
        params.get('version') !== '1' ||
        params.source !== 'form' ||
        params.get('id') !== 'dbid_001'
      ) {
        return synoError(101);
      }
      return HttpResponse.json({ success: true });
    }
    if (method === 'delete') {
      if (
        params.get('version') !== '1' ||
        params.source !== 'form' ||
        params.get('id') !== 'dbid_001' ||
        params.get('force_complete') !== 'false'
      ) {
        return synoError(101);
      }
      return HttpResponse.json({ success: true });
    }
  }

  // --- SYNO.SynologyDrive.Sharing ---
  if (api === 'SYNO.SynologyDrive.Sharing') {
    if (method === 'create') return synoError(103);
    if (method === 'create_link') {
      if (
        params.get('version') !== '1' ||
        params.source !== 'form' ||
        params.get('path') !== 'id:file-001'
      ) {
        return synoError(101);
      }
      return ok({ url: 'https://nas.local/d/abc123' });
    }
  }

  // --- SYNO.Office.Sheet.Snapshot ---
  if (api === 'SYNO.Office.Sheet.Snapshot') {
    if (method === 'set_cells') {
      const file_id = params.get('file_id');
      if (file_id === 'not-found') return synoError(408);
      return ok({});
    }
    if (method === 'create') {
      return ok({ file_id: 'new-sheet-001', file_path: '/mydrive/NewSheet.osheet' });
    }
    if (method === 'add_sheet') {
      const file_id = params.get('file_id');
      if (file_id === 'not-found') return synoError(408);
      return ok({ success: true, sheet_id: 'new-sheet-tab-001' });
    }
  }

  // --- SYNO.MailClient.Message (mark / move) ---
  if (api === 'SYNO.MailClient.Message') {
    if (method === 'mark' || method === 'move') return synoError(103);
    if (method === 'set_read') {
      if (
        params.get('version') !== '10' ||
        !params.hasBodyParam('api') ||
        !params.hasBodyParam('id') ||
        (params.get('read') !== 'true' && params.get('read') !== 'false')
      ) {
        return synoError(101);
      }
      const ids = JSON.parse(params.get('id') ?? '[]') as string[];
      return ids.length > 0 ? HttpResponse.json({ success: true }) : synoError(120);
    }
    if (method === 'set_star') {
      if (
        params.get('version') !== '10' ||
        !params.hasBodyParam('api') ||
        !params.hasBodyParam('id') ||
        (params.get('star') !== '1' && params.get('star') !== '0')
      ) {
        return synoError(101);
      }
      const ids = JSON.parse(params.get('id') ?? '[]') as string[];
      return ids.length > 0 ? HttpResponse.json({ success: true }) : synoError(120);
    }
    if (method === 'set_mailbox') {
      if (
        params.get('version') !== '10' ||
        !params.hasBodyParam('api') ||
        !params.hasBodyParam('id') ||
        params.get('mailbox_id') === null
      ) {
        return synoError(101);
      }
      const ids = JSON.parse(params.get('id') ?? '[]') as string[];
      return ids.length > 0 ? HttpResponse.json({ success: true }) : synoError(120);
    }
  }

  // --- SYNO.MailClient.Attachment ---
  if (api === 'SYNO.MailClient.Attachment') {
    if (method === 'get') return synoError(103);
    if (method === 'upload') {
      if (
        params.get('version') !== '7' ||
        params.source !== 'multipart' ||
        !params.hasBodyParam('file') ||
        params.get('is_inline') !== 'false'
      ) {
        return synoError(101);
      }
      return ok({ id: 'uploaded-att-001', name: params.get('name') ?? 'attachment' });
    }
  }

  // --- SYNO.MailClient.Draft ---
  if (api === 'SYNO.MailClient.Draft') {
    if (method === 'create') {
      if (
        params.get('version') !== '6' ||
        !params.hasBodyParam('api') ||
        params.get('to') !== '["recipient@example.com"]' ||
        params.get('from') !== 'sender@example.com'
      ) {
        return synoError(101);
      }
      return ok({ id: 'draft-msg-001' });
    }
    if (method === 'send') {
      if (
        params.get('version') !== '6' ||
        !params.hasBodyParam('api') ||
        params.get('id') !== 'draft-msg-001'
      ) {
        return synoError(103);
      }
      return ok({ message_id: 'sent-msg-001', sent_at: 1700001000 });
    }
  }

  // --- SYNO.Cal.Event (mutations) ---
  if (api === 'SYNO.Cal.Event') {
    if (method === 'create') {
      if (
        params.get('version') !== '6' ||
        params.source !== 'form' ||
        !params.hasBodyParam('summary')
      ) {
        return synoError(101);
      }
      return ok({ evt_id: 'evt-new-001', cal_id: parseJsonParam(params, 'cal_id', 'cal-001') });
    }
    if (method === 'get') {
      if (params.get('version') !== '6' || params.source !== 'form') return synoError(101);
      const evtId = parseJsonParam(params, 'evt_id', '');
      if (evtId === 'not-found') return synoError(408);
      return ok(EVENT_FIXTURE);
    }
    if (method === 'edit') {
      return synoError(103);
    }
    if (method === 'set') {
      if (
        params.get('version') !== '6' ||
        params.source !== 'form' ||
        !params.hasBodyParam('summary')
      ) {
        return synoError(101);
      }
      return ok({
        evt_id: parseJsonParam(params, 'evt_id', 'evt-001'),
        cal_id: parseJsonParam(params, 'cal_id', 'cal-001'),
      });
    }
    if (method === 'delete') {
      if (
        params.get('version') !== '6' ||
        params.source !== 'form' ||
        parseJsonParam(params, 'evt_id', '') !== 'evt-001'
      ) {
        return synoError(101);
      }
      return ok({});
    }
  }

  // --- SYNO.Cal.Cal (create) ---
  if (api === 'SYNO.Cal.Cal' && method === 'create') {
    if (
      params.get('version') !== '5' ||
      params.source !== 'form' ||
      params.get('cal_displayname') !== '"Work"'
    ) {
      return synoError(101);
    }
    return ok({ cal_id: 'cal-new-001' });
  }

  return synoError(103);
}

// ---------------------------------------------------------------------------
// Spreadsheet REST handlers (OpenAPI 3.4.1 — synology/spreadsheet-api)
// ---------------------------------------------------------------------------

/** POST /spreadsheets/authorize */
const spreadsheetAuthHandler = http.post(
  'http://nas.local:3000/spreadsheets/authorize',
  async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    recordSpreadsheetRequest(request, body);
    return HttpResponse.json({ token: 'test-jwt-token-xyz' });
  },
);

/** POST /spreadsheets/authorize/token/revoke */
const spreadsheetRevokeHandler = http.post(
  'http://nas.local:3000/spreadsheets/authorize/token/revoke',
  ({ request }) => {
    recordSpreadsheetRequest(request);
    return HttpResponse.json({ success: true });
  },
);

/** GET /spreadsheets/{id} — spec: nested properties, colCount (not columnCount). */
const spreadsheetGetInfoHandler = http.get(
  'http://nas.local:3000/spreadsheets/:id',
  ({ params, request }) => {
    recordSpreadsheetRequest(request);
    const id = params.id as string;
    if (id === 'sheet-001' || id === 'file123') {
      return HttpResponse.json({
        id,
        properties: { title: 'Budget.osheet', locale: 'en_US' },
        sheets: [
          {
            properties: { title: 'Sheet1', sheetId: 's1', index: 0, hidden: false },
            rowCount: 10,
            colCount: 4,
          },
          {
            properties: { title: 'Summary', sheetId: 's2', index: 1, hidden: false },
            rowCount: 5,
            colCount: 2,
          },
        ],
      });
    }
    return HttpResponse.json({ error: 'Not found' }, { status: 404 });
  },
);

/** GET /spreadsheets/{id}/values/{range} — spec: { range, majorDimension, values }. */
const spreadsheetGetCellsHandler = http.get(
  'http://nas.local:3000/spreadsheets/:id/values/:range',
  ({ params, request }) => {
    recordSpreadsheetRequest(request);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return HttpResponse.json({
      range: 'Sheet1!A1:D3',
      majorDimension: 'ROWS',
      values: [
        ['Name', 'Age', 'City', 'Score'],
        ['Alice', 30, 'NYC', 95],
        ['Bob', 25, 'LA', 87],
      ],
    });
  },
);

/** PUT /spreadsheets/{id}/values/{range} — echoes back GetValueResponse. */
const spreadsheetSetCellsHandler = http.put(
  'http://nas.local:3000/spreadsheets/:id/values/:range',
  async ({ params, request }) => {
    const body = (await request.json()) as { values?: unknown[] };
    recordSpreadsheetRequest(request, body);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!Array.isArray(body.values)) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [
        [1, 2],
        [3, 4],
      ],
    });
  },
);

/** PUT /spreadsheets/{id}/values/{range}/append — spec: AppendResponse. */
const spreadsheetAppendRowsHandler = http.put(
  'http://nas.local:3000/spreadsheets/:id/values/:range/append',
  async ({ params, request }) => {
    const body = (await request.json()) as { values?: unknown[] };
    recordSpreadsheetRequest(request, body);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!Array.isArray(body.values)) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({
      tableRange: 'A1:D6',
      updates: { updateRange: 'A7:D8', updateRows: 2, updateColumns: 4 },
      spreadsheetId: params.id,
    });
  },
);

/** POST /spreadsheets/create — spec: returns { spreadsheetId } only. */
const spreadsheetCreateHandler = http.post(
  'http://nas.local:3000/spreadsheets/create',
  async ({ request }) => {
    const body = (await request.json()) as { name?: string };
    recordSpreadsheetRequest(request, body);
    if (!body.name) return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    return HttpResponse.json({ spreadsheetId: 'new-sheet-001' });
  },
);

/** POST /spreadsheets/{id}/sheet/add — spec: { addSheet: { properties: {...} } }. */
const spreadsheetAddSheetHandler = http.post(
  'http://nas.local:3000/spreadsheets/:id/sheet/add',
  async ({ params, request }) => {
    const body = (await request.json()) as { sheetName?: string };
    recordSpreadsheetRequest(request, body);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (!body.sheetName) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({
      addSheet: {
        properties: { sheetId: 'new-sheet-tab-001', title: 'NewTab', index: 2 },
      },
    });
  },
);

/** Spreadsheet API export (XLSX) handler */
const spreadsheetExportXlsxHandler = http.get(
  'http://nas.local:3000/spreadsheets/:id/xlsx',
  ({ params, request }) => {
    recordSpreadsheetRequest(request);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const buffer = Buffer.from('PK\x03\x04'); // Minimal ZIP header
    return HttpResponse.arrayBuffer(buffer, {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="Budget.xlsx"',
      },
    });
  },
);

/** Spreadsheet API export (CSV) handler */
const spreadsheetExportCsvHandler = http.get(
  'http://nas.local:3000/spreadsheets/:id/sheet/csv',
  ({ params, request }) => {
    recordSpreadsheetRequest(request);
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    const csv = 'Name,Age,City,Score\nAlice,30,NYC,95\nBob,25,LA,87';
    return HttpResponse.text(csv, {
      headers: {
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="data.csv"',
      },
    });
  },
);

/** GET /spreadsheets/{id}/styles/{range} — spec: { range, rows: [{ values: CellStyle[] }] }. */
const spreadsheetGetStylesHandler = http.get(
  'http://nas.local:3000/spreadsheets/:id/styles/:range',
  ({ request }) => {
    recordSpreadsheetRequest(request);
    return HttpResponse.json({
      range: 'Sheet1!A1:B2',
      rows: [
        {
          values: [
            {
              effectiveValue: 'Header',
              formattedValue: 'Header',
              userEnteredFormat: {
                textFormat: { bold: true, name: 'Arial', size: 12, color: '000000' },
                bg: 'fffffe',
                horizontalAlignment: 'center',
              },
              effectiveFormat: {
                textFormat: { bold: true, name: 'Arial', size: 12, color: '000000' },
                bg: 'fffffe',
                horizontalAlignment: 'center',
              },
            },
            {
              effectiveValue: 'Value',
              formattedValue: 'Value',
              userEnteredFormat: { textFormat: { name: 'Arial', size: 12 } },
              effectiveFormat: { textFormat: { name: 'Arial', size: 12 } },
            },
          ],
        },
        {
          values: [
            {
              effectiveValue: 1,
              formattedValue: '1',
              userEnteredFormat: { textFormat: { name: 'Arial', size: 11 } },
              effectiveFormat: { textFormat: { name: 'Arial', size: 11 } },
            },
            {
              effectiveValue: 2,
              formattedValue: '2',
              userEnteredFormat: { textFormat: { name: 'Arial', size: 11 } },
              effectiveFormat: { textFormat: { name: 'Arial', size: 11 } },
            },
          ],
        },
      ],
    });
  },
);

/** POST /spreadsheets/{id}/sheet/rename — spec: RenameSheetResponse. */
const spreadsheetRenameSheetHandler = http.post(
  'http://nas.local:3000/spreadsheets/:id/sheet/rename',
  async ({ params, request }) => {
    const body = (await request.json()) as { sheetId?: string; sheetName?: string };
    recordSpreadsheetRequest(request, body);
    if (!body.sheetId || !body.sheetName) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({
      spreadsheetId: params.id,
      sheetId: body.sheetId ?? 'sh_1',
      sheetName: body.sheetName ?? 'renamed',
    });
  },
);

/** POST /spreadsheets/{id}/sheet/delete — spec: DeleteSheetResponse. */
const spreadsheetDeleteSheetHandler = http.post(
  'http://nas.local:3000/spreadsheets/:id/sheet/delete',
  async ({ params, request }) => {
    const body = (await request.json()) as { sheetId?: string };
    recordSpreadsheetRequest(request, body);
    if (!body.sheetId) return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    return HttpResponse.json({ spreadsheetId: params.id });
  },
);

/** POST /spreadsheets/{id}/batchUpdate — spec: empty object. */
const spreadsheetBatchUpdateHandler = http.post(
  'http://nas.local:3000/spreadsheets/:id/batchUpdate',
  async ({ request }) => {
    const body = (await request.json()) as { requests?: unknown[] };
    recordSpreadsheetRequest(request, body);
    if (!Array.isArray(body.requests)) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({});
  },
);

/** PUT /spreadsheets/{id}/styles — OpenAPI 3.4.1 bulk style write. */
const spreadsheetWriteStylesHandler = http.put(
  'http://nas.local:3000/spreadsheets/:id/styles',
  async ({ params, request }) => {
    if (params.id === 'not-found') {
      return HttpResponse.json({ error: 'Endpoint not found' }, { status: 404 });
    }
    const body = (await request.json()) as {
      sheetName?: string;
      startRow?: number;
      startCol?: number;
      rows?: unknown[];
    };
    recordSpreadsheetRequest(request, body);
    if (!body.sheetName || !Array.isArray(body.rows)) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    return HttpResponse.json({});
  },
);

/** POST /spreadsheets/delete — OpenAPI 3.4.1 file-level delete. */
const spreadsheetDeleteFileHandler = http.post(
  'http://nas.local:3000/spreadsheets/delete',
  async ({ request }) => {
    const body = (await request.json()) as { spreadsheetId?: string };
    recordSpreadsheetRequest(request, body);
    if (!body.spreadsheetId) {
      return HttpResponse.json({ error: 'Invalid argument' }, { status: 400 });
    }
    if (body.spreadsheetId === 'not-found') {
      return HttpResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if (body.spreadsheetId === 'forbidden') {
      return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return HttpResponse.json({ spreadsheetId: body.spreadsheetId });
  },
);

/** All Spreadsheet REST handlers. */
const spreadsheetHandlers = [
  spreadsheetAuthHandler,
  spreadsheetRevokeHandler,
  spreadsheetGetInfoHandler,
  spreadsheetGetCellsHandler,
  spreadsheetSetCellsHandler,
  spreadsheetAppendRowsHandler,
  spreadsheetCreateHandler,
  spreadsheetAddSheetHandler,
  spreadsheetExportXlsxHandler,
  spreadsheetExportCsvHandler,
  spreadsheetGetStylesHandler,
  spreadsheetRenameSheetHandler,
  spreadsheetDeleteSheetHandler,
  spreadsheetBatchUpdateHandler,
  spreadsheetWriteStylesHandler,
  spreadsheetDeleteFileHandler,
];

// ---------------------------------------------------------------------------
// Exported handler arrays
// ---------------------------------------------------------------------------

/**
 * All Synology API handlers for entry.cgi in a single GET + POST pair.
 * Named `driveHandlers` for backward compatibility with existing test imports.
 */
export const driveHandlers = [
  http.get(ENTRY_CGI, ({ request }) => handleGet(request)),
  http.post(ENTRY_CGI, async ({ request }) => await handlePost(request)),
  http.get(DOWNLOAD_INFO_CGI, ({ request }) => handleGet(request)),
  http.get(DOWNLOAD_TASK_CGI, ({ request }) => handleGet(request)),
  http.post(DOWNLOAD_TASK_CGI, async ({ request }) => await handlePost(request)),
];

/** Auth handlers used to bootstrap test clients that need a valid sid. */
export const authHandlers = [
  http.post('http://nas.local:5000/webapi/auth.cgi', () => {
    return HttpResponse.json({ success: true, data: { sid: 'test-sid-abc' } });
  }),
];

/** All handlers combined — use in setupServer(...allHandlers) for full coverage. */
export const allHandlers = [...authHandlers, ...driveHandlers, ...spreadsheetHandlers];
