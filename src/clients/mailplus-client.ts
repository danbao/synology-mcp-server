/**
 * Synology MailPlus API client.
 * Wraps SYNO.MailClient.Mailbox, SYNO.MailClient.Message, SYNO.MailClient.Draft,
 * and SYNO.MailClient.Attachment endpoints.
 * Availability is probed once via SYNO.API.Info and cached for the client lifetime.
 * Per spec §7.3.
 */

import FormData from 'form-data';
import { BaseClient } from './base-client.js';
import { httpFetch, type FetchResponse } from '../utils/http-fetch.js';
import type { AuthManager } from '../auth/auth-manager.js';
import type { SynologyConfig } from '../types/index.js';
import type { SynoMailFolder, SynoMailMessage } from '../types/synology-types.js';
import { NetworkError, NotFoundError, ValidationError } from '../errors.js';
import { mapSynologyError } from '../utils/synology-error-map.js';

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
  md5?: string;
  msg_path?: string;
  part_id?: string;
  is_cms?: boolean;
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

type MailPlusParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null>
  | Record<string, unknown>;

interface SynologyEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: number };
}

interface SynoAttachmentUploadResponse {
  id?: string | number;
  attachment_id?: string | number;
  upload_id?: string | number;
  attachment?: SynoAttachmentUploadResponse | SynoAttachmentUploadResponse[];
}

interface SynoDraftCreateResponse {
  id?: string | number;
  draft_id?: string | number;
  message_id?: string | number;
  draft?: { id?: string | number; draft_id?: string | number };
}

interface SynoDraftSendResponse {
  id?: string | number;
  message_id?: string | number;
  sent_at?: number;
  time?: number;
  message?: { id?: string | number; date?: number; sent_at?: number };
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

  private async mailplusFormPost<T>(
    params: Record<string, MailPlusParamValue>,
    retryOn401 = true,
  ): Promise<T> {
    const sid = await this.authManager.getToken();
    const body = buildMailPlusFormBody(params);
    const response = await this.fetchMailPlusPost({
      headers: { Cookie: `id=${sid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return await this.unwrapMailPlusEnvelope<T>(response, params, retryOn401, () =>
      this.mailplusFormPost<T>(params, false),
    );
  }

  private async mailplusMultipartPost<T>(
    params: Record<string, MailPlusParamValue>,
    form: FormData,
    retryOn401 = true,
  ): Promise<T> {
    for (const [key, value] of Object.entries(params)) {
      const serialized = serializeMailPlusParam(value);
      if (serialized !== undefined) form.append(key, serialized);
    }

    const sid = await this.authManager.getToken();
    const response = await this.fetchMailPlusPost({
      headers: {
        Cookie: `id=${sid}`,
        ...form.getHeaders(),
      },
      body: form.getBuffer(),
    });
    return await this.unwrapMailPlusEnvelope<T>(response, params, retryOn401, () =>
      this.mailplusMultipartPost<T>(params, form, false),
    );
  }

  private async fetchMailPlusPost(init: {
    headers: Record<string, string>;
    body: URLSearchParams | Buffer;
  }): Promise<FetchResponse> {
    try {
      return await httpFetch(
        `${this.baseUrl}${ENTRY}`,
        {
          method: 'POST',
          headers: init.headers,
          body: init.body,
          signal: AbortSignal.timeout(this.availabilityTimeoutMs),
        },
        this.dispatcher,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NetworkError(`Request timed out after ${this.availabilityTimeoutMs}ms`);
      }
      throw new NetworkError(`Network error: ${msg}`);
    }
  }

  private async unwrapMailPlusEnvelope<T>(
    response: FetchResponse,
    params: Record<string, MailPlusParamValue>,
    retryOn401: boolean,
    retry: () => Promise<T>,
  ): Promise<T> {
    if (response.status === 401) {
      if (retryOn401) {
        this.authManager.invalidate();
        return await retry();
      }
      throw mapSynologyError(119, mailPlusApiName(params));
    }

    if (response.status >= 500) {
      throw new NetworkError(`Synology API HTTP ${response.status}`);
    }

    let envelope: SynologyEnvelope<T>;
    try {
      envelope = (await response.json()) as SynologyEnvelope<T>;
    } catch {
      throw new NetworkError(`Synology API returned non-JSON response (HTTP ${response.status})`);
    }

    if (!envelope.success) {
      const code = envelope.error?.code ?? 100;
      if (retryOn401 && (code === 108 || code === 119)) {
        this.authManager.invalidate();
        return await retry();
      }
      throw mapSynologyError(code, mailPlusApiName(params));
    }

    if (envelope.data === undefined) {
      throw new NetworkError('Synology API returned success=true but no data field');
    }

    return envelope.data;
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
          const content = await this.fetchAttachmentContent(att, opts.message_id);
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
   * @param attachment - Attachment metadata and download identifiers.
   * @param message_id - Parent message ID.
   */
  private async fetchAttachmentContent(
    attachment: SynoMailAttachmentMeta,
    message_id: string,
  ): Promise<Buffer> {
    const sid = await this.authManager.getToken();
    const qs = new URLSearchParams({
      api: 'SYNO.MailClient.Attachment',
      version: '8',
      method: 'download',
      type: 'original',
    });

    if (attachment.md5 !== undefined && attachment.md5.length > 0) {
      qs.set('md5', attachment.md5);
    } else if (
      attachment.msg_path !== undefined &&
      attachment.msg_path.length > 0 &&
      attachment.part_id !== undefined &&
      attachment.part_id.length > 0
    ) {
      qs.set('msg_path', attachment.msg_path);
      qs.set('part_id', attachment.part_id);
      if (attachment.is_cms !== undefined) qs.set('is_cms', String(attachment.is_cms));
    } else {
      qs.set('id', attachment.id);
      qs.set('message_id', message_id);
    }

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
   * Draft payload is submitted as form-urlencoded body; local attachments are
   * uploaded first and referenced by attachment IDs in the draft create call.
   *
   * @param opts - Recipient lists, subject, body, and optional attachments.
   */
  async send(opts: SendMessageOpts): Promise<SynoSendResult> {
    const attachmentIds = await this.uploadAttachments(opts.attachments ?? []);
    const draft = await this.mailplusFormPost<SynoDraftCreateResponse>({
      api: 'SYNO.MailClient.Draft',
      version: 6,
      method: 'create',
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      body_format: opts.body_format ?? 'text',
      cc: opts.cc,
      bcc: opts.bcc,
      attachment: attachmentIds.length > 0 ? attachmentIds : undefined,
      from: opts.account,
    });

    const draftId = extractDraftId(draft);
    const sent = await this.mailplusFormPost<SynoDraftSendResponse>({
      api: 'SYNO.MailClient.Draft',
      version: 6,
      method: 'send',
      id: draftId,
    });

    return {
      message_id: extractSentMessageId(sent) ?? draftId,
      sent_at: extractSentAt(sent) ?? Math.floor(Date.now() / 1000),
    };
  }

  private async uploadAttachments(
    attachments: Array<{ name: string; content_base64: string; mime_type: string }>,
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const attachment of attachments) {
      const form = new FormData();
      const buf = Buffer.from(attachment.content_base64, 'base64');
      form.append('name', attachment.name);
      form.append('is_inline', 'false');
      form.append('file', buf, {
        filename: attachment.name,
        contentType: attachment.mime_type,
      });

      const response = await this.mailplusMultipartPost<SynoAttachmentUploadResponse>(
        {
          api: 'SYNO.MailClient.Attachment',
          version: 7,
          method: 'upload',
        },
        form,
      );
      ids.push(extractUploadedAttachmentId(response));
    }

    return ids;
  }

  /**
   * Mark messages as read/unread/flagged/unflagged.
   *
   * @param opts - message_ids and action.
   */
  async mark(opts: MarkMessagesOpts): Promise<void> {
    const method = opts.action === 'read' || opts.action === 'unread' ? 'set_read' : 'set_star';
    const valueParam =
      method === 'set_read'
        ? { read: opts.action === 'read' }
        : { star: opts.action === 'flag' ? 1 : 0 };

    const params: Record<string, MailPlusParamValue> = {
      api: 'SYNO.MailClient.Message',
      version: 10,
      method,
      id: opts.message_ids,
      ...valueParam,
    };
    if (opts.account !== undefined) params['account'] = opts.account;

    await this.mailplusFormPost<unknown>(params);
  }

  /**
   * Move messages to a destination folder.
   *
   * @param opts - message_ids and dest_folder path.
   */
  async move(opts: MoveMessagesOpts): Promise<void> {
    const mailboxId = await this.resolveMailboxId(opts.dest_folder, opts.account);
    const params: Record<string, MailPlusParamValue> = {
      api: 'SYNO.MailClient.Message',
      version: 10,
      method: 'set_mailbox',
      id: opts.message_ids,
      mailbox_id: mailboxId,
    };
    if (opts.account !== undefined) params['account'] = opts.account;

    await this.mailplusFormPost<unknown>(params);
  }
}

function buildMailPlusFormBody(params: Record<string, MailPlusParamValue>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const serialized = serializeMailPlusParam(value);
    if (serialized !== undefined) body.set(key, serialized);
  }
  return body;
}

function serializeMailPlusParam(value: MailPlusParamValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function mailPlusApiName(params: Record<string, MailPlusParamValue>): string {
  const api = params['api'];
  return typeof api === 'string' ? api : 'SYNO.MailClient';
}

function extractUploadedAttachmentId(response: SynoAttachmentUploadResponse): string {
  const direct = primitiveToString(
    response.id ?? response.attachment_id ?? response.upload_id ?? undefined,
  );
  if (direct.length > 0) return direct;

  const attachment = response.attachment;
  const first = Array.isArray(attachment) ? attachment[0] : attachment;
  if (first !== undefined) return extractUploadedAttachmentId(first);

  throw new NetworkError('MailPlus attachment upload succeeded but returned no attachment id');
}

function extractDraftId(response: SynoDraftCreateResponse): string {
  const id = primitiveToString(
    response.id ??
      response.draft_id ??
      response.message_id ??
      response.draft?.id ??
      response.draft?.draft_id,
  );
  if (id.length > 0) return id;
  throw new NetworkError('MailPlus draft create succeeded but returned no draft id');
}

function extractSentMessageId(response: SynoDraftSendResponse): string | undefined {
  const id = primitiveToString(response.message_id ?? response.id ?? response.message?.id);
  return id.length > 0 ? id : undefined;
}

function extractSentAt(response: SynoDraftSendResponse): number | undefined {
  return response.sent_at ?? response.time ?? response.message?.sent_at ?? response.message?.date;
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
      md5?: unknown;
      msg_path?: unknown;
      part_id?: unknown;
      is_cms?: unknown;
    };
    const name = candidate.name ?? candidate.filename;
    const mimeType = candidate.mime_type ?? candidate.mime ?? candidate.content_type;
    const size = candidate.size ?? candidate.file_size;
    const attachment: SynoMailAttachmentMeta = {
      id: primitiveToString(candidate.id),
      name: typeof name === 'string' && name.length > 0 ? name : 'attachment',
      mime_type:
        typeof mimeType === 'string' && mimeType.length > 0 ? mimeType : 'application/octet-stream',
      size: typeof size === 'number' ? size : 0,
    };

    if (typeof candidate.md5 === 'string' && candidate.md5.length > 0) {
      attachment.md5 = candidate.md5;
    }
    if (typeof candidate.msg_path === 'string' && candidate.msg_path.length > 0) {
      attachment.msg_path = candidate.msg_path;
    }
    if (typeof candidate.part_id === 'string' && candidate.part_id.length > 0) {
      attachment.part_id = candidate.part_id;
    }
    if (typeof candidate.is_cms === 'boolean') {
      attachment.is_cms = candidate.is_cms;
    }

    return attachment;
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
