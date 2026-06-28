/**
 * Internal Synology API raw response shapes for Drive operations.
 * These are NOT exported to consumers — they are implementation details
 * of the DriveClient and its operation modules.
 */

/** Raw label entry from SYNO.SynologyDrive.Labels list */
export interface SynoDriveLabel {
  id?: string;
  label_id?: string | number;
  name: string;
  color?: string;
}

/** Raw response for upload */
export interface SynoDriveUploadResponse {
  file_id: string;
  path: string;
  display_path?: string;
  name: string;
}

/** Raw response for create_folder */
export interface SynoDriveFolderResponse {
  file_id: string;
  path: string;
  display_path?: string;
  name?: string;
}

/** Raw response for move */
export interface SynoDriveMoveResponse {
  async_task_id?: string;
  path?: string;
  display_path?: string;
}

/** Raw response for async Drive mutations */
export interface SynoDriveAsyncResponse {
  async_task_id?: string;
}

export interface SynoDriveTaskError {
  code?: number;
  message?: string;
  context?: Record<string, unknown>;
}

export interface SynoDriveTaskData {
  task_id?: string;
  status?: string;
  progress?: number;
  result?: {
    action?: string;
    errors?: SynoDriveTaskError[] | null;
    processed_size?: number;
    total_size?: number;
  };
}

export interface SynoEntryRequestItem {
  api?: string;
  method?: string;
  version?: number;
  success: boolean;
  data?: SynoDriveTaskData;
  error?: {
    code?: number;
    errors?: {
      message?: string;
      line?: number;
    };
  };
}

export interface SynoEntryRequestResponse {
  has_fail?: boolean;
  result?: SynoEntryRequestItem[];
}

/** Raw response for rename/update */
export interface SynoDriveUpdateResponse {
  file_id?: string;
  path?: string;
  display_path?: string;
  name?: string;
}

/** Raw response for sharing link creation */
export interface SynoDriveSharingResponse {
  link?: string;
  url?: string;
  permission?: string;
  /** Unix timestamp; absent when no expiry is set */
  expire_time?: number | null;
}

/** Raw label list response */
export interface SynoDriveLabelListResponse {
  labels?: SynoDriveLabel[];
  items?: SynoDriveLabel[];
  total?: number;
}
