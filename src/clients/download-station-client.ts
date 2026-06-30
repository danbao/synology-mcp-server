/**
 * Synology Download Station API client.
 * Wraps first-pass task management via SYNO.DownloadStation.Info/Task v1.
 */

import { BaseClient } from './base-client.js';
import type { AuthManager } from '../auth/auth-manager.js';
import type { SynologyConfig } from '../types/index.js';
import { NetworkError } from '../errors.js';

const INFO_ENDPOINT = '/webapi/DownloadStation/info.cgi';
const TASK_ENDPOINT = '/webapi/DownloadStation/task.cgi';

export type DownloadTaskStatus =
  | 'waiting'
  | 'downloading'
  | 'paused'
  | 'finishing'
  | 'finished'
  | 'hash_checking'
  | 'seeding'
  | 'filehosting'
  | 'extracting'
  | 'error'
  | 'unknown';

export interface DownloadTaskTransfer {
  size_downloaded: number;
  size_uploaded: number;
  speed_download: number;
  speed_upload: number;
}

export interface DownloadTaskDetail {
  destination?: string;
  uri?: string;
  create_time?: number;
  started_time?: number;
  completed_time?: number;
  waiting_seconds?: number;
  total_peers?: number;
  connected_seeders?: number;
  connected_leechers?: number;
}

export interface DownloadTaskFile {
  filename?: string;
  size?: number;
  size_downloaded?: number;
  priority?: string;
}

export interface DownloadTask {
  id: string;
  title: string;
  type?: string;
  username?: string;
  size: number;
  status: DownloadTaskStatus;
  error_detail?: string;
  additional?: {
    detail?: DownloadTaskDetail;
    transfer?: DownloadTaskTransfer;
    files?: DownloadTaskFile[];
  };
}

export interface DownloadTaskList {
  total: number;
  offset: number;
  tasks: DownloadTask[];
}

export interface ListDownloadTasksOpts {
  offset: number;
  limit: number;
  status?: DownloadTaskStatus;
  additional: DownloadTaskAdditional[];
}

export interface GetDownloadTaskOpts {
  task_ids: string[];
  additional: DownloadTaskAdditional[];
}

export interface CreateDownloadTaskOpts {
  uri: string;
  destination?: string;
}

export type DownloadTaskAdditional = 'detail' | 'transfer' | 'file';

interface SynoDownloadStationInfo {
  version?: number;
  version_string?: string;
  is_manager?: boolean;
}

interface SynoDownloadTaskEnvelope {
  tasks?: SynoDownloadTask[];
  total?: number;
  offset?: number;
}

interface SynoDownloadTask {
  id?: string;
  type?: string;
  username?: string;
  title?: string;
  size?: number | string;
  status?: string;
  status_extra?: {
    error_detail?: string;
  };
  additional?: {
    detail?: {
      destination?: string;
      uri?: string;
      create_time?: number | string;
      started_time?: number | string;
      completed_time?: number | string;
      waiting_seconds?: number | string;
      total_peers?: number | string;
      connected_seeders?: number | string;
      connected_leechers?: number | string;
    };
    transfer?: {
      size_downloaded?: number | string;
      size_uploaded?: number | string;
      speed_download?: number | string;
      speed_upload?: number | string;
    };
    file?: Array<{
      filename?: string;
      size?: number | string;
      size_downloaded?: number | string;
      priority?: string;
    }>;
  };
}

type SynoDownloadTaskDetailRaw = NonNullable<
  NonNullable<SynoDownloadTask['additional']>['detail']
>;
type SynoDownloadTaskTransferRaw = NonNullable<
  NonNullable<SynoDownloadTask['additional']>['transfer']
>;
type SynoDownloadTaskFilesRaw = NonNullable<NonNullable<SynoDownloadTask['additional']>['file']>;

export class DownloadStationClient extends BaseClient {
  private _available: boolean | undefined;

  constructor(config: SynologyConfig, authManager: AuthManager) {
    super(config, authManager);
  }

  /**
   * Check whether Download Station is installed and reachable.
   * Result is cached for the lifetime of this client instance.
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== undefined) return this._available;

    try {
      await this.request<SynoDownloadStationInfo>({
        endpoint: INFO_ENDPOINT,
        params: {
          api: 'SYNO.DownloadStation.Info',
          version: 1,
          method: 'getinfo',
        },
      });
      this._available = true;
    } catch {
      this._available = false;
    }

    return this._available;
  }

  async listTasks(opts: ListDownloadTasksOpts): Promise<DownloadTaskList> {
    const raw = await this.request<SynoDownloadTaskEnvelope>({
      endpoint: TASK_ENDPOINT,
      params: {
        api: 'SYNO.DownloadStation.Task',
        version: 1,
        method: 'list',
        offset: opts.offset,
        limit: opts.limit,
        additional: serializeAdditional(opts.additional),
      },
    });

    let tasks = (raw.tasks ?? []).map(normalizeTask);
    if (opts.status !== undefined) {
      tasks = tasks.filter((task) => task.status === opts.status);
    }

    return {
      total: raw.total ?? tasks.length,
      offset: raw.offset ?? opts.offset,
      tasks,
    };
  }

  async getTasks(opts: GetDownloadTaskOpts): Promise<DownloadTask[]> {
    if (opts.task_ids.length === 0) {
      throw new NetworkError('Download Station task_ids must not be empty');
    }

    const raw = await this.request<SynoDownloadTaskEnvelope>({
      endpoint: TASK_ENDPOINT,
      params: {
        api: 'SYNO.DownloadStation.Task',
        version: 1,
        method: 'getinfo',
        id: opts.task_ids.join(','),
        additional: serializeAdditional(opts.additional),
      },
    });

    return (raw.tasks ?? []).map(normalizeTask);
  }

  async createTask(opts: CreateDownloadTaskOpts): Promise<{ success: boolean; task_id?: string }> {
    const body = new URLSearchParams();
    body.set('uri', opts.uri);
    if (opts.destination !== undefined && opts.destination !== '') {
      body.set('destination', opts.destination);
    }

    const raw = await this.request<{ task_id?: string }>({
      endpoint: TASK_ENDPOINT,
      method: 'POST',
      params: {
        api: 'SYNO.DownloadStation.Task',
        version: 1,
        method: 'create',
      },
      body,
      allowEmptyData: true,
    });

    return { success: true, ...(raw.task_id !== undefined ? { task_id: raw.task_id } : {}) };
  }

  async pauseTasks(taskIds: string[]): Promise<{ success: boolean; task_ids: string[] }> {
    return await this.taskAction('pause', taskIds);
  }

  async resumeTasks(taskIds: string[]): Promise<{ success: boolean; task_ids: string[] }> {
    return await this.taskAction('resume', taskIds);
  }

  async deleteTasks(taskIds: string[]): Promise<{ success: boolean; task_ids: string[] }> {
    return await this.taskAction('delete', taskIds);
  }

  private async taskAction(
    method: 'pause' | 'resume' | 'delete',
    taskIds: string[],
  ): Promise<{ success: boolean; task_ids: string[] }> {
    if (taskIds.length === 0) {
      throw new NetworkError('Download Station task_ids must not be empty');
    }

    const body = new URLSearchParams();
    body.set('id', taskIds.join(','));
    if (method === 'delete') {
      body.set('force_complete', 'false');
    }

    await this.request<Record<string, never>>({
      endpoint: TASK_ENDPOINT,
      method: 'POST',
      params: {
        api: 'SYNO.DownloadStation.Task',
        version: 1,
        method,
      },
      body,
      allowEmptyData: true,
    });

    return { success: true, task_ids: taskIds };
  }
}

function serializeAdditional(additional: DownloadTaskAdditional[]): string {
  return additional.length > 0 ? additional.join(',') : 'detail,transfer';
}

function normalizeTask(raw: SynoDownloadTask): DownloadTask {
  const id = raw.id ?? '';
  const task: DownloadTask = {
    id,
    title: raw.title ?? id,
    ...(raw.type !== undefined ? { type: raw.type } : {}),
    ...(raw.username !== undefined ? { username: raw.username } : {}),
    size: toNumber(raw.size),
    status: normalizeStatus(raw.status),
    ...(raw.status_extra?.error_detail !== undefined
      ? { error_detail: raw.status_extra.error_detail }
      : {}),
  };

  const detail = normalizeDetail(raw.additional?.detail);
  const transfer = normalizeTransfer(raw.additional?.transfer);
  const files = normalizeFiles(raw.additional?.file);
  if (detail !== undefined || transfer !== undefined || files !== undefined) {
    task.additional = {
      ...(detail !== undefined ? { detail } : {}),
      ...(transfer !== undefined ? { transfer } : {}),
      ...(files !== undefined ? { files } : {}),
    };
  }

  return task;
}

function normalizeDetail(detail: SynoDownloadTaskDetailRaw | undefined): DownloadTaskDetail | undefined {
  if (detail === undefined) return undefined;
  return {
    ...(detail.destination !== undefined ? { destination: detail.destination } : {}),
    ...(detail.uri !== undefined ? { uri: detail.uri } : {}),
    ...(detail.create_time !== undefined ? { create_time: toNumber(detail.create_time) } : {}),
    ...(detail.started_time !== undefined ? { started_time: toNumber(detail.started_time) } : {}),
    ...(detail.completed_time !== undefined
      ? { completed_time: toNumber(detail.completed_time) }
      : {}),
    ...(detail.waiting_seconds !== undefined
      ? { waiting_seconds: toNumber(detail.waiting_seconds) }
      : {}),
    ...(detail.total_peers !== undefined ? { total_peers: toNumber(detail.total_peers) } : {}),
    ...(detail.connected_seeders !== undefined
      ? { connected_seeders: toNumber(detail.connected_seeders) }
      : {}),
    ...(detail.connected_leechers !== undefined
      ? { connected_leechers: toNumber(detail.connected_leechers) }
      : {}),
  };
}

function normalizeTransfer(
  transfer: SynoDownloadTaskTransferRaw | undefined,
): DownloadTaskTransfer | undefined {
  if (transfer === undefined) return undefined;
  return {
    size_downloaded: toNumber(transfer.size_downloaded),
    size_uploaded: toNumber(transfer.size_uploaded),
    speed_download: toNumber(transfer.speed_download),
    speed_upload: toNumber(transfer.speed_upload),
  };
}

function normalizeFiles(files: SynoDownloadTaskFilesRaw | undefined): DownloadTaskFile[] | undefined {
  if (!Array.isArray(files)) return undefined;
  return files.map((file) => ({
    ...(file.filename !== undefined ? { filename: file.filename } : {}),
    size: toNumber(file.size),
    size_downloaded: toNumber(file.size_downloaded),
    ...(file.priority !== undefined ? { priority: file.priority } : {}),
  }));
}

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeStatus(status: string | undefined): DownloadTaskStatus {
  switch (status) {
    case 'waiting':
    case 'downloading':
    case 'paused':
    case 'finishing':
    case 'finished':
    case 'hash_checking':
    case 'seeding':
    case 'filehosting':
    case 'extracting':
    case 'error':
      return status;
    default:
      return 'unknown';
  }
}
