/**
 * Drive folder, label, and sharing operations:
 * createFolder, move, delete, listLabels, addLabel, getSharingLink.
 */

import { sanitizePath } from '../../utils/path-guard.js';
import { NetworkError, NotFoundError } from '../../errors.js';
import type { RequestOptions } from '../base-client.js';
import type { SynoDriveFile } from '../../types/synology-types.js';
import type {
  SynoDriveAsyncResponse,
  SynoDriveFolderResponse,
  SynoDriveMoveResponse,
  SynoDriveUpdateResponse,
  SynoDriveLabelListResponse,
  SynoDriveSharingResponse,
  SynoDriveTaskData,
  SynoEntryRequestResponse,
} from './raw-response-types.js';
import type {
  DriveFolderResult,
  DriveMoveResult,
  DriveLabel,
  DriveSharingLinkResult,
} from './drive-types.js';

type RequestFn = <T>(options: RequestOptions) => Promise<T>;

const DELETE_CONFIRM_TIMEOUT_MS = 15_000;
const DELETE_CONFIRM_INTERVAL_MS = 500;
const TASK_CONFIRM_TIMEOUT_MS = 15_000;
const TASK_CONFIRM_INTERVAL_MS = 500;

function driveEntryPath(path: string): string {
  return `id:${path}`;
}

function joinDrivePath(parentPath: string, name: string): string {
  const parent = sanitizePath(parentPath).replace(/\/+$/, '');
  const child = name.replace(/^\/+/, '');
  return `${parent}/${child}`;
}

function basename(path: string): string {
  const clean = sanitizePath(path).replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

async function getDriveEntry(request: RequestFn, path: string): Promise<SynoDriveFile> {
  return await request<SynoDriveFile>({
    endpoint: '/webapi/entry.cgi',
    params: {
      api: 'SYNO.SynologyDrive.Files',
      version: 2,
      method: 'get',
      path: sanitizePath(path),
    },
  });
}

function filesBody(fileId: string): string {
  return JSON.stringify([driveEntryPath(fileId)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilDriveEntryGone(request: RequestFn, path: string): Promise<void> {
  const cleanPath = sanitizePath(path);
  const deadline = Date.now() + DELETE_CONFIRM_TIMEOUT_MS;

  while (true) {
    try {
      await getDriveEntry(request, cleanPath);
    } catch (err) {
      if (err instanceof NotFoundError) return;
      throw err;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new NetworkError(
        `Drive delete task did not finish within ${DELETE_CONFIRM_TIMEOUT_MS}ms for ${cleanPath}`,
      );
    }

    await sleep(Math.min(DELETE_CONFIRM_INTERVAL_MS, remainingMs));
  }
}

function formatDriveTaskFailure(task: SynoDriveTaskData | undefined): string | undefined {
  const errors = task?.result?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;

  return errors
    .map((error) => {
      const message = error.message ?? 'unknown task error';
      return error.code === undefined ? message : `${message} (code ${error.code})`;
    })
    .join('; ');
}

async function waitForDriveTask(request: RequestFn, taskId: string, action: string): Promise<void> {
  const deadline = Date.now() + TASK_CONFIRM_TIMEOUT_MS;

  while (true) {
    const body = new URLSearchParams();
    body.set('mode', 'parallel');
    body.set('stop_when_error', 'false');
    body.set(
      'compound',
      JSON.stringify([
        {
          api: 'SYNO.SynologyDrive.Tasks',
          version: 1,
          method: 'get',
          task_id: taskId,
        },
      ]),
    );

    const raw = await request<SynoEntryRequestResponse>({
      endpoint: '/webapi/entry.cgi',
      method: 'POST',
      params: {
        api: 'SYNO.Entry.Request',
        version: 1,
        method: 'request',
      },
      body,
    });
    const taskResult = raw.result?.[0];

    if (taskResult?.success !== true) {
      const message = taskResult?.error?.errors?.message ?? `Drive ${action} task status unavailable`;
      throw new NetworkError(`${message} (task ${taskId})`);
    }

    const task = taskResult.data;
    const failure = formatDriveTaskFailure(task);
    if (failure) {
      throw new NetworkError(`Drive ${action} task failed: ${failure}`);
    }

    if (task?.status === 'finished' || (task?.progress ?? 0) >= 100) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new NetworkError(
        `Drive ${action} task did not finish within ${TASK_CONFIRM_TIMEOUT_MS}ms (task ${taskId})`,
      );
    }

    await sleep(Math.min(TASK_CONFIRM_INTERVAL_MS, remainingMs));
  }
}

/** Options for createFolder */
export interface CreateFolderOpts {
  folder_path: string;
  name: string;
  force_parent: boolean;
}

/** Options for move */
export interface MoveOpts {
  path: string;
  dest_folder_path: string;
  new_name?: string | undefined;
  conflict_action: 'version' | 'autorename' | 'skip';
}

/** Options for getSharingLink */
export interface SharingLinkOpts {
  path: string;
  permission: 'view' | 'edit' | 'download';
  password?: string | undefined;
  expire_days?: number | undefined;
}

/** Create a new folder in Drive. */
export async function createFolder(
  request: RequestFn,
  opts: CreateFolderOpts,
): Promise<DriveFolderResult> {
  const folderPath = joinDrivePath(opts.folder_path, opts.name);
  const body = new URLSearchParams();
  body.set('path', folderPath);
  body.set('type', 'folder');
  body.set('conflict_action', 'version');

  const raw = await request<SynoDriveFolderResponse>({
    endpoint: '/webapi/entry.cgi',
    method: 'POST',
    params: {
      api: 'SYNO.SynologyDrive.Files',
      version: 2,
      method: 'create',
    },
    body,
  });
  return {
    success: true,
    folder_id: raw.file_id,
    folder_path: raw.display_path ?? raw.path ?? folderPath,
  };
}

/** Move or rename a file/folder. */
export async function move(request: RequestFn, opts: MoveOpts): Promise<DriveMoveResult> {
  const source = await getDriveEntry(request, opts.path);
  const destFolder = await getDriveEntry(request, opts.dest_folder_path);
  const body = new URLSearchParams();
  body.set('files', filesBody(source.file_id));
  body.set('to_parent_folder', driveEntryPath(destFolder.file_id));
  body.set('conflict_action', opts.conflict_action);
  body.set('dry_run', 'false');

  const raw = await request<SynoDriveMoveResponse>({
    endpoint: '/webapi/entry.cgi',
    method: 'POST',
    params: {
      api: 'SYNO.SynologyDrive.Files',
      version: 2,
      method: 'move',
    },
    body,
  });

  const expectedName = opts.new_name ?? source.name ?? basename(opts.path);
  let newPath = raw.display_path ?? raw.path ?? joinDrivePath(opts.dest_folder_path, expectedName);

  if (opts.new_name !== undefined) {
    const renameBody = new URLSearchParams();
    renameBody.set('path', driveEntryPath(source.file_id));
    renameBody.set('name', opts.new_name);
    const renamed = await request<SynoDriveUpdateResponse>({
      endpoint: '/webapi/entry.cgi',
      method: 'POST',
      params: {
        api: 'SYNO.SynologyDrive.Files',
        version: 2,
        method: 'update',
      },
      body: renameBody,
    });
    newPath = renamed.display_path ?? renamed.path ?? joinDrivePath(opts.dest_folder_path, opts.new_name);
  }

  return { dry_run: false, success: true, new_path: newPath };
}

/** Delete a file or folder (trash or permanent). */
export async function deleteFile(
  request: RequestFn,
  opts: { path: string; permanent: boolean },
): Promise<{ success: boolean }> {
  const entry = await getDriveEntry(request, opts.path);
  const body = new URLSearchParams();
  body.set('files', filesBody(entry.file_id));
  body.set('permanent', String(opts.permanent));

  const raw = await request<SynoDriveAsyncResponse>({
    endpoint: '/webapi/entry.cgi',
    method: 'POST',
    params: {
      api: 'SYNO.SynologyDrive.Files',
      version: 10,
      method: 'delete',
    },
    body,
  });
  if (raw.async_task_id) {
    await waitForDriveTask(request, raw.async_task_id, 'delete');
  }
  await waitUntilDriveEntryGone(request, opts.path);
  return { success: true };
}

/** List all label definitions in Drive. */
export async function listLabels(request: RequestFn): Promise<DriveLabel[]> {
  const raw = await request<SynoDriveLabelListResponse>({
    endpoint: '/webapi/entry.cgi',
    params: { api: 'SYNO.SynologyDrive.Labels', version: 3, method: 'list' },
  });
  return (raw.items ?? raw.labels ?? []).map((label) => ({
    id: String(label.id ?? label.label_id ?? label.name),
    name: label.name,
    color: label.color ?? '',
  }));
}

/** Apply a label to a file or folder by name. */
export async function addLabel(
  request: RequestFn,
  opts: { path: string; label_name: string },
): Promise<{ success: boolean }> {
  const entry = await getDriveEntry(request, opts.path);
  const label = (await listLabels(request)).find((item) => item.name === opts.label_name);
  if (!label) {
    throw new NotFoundError(`Drive label not found: ${opts.label_name}`);
  }

  const body = new URLSearchParams();
  body.set('files', filesBody(entry.file_id));
  body.set('labels', JSON.stringify([{ action: 'add', label_id: label.id }]));

  await request<Record<string, never>>({
    endpoint: '/webapi/entry.cgi',
    method: 'POST',
    params: {
      api: 'SYNO.SynologyDrive.Files',
      version: 2,
      method: 'label',
    },
    body,
    allowEmptyData: true,
  });
  return { success: true };
}

/** Generate or retrieve a sharing link for a file. */
export async function getSharingLink(
  request: RequestFn,
  opts: SharingLinkOpts,
): Promise<DriveSharingLinkResult> {
  const entry = await getDriveEntry(request, opts.path);
  const body = new URLSearchParams();
  body.set('path', driveEntryPath(entry.file_id));

  const raw = await request<SynoDriveSharingResponse>({
    endpoint: '/webapi/entry.cgi',
    method: 'POST',
    params: {
      api: 'SYNO.SynologyDrive.Sharing',
      version: 1,
      method: 'create_link',
    },
    body,
  });

  return {
    link: raw.url ?? raw.link ?? '',
    permission: raw.permission ?? opts.permission,
    expires_at: raw.expire_time ? new Date(raw.expire_time * 1000).toISOString() : null,
  };
}
