/**
 * Synology MailPlus API client.
 * Wraps SYNO.MailClient.Mailbox, SYNO.MailClient.Message, SYNO.MailClient.Draft,
 * and SYNO.MailClient.Attachment endpoints.
 * Availability is probed once via SYNO.API.Info and cached for the client lifetime.
 * Per spec §7.3.
 */

import FormData from 'form-data';
import { BaseClient } from './base-client.js';
import { httpFetch } from '../utils/http-fetch.js';
import type { AuthManager } from '../auth/auth-manager.js';
import type { SynologyConfig } from '../types/index.js';
import type { SynoMailFolder, SynoMailMessage } from '../types/synology-types.js';
import { NotFoundError, ValidationError } from '../errors.js';

const ENTRY = '/webapi/entry.cgi';
const WELL_KNOWN_MAILBOX_IDS = new Map<string, string>([
  ['INBOX', '-1'],
  ['Archive', '-2'],
  ['Archived', '-2'],
  ['Drafts', '-3'],
  ['Sent', '-4'],
  ['Junk', '-5'],
  ['Spam', '-5'],
  ['Trash', '-6'],
]);

// ---------------------------------------------------------------------------
// Input/output types
// ---------------------------------------------------------------------------

/** Options for listMessages */
export interface ListMessagesOpts {
  folder_path?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  sort_by?: 'date' | 'subject' | 'sender' | 'size' | undefined;
  sort_direction?: 'ASC' | 'DESC' | undefined;
  unread_only?: boolean | undefined;
  search?: string | undefined;
  account?: string | undefined;
}

/** MailPlus list-messages API response */
export interface SynoMailListResponse {
  total: number;
  messages: SynoMailMessage[];
}

/** MailPlus mailbox shape returned by SYNO.MailClient.Mailbox list v7. */
interface SynoMailClientMailbox {
  id: string | number;
  path?: string;
  name?: string;
}

/** MailPlus mailbox-list response shape returned by current MailPlus. */
interface SynoMailClientMailboxListResponse {
  mailbox?: SynoMailClientMailbox[];
  total?: number;
}

/** Condition object accepted by SYNO.MailClient.Thread list. */
interface SynoMailClientCondition {
  name: string;
  value: string;
  not_operator?: boolean;
}

/** Message summary nested inside SYNO.MailClient.Thread list responses. */
interface SynoMailClientThreadMessage {
  id?: string | number;
  subject?: string;
  from?: unknown;
  recipients?: unknown[];
  to?: unknown[];
  cc?: unknown[];
  bcc?: unknown[];
  date?: number;
  arrival_time?: number;
  last_modified?: number;
  size?: number;
  read?: boolean;
  star?: number | boolean;
  attachment?: unknown[];
  body?: { plain?: string; html?: string };
  body_preview?: string;
  preview?: string;
  mailbox_id?: string | number;
  type?: number;
}

/** Thread item returned by SYNO.MailClient.Thread list. */
interface SynoMailClientThread {
  id?: string | number;
  unread?: number | boolean;
  star?: number | boolean;
  last_modified?: number;
  message?: SynoMailClientThreadMessage[];
}

/** Thread-list response returned by current MailPlus. */
interface SynoMailClientThreadListResponse {
  total?: number;
  thread?: SynoMailClientThread[];
}

/** Message-get response returned by current MailPlus. */
interface SynoMailClientMessageGetResponse {
  message?: SynoMailClientThreadMessage[];
}

/** Full message detail with body and attachments */
export interface SynoMailDetail {
  id: string;
  subject: string;
  from: { name: string; address: string };
  to: Array<{ name: string; address: string }>;
  cc?: Array<{ name: string; address: string }>;
  bcc?: Array<{ name: string; address: string }>;
  date: number;
  body_text: string;
  body_html: string;
  attachments: SynoMailAttachmentMeta[];
}

/** Attachment metadata (without content) */
export interface SynoMailAttachmentMeta {
  id: string;
  name: string;
  mime_type: string;
  size: number;
}

/** Attachment including raw content */
export interface SynoMailAttachmentWithContent extends SynoMailAttachmentMeta {
  content: Buffer;
}

/** Options for getMessage */
export interface GetMessageOpts {
  message_id: string;
  include_attachments?: boolean | undefined;
}

/** Options for send */
export interface SendMessageOpts {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  body_format?: 'text' | 'html' | undefined;
  attachments?: Array<{ name: string; content_base64: string; mime_type: string }> | undefined;
  account?: string | undefined;
}

/** Synology send response */
export interface SynoSendResult {
  message_id: string;
  sent_at: number;
}

/** Options for mark */
export interface MarkMessagesOpts {
  message_ids: string[];
  action: 'read' | 'unread' | 'flag' | 'unflag';
  account?: string | undefined;
}

/** Options for move */
export interface MoveMessagesOpts {
  message_ids: string[];
  dest_folder: string;
  account?: string | undefined;
}

/** SYNO.API.Info query response shape (partial) */
interface SynoApiInfoResult {
  [apiName: string]: { path: string; minVersion: number; maxVersion: number };
}

/** SYNO.API.Info response envelope used by the anonymous availability probe. */
interface SynoApiInfoEnvelope {
  success: boolean;
  data?: SynoApiInfoResult;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Wraps all SYNO.MailClient operations.
 * isAvailable() probes SYNO.API.Info once and caches the result.
 */
export class MailPlusClient extends BaseClient {
  /** Cached availability result; undefined means not yet checked. */
  private _available: boolean | undefined = undefined;
  private readonly availabilityTimeoutMs: number;
  private readonly mailboxIdCache = new Map<string, string>();

  constructor(config: SynologyConfig, authManager: AuthManager) {
    super(config, authManager);
    this.availabilityTimeoutMs = config.requestTimeoutMs;
  }

  /**
   * Check whether the MailPlus Server package is installed on the NAS.
   * Result is cached for the lifetime of this client instance.
   */
  async isAvailable(): Promise<boolean> {
    if (this._available !== undefined) return this._available;

    try {
      const qs = new URLSearchParams({
        api: 'SYNO.API.Info',
        version: '1',
        method: 'query',
        query: 'SYNO.MailClient.Mailbox',
      });
      const response = await httpFetch(
        `${this.baseUrl}${ENTRY}?${qs.toString()}`,
        {
          method: 'GET',
          signal: AbortSignal.timeout(this.availabilityTimeoutMs),
        },
        this.dispatcher,
      );
      const result = (await response.json()) as SynoApiInfoEnvelope;
      this._available =
        result.success === true &&
        result.data !== undefined &&
        'SYNO.MailClient.Mailbox' in result.data;
    } catch {
      this._available = false;
    }

    return this._available;
  }

  /**
   * List all mail folders for an account.
   *
   * @param account - Optional email account; defaults to user's primary.
   */
  listFolders(account?: string): Promise<SynoMailFolder[]> {
    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.MailClient.Mailbox',
      version: 1,
      method: 'list',
    };
    if (account !== undefined) params['account'] = account;

    return this.request<SynoMailFolder[]>({ endpoint: ENTRY, method: 'GET', params });
  }

  /**
   * List messages in a folder with optional filtering.
   *
   * @param opts - Query options including folder, pagination, sort, and search.
   */
  async listMessages(opts: ListMessagesOpts): Promise<SynoMailListResponse> {
    const mailboxId = await this.resolveMailboxId(opts.folder_path ?? 'INBOX', opts.account);
    const condition = this.buildThreadCondition(mailboxId, opts);
    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.MailClient.Thread',
      version: 10,
      method: 'list',
      condition: JSON.stringify(condition),
      limit: opts.limit ?? 20,
      offset: opts.offset ?? 0,
      additional: JSON.stringify(['with_recipient']),
      conversation_view: true,
    };
    if (opts.account !== undefined) params['account'] = opts.account;

    const response = await this.request<SynoMailClientThreadListResponse>({
      endpoint: ENTRY,
      method: 'GET',
      params,
    });

    return this.normalizeThreadList(response, mailboxId, opts);
  }

  private buildThreadCondition(
    mailboxId: string,
    opts: ListMessagesOpts,
  ): SynoMailClientCondition[] {
    const condition: SynoMailClientCondition[] = [{ name: 'mailbox', value: mailboxId }];

    if (opts.unread_only === true) {
      condition.push({ name: 'unread', value: 'true' });
    }

    const search = opts.search?.trim();
    if (search) {
      condition.push({ name: 'keyword', value: search });
    }

    return condition;
  }

  private async resolveMailboxId(folderPath: string, account?: string): Promise<string> {
    const normalized = folderPath.trim();
    if (/^-?\d+$/.test(normalized)) return normalized;

    const wellKnown = WELL_KNOWN_MAILBOX_IDS.get(normalized);
    if (wellKnown !== undefined) return wellKnown;

    const cacheKey = this.mailboxCacheKey(normalized, account);
    const cached = this.mailboxIdCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.MailClient.Mailbox',
      version: 7,
      method: 'list',
      conversation_view: true,
    };
    if (account !== undefined) params['account'] = account;

    const response = await this.request<
      SynoMailClientMailboxListResponse | SynoMailClientMailbox[]
    >({
      endpoint: ENTRY,
      method: 'GET',
      params,
    });
    const mailboxes = Array.isArray(response) ? response : (response.mailbox ?? []);

    for (const mailbox of mailboxes) {
      const id = String(mailbox.id);
      if (mailbox.path !== undefined) {
        this.mailboxIdCache.set(this.mailboxCacheKey(mailbox.path, account), id);
      }
      if (mailbox.name !== undefined) {
        this.mailboxIdCache.set(this.mailboxCacheKey(mailbox.name, account), id);
      }
    }

    const resolved = this.mailboxIdCache.get(cacheKey);
    if (resolved !== undefined) return resolved;

    throw new ValidationError(
      'MAILBOX_NOT_FOUND',
      `MailPlus mailbox '${folderPath}' was not found. Use mailplus_list_folders to inspect valid folder paths.`,
    );
  }

  private mailboxCacheKey(folderPath: string, account?: string): string {
    return `${account ?? ''}\u0000${folderPath}`;
  }

  private normalizeThreadList(
    response: SynoMailClientThreadListResponse,
    mailboxId: string,
    opts: ListMessagesOpts,
  ): SynoMailListResponse {
    const messages = (response.thread ?? [])
      .map((thread) => {
        const message = this.pickPreviewMessage(thread, mailboxId);
        return message === undefined ? undefined : this.normalizeThreadMessage(message, thread);
      })
      .filter((message): message is SynoMailMessage => message !== undefined);

    return {
      total: response.total ?? messages.length,
      messages: this.sortMessages(messages, opts),
    };
  }

  private pickPreviewMessage(
    thread: SynoMailClientThread,
    mailboxId: string,
  ): SynoMailClientThreadMessage | undefined {
    const messages = thread.message ?? [];
    if (messages.length === 0) return undefined;

    const nonScheduledMessages = messages.filter((message) => String(message.mailbox_id) !== '-7');
    const visibleMessages = nonScheduledMessages.length > 0 ? nonScheduledMessages : messages;

    if (mailboxId === '-4') {
      const sentMessages = visibleMessages.filter((message) => message.type === 2);
      return sentMessages.at(-1) ?? visibleMessages.at(-1);
    }

    return visibleMessages.at(-1);
  }

  private normalizeThreadMessage(
    message: SynoMailClientThreadMessage,
    thread: SynoMailClientThread,
  ): SynoMailMessage {
    const attachments = Array.isArray(message.attachment) ? message.attachment : [];
    const flags: string[] = [];
    if (message.read === true) flags.push('\\Seen');
    if (message.star === true || message.star === 1 || thread.star === true || thread.star === 1) {
      flags.push('\\Flagged');
    }
    if (attachments.length > 0) flags.push('\\HasAttachment');

    return {
      id: String(message.id ?? thread.id ?? ''),
      subject: message.subject ?? '',
      from: parseMailAddress(message.from),
      to: parseMailAddressList(message.recipients ?? message.to ?? []),
      date:
        message.arrival_time ?? message.date ?? message.last_modified ?? thread.last_modified ?? 0,
      size: message.size ?? 0,
      flags,
      preview: message.body_preview ?? message.preview ?? '',
    };
  }

  private sortMessages(messages: SynoMailMessage[], opts: ListMessagesOpts): SynoMailMessage[] {
    const direction = opts.sort_direction === 'ASC' ? 1 : -1;
    const sortBy = opts.sort_by ?? 'date';

    return [...messages].sort((a, b) => {
      let result: number;
      if (sortBy === 'subject') {
        result = a.subject.localeCompare(b.subject);
      } else if (sortBy === 'sender') {
        result = a.from.address.localeCompare(b.from.address);
      } else if (sortBy === 'size') {
        result = a.size - b.size;
      } else {
        result = a.date - b.date;
      }

      return result * direction;
    });
  }

  /**
   * Fetch full message content; optionally fetch attachment content.
   *
   * @param opts - message_id and include_attachments flag.
   */
  async getMessage(opts: GetMessageOpts): Promise<
    SynoMailDetail & {
      attachments: Array<SynoMailAttachmentMeta & { content_base64: string | null }>;
    }
  > {
    const response = await this.request<SynoMailClientMessageGetResponse>({
      endpoint: ENTRY,
      method: 'GET',
      params: {
        api: 'SYNO.MailClient.Message',
        version: 10,
        method: 'get',
        id: JSON.stringify([opts.message_id]),
        additional: JSON.stringify(['blockquote', 'truncated', 'block_external_image']),
      },
    });
    const message = response.message?.[0];
    if (message === undefined) {
      throw new NotFoundError(`MailPlus message '${opts.message_id}' was not found`);
    }
    const detail = this.normalizeFullMessage(message);

    if (!opts.include_attachments || detail.attachments.length === 0) {
      return {
        ...detail,
        attachments: detail.attachments.map((a) => ({ ...a, content_base64: null })),
      };
    }

    // Fetch attachment content for each attachment
    const attachmentsWithContent = await Promise.all(
      detail.attachments.map(async (att) => {
        try {
          const content = await this.fetchAttachmentContent(att.id, opts.message_id);
          return { ...att, content_base64: content.toString('base64') };
        } catch {
          return { ...att, content_base64: null };
        }
      }),
    );

    return { ...detail, attachments: attachmentsWithContent };
  }

  private normalizeFullMessage(message: SynoMailClientThreadMessage): SynoMailDetail {
    return {
      id: String(message.id ?? ''),
      subject: message.subject ?? '',
      from: parseMailAddress(message.from),
      to: parseMailAddressList(message.to ?? message.recipients ?? []),
      cc: parseMailAddressList(message.cc ?? []),
      bcc: parseMailAddressList(message.bcc ?? []),
      date: message.arrival_time ?? message.date ?? message.last_modified ?? 0,
      body_text: message.body?.plain ?? '',
      body_html: message.body?.html ?? '',
      attachments: normalizeAttachments(message.attachment ?? []),
    };
  }

  /**
   * Fetch raw attachment bytes from SYNO.MailClient.Attachment.
   *
   * @param attachment_id - Attachment ID.
   * @param message_id - Parent message ID.
   */
  private async fetchAttachmentContent(attachment_id: string, message_id: string): Promise<Buffer> {
    const sid = await this.authManager.getToken();
    const qs = new URLSearchParams({
      api: 'SYNO.MailClient.Attachment',
      version: '1',
      method: 'get',
      attachment_id,
      message_id,
    });
    const url = `${this.baseUrl}${ENTRY}?${qs.toString()}`;
    const response = await httpFetch(url, { headers: { Cookie: `id=${sid}` } }, this.dispatcher);

    if (!response.ok) {
      throw new Error(`Attachment fetch failed with HTTP ${response.status}`);
    }

    const buf = await response.arrayBuffer();
    return Buffer.from(buf);
  }

  /**
   * Send an email message using SYNO.MailClient.Draft.
   * Attachments are decoded from base64 to Buffer and sent as multipart.
   *
   * @param opts - Recipient lists, subject, body, and optional attachments.
   */
  /**
   * Send an email message using SYNO.MailClient.Draft.
   * api/version/method go on the query string (matching all other POST handlers);
   * message fields and attachments go in the multipart body.
   *
   * @param opts - Recipient lists, subject, body, and optional attachments.
   */
  async send(opts: SendMessageOpts): Promise<SynoSendResult> {
    const form = new FormData();
    form.append('to', JSON.stringify(opts.to));
    form.append('subject', opts.subject);
    form.append('body', opts.body);
    form.append('body_format', opts.body_format ?? 'text');

    if (opts.cc !== undefined) form.append('cc', JSON.stringify(opts.cc));
    if (opts.bcc !== undefined) form.append('bcc', JSON.stringify(opts.bcc));
    if (opts.account !== undefined) form.append('account', opts.account);

    if (opts.attachments !== undefined) {
      for (const att of opts.attachments) {
        const buf = Buffer.from(att.content_base64, 'base64');
        form.append('attachment', buf, { filename: att.name, contentType: att.mime_type });
      }
    }

    const sid = await this.authManager.getToken();
    const qs = new URLSearchParams({
      api: 'SYNO.MailClient.Draft',
      version: '1',
      method: 'send',
    });
    const url = `${this.baseUrl}${ENTRY}?${qs.toString()}`;

    const response = await httpFetch(
      url,
      {
        method: 'POST',
        headers: {
          Cookie: `id=${sid}`,
          ...form.getHeaders(),
        },
        body: form.getBuffer(),
      },
      this.dispatcher,
    );

    if (!response.ok) {
      throw new Error(`Send failed with HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      success: boolean;
      data?: SynoSendResult;
      error?: { code: number };
    };
    if (!json.success || json.data === undefined) {
      const code = json.error?.code ?? 100;
      throw new Error(`Send failed with Synology error code ${code}`);
    }

    return json.data;
  }

  /**
   * Mark messages as read/unread/flagged/unflagged.
   *
   * @param opts - message_ids and action.
   */
  async mark(opts: MarkMessagesOpts): Promise<void> {
    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.MailClient.Message',
      version: 1,
      method: 'mark',
      message_ids: JSON.stringify(opts.message_ids),
      action: opts.action,
    };
    if (opts.account !== undefined) params['account'] = opts.account;

    await this.request<unknown>({ endpoint: ENTRY, method: 'POST', params });
  }

  /**
   * Move messages to a destination folder.
   *
   * @param opts - message_ids and dest_folder path.
   */
  async move(opts: MoveMessagesOpts): Promise<void> {
    const params: Record<string, string | number | boolean> = {
      api: 'SYNO.MailClient.Message',
      version: 1,
      method: 'move',
      message_ids: JSON.stringify(opts.message_ids),
      dest_folder: opts.dest_folder,
    };
    if (opts.account !== undefined) params['account'] = opts.account;

    await this.request<unknown>({ endpoint: ENTRY, method: 'POST', params });
  }
}

function parseMailAddress(value: unknown): { name: string; address: string } {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as { name?: unknown; address?: unknown; email?: unknown };
    const address = candidate.address ?? candidate.email;
    if (typeof address === 'string') {
      return {
        name: typeof candidate.name === 'string' ? candidate.name : '',
        address,
      };
    }
  }

  if (typeof value !== 'string') return { name: '', address: '' };

  const trimmed = value.trim();
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  if (match) {
    return {
      name: unquoteAddressName(match[1]?.trim() ?? ''),
      address: match[2]?.trim() ?? '',
    };
  }

  return { name: '', address: trimmed };
}

function parseMailAddressList(values: unknown[]): Array<{ name: string; address: string }> {
  return values.map(parseMailAddress).filter((addr) => addr.address.length > 0);
}

function normalizeAttachments(values: unknown[]): SynoMailAttachmentMeta[] {
  return values.map((value) => {
    if (typeof value !== 'object' || value === null) {
      return { id: '', name: 'attachment', mime_type: 'application/octet-stream', size: 0 };
    }

    const candidate = value as {
      id?: unknown;
      name?: unknown;
      filename?: unknown;
      mime_type?: unknown;
      mime?: unknown;
      content_type?: unknown;
      size?: unknown;
      file_size?: unknown;
    };
    const name = candidate.name ?? candidate.filename;
    const mimeType = candidate.mime_type ?? candidate.mime ?? candidate.content_type;
    const size = candidate.size ?? candidate.file_size;

    return {
      id: primitiveToString(candidate.id),
      name: typeof name === 'string' && name.length > 0 ? name : 'attachment',
      mime_type:
        typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'application/octet-stream',
      size: typeof size === 'number' ? size : 0,
    };
  });
}

function primitiveToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unquoteAddressName(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}
