/**
 * Drive binary transfer operations: upload (multipart) and download (binary stream).
 * These bypass BaseClient.request<T>() because the wire format is not JSON.
 */

import FormData from 'form-data';
import type { Agent } from 'undici';
import { sanitizePath } from '../../utils/path-guard.js';
import { NetworkError } from '../../errors.js';
import { mapSynologyError } from '../../utils/synology-error-map.js';
import { httpFetch, type FetchResponse } from '../../utils/http-fetch.js';
import type { SynologyResponse, SynoDriveFile } from '../../types/synology-types.js';
import type { SynoDriveUploadResponse } from './raw-response-types.js';
import type { DriveUploadResult, DriveDownloadResult } from './drive-types.js';

/** Dependencies injected by DriveClient for binary HTTP calls. */
export interface TransferDeps {
  baseUrl: string;
  /** undici Agent for self-signed cert bypass; undefined when not needed */
  dispatcher: Agent | undefined;
  /** Returns the current valid session ID */
  getToken: () => Promise<string>;
}

/** Options for upload */
export interface UploadOpts {
  dest_folder_path: string;
  file_name: string;
  content_base64: string;
  mime_type: string;
  conflict_action: 'version' | 'autorename' | 'skip';
}

function joinDrivePath(parentPath: string, name: string): string {
  const parent = sanitizePath(parentPath).replace(/\/+$/, '');
  const child = name.replace(/^\/+/, '');
  return `${parent}/${child}`;
}

type DownloadAttempt =
  | { success: true; response: FetchResponse; contentType: string }
  | { success: false; status: number; code?: number };
type DownloadFailure = Extract<DownloadAttempt, { success: false }>;

/**
 * Upload a file via multipart/form-data.
 * Decodes base64 content to Buffer and attaches as the `file` field.
 * api/method are placed in the query string per spec §7.1.
 */
export async function upload(deps: TransferDeps, opts: UploadOpts): Promise<DriveUploadResult> {
  const sid = await deps.getToken();
  const buffer = Buffer.from(opts.content_base64, 'base64');
  const filePath = joinDrivePath(opts.dest_folder_path, opts.file_name);

  const form = new FormData();
  form.append('path', filePath);
  form.append('type', 'file');
  form.append('conflict_action', opts.conflict_action);
  form.append('file', buffer, { filename: opts.file_name, contentType: opts.mime_type });

  const qs = new URLSearchParams({
    api: 'SYNO.SynologyDrive.Files',
    version: '2',
    method: 'upload',
  });
  const url = `${deps.baseUrl}/webapi/entry.cgi?${qs.toString()}`;
  const init: Record<string, unknown> = {
    method: 'POST',
    headers: { ...form.getHeaders(), Cookie: `id=${sid}` },
    body: form.getBuffer(),
    signal: AbortSignal.timeout(60_000),
  };

  let response: FetchResponse;
  try {
    response = await httpFetch(url, init, deps.dispatcher);
  } catch (err) {
    throw new NetworkError(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new NetworkError(`Upload returned non-JSON response (HTTP ${response.status})`);
  }

  const envelope = json as {
    success: boolean;
    data?: SynoDriveUploadResponse;
    error?: { code: number };
  };
  if (!envelope.success) {
    throw mapSynologyError(envelope.error?.code ?? 100, 'SYNO.SynologyDrive.Files');
  }
  if (!envelope.data) {
    throw new NetworkError('Upload succeeded but response contained no data field');
  }
  return {
    success: true,
    file_id: envelope.data.file_id,
    file_path: envelope.data.display_path ?? envelope.data.path,
    file_name: envelope.data.name,
  };
}

/**
 * Download a file and return its raw buffer plus metadata.
 * Uses direct fetch because the response is a binary stream, not JSON.
 */
export async function download(deps: TransferDeps, filePath: string): Promise<DriveDownloadResult> {
  const sid = await deps.getToken();
  const attempts: Array<Record<string, string>> = [{ path: sanitizePath(filePath) }];
  const fileId = await resolveDriveFileId(deps, sid, filePath);
  if (fileId !== undefined) {
    attempts.push({ path: `id:${fileId}` });
    attempts.push({ files: JSON.stringify([`id:${fileId}`]) });
  }

  let lastFailure: DownloadFailure | undefined;
  for (const params of attempts) {
    const attempt = await attemptDownload(deps, sid, params);
    if (attempt.success) {
      return await responseToDownloadResult(attempt.response, attempt.contentType, filePath);
    }
    lastFailure = attempt;
  }

  if (lastFailure?.code !== undefined) {
    throw mapSynologyError(lastFailure.code, 'SYNO.SynologyDrive.Files');
  }
  throw new NetworkError(`Download HTTP error: ${lastFailure?.status ?? 'unknown'}`);
}

async function responseToDownloadResult(
  response: FetchResponse,
  contentType: string,
  filePath: string,
): Promise<DriveDownloadResult> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const disposition = response.headers.get('content-disposition') ?? '';
  const fnMatch = /filename[^;=\n]*=(?:(['"])(?<q>[^'"]*)\1|(?<bare>[^;\n]*))/i.exec(disposition);
  const filename =
    fnMatch?.groups?.['q'] ?? fnMatch?.groups?.['bare'] ?? filePath.split('/').pop() ?? 'download';

  return { buffer, filename, mimeType: contentType };
}

async function attemptDownload(
  deps: TransferDeps,
  sid: string,
  params: Record<string, string>,
): Promise<DownloadAttempt> {
  const qs = new URLSearchParams({
    api: 'SYNO.SynologyDrive.Files',
    version: '2',
    method: 'download',
    ...params,
  });
  const url = `${deps.baseUrl}/webapi/entry.cgi?${qs.toString()}`;
  const init: Record<string, unknown> = {
    method: 'GET',
    headers: { Cookie: `id=${sid}` },
    signal: AbortSignal.timeout(60_000),
  };

  let response: FetchResponse;
  try {
    response = await httpFetch(url, init, deps.dispatcher);
  } catch (err) {
    throw new NetworkError(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) return { success: false, status: response.status };

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  if (contentType.includes('application/json')) {
    const errJson = (await response.json()) as { success: boolean; error?: { code: number } };
    if (!errJson.success) {
      return { success: false, status: response.status, code: errJson.error?.code ?? 100 };
    }
  }

  return { success: true, response, contentType };
}

async function resolveDriveFileId(
  deps: TransferDeps,
  sid: string,
  filePath: string,
): Promise<string | undefined> {
  const qs = new URLSearchParams({
    api: 'SYNO.SynologyDrive.Files',
    version: '2',
    method: 'get',
    path: sanitizePath(filePath),
  });
  const url = `${deps.baseUrl}/webapi/entry.cgi?${qs.toString()}`;
  const init: Record<string, unknown> = {
    method: 'GET',
    headers: { Cookie: `id=${sid}` },
    signal: AbortSignal.timeout(60_000),
  };

  try {
    const response = await httpFetch(url, init, deps.dispatcher);
    if (!response.ok) return undefined;
    const json = (await response.json()) as SynologyResponse<SynoDriveFile>;
    return json.success ? json.data?.file_id : undefined;
  } catch {
    return undefined;
  }
}
