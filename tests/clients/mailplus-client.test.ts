/**
 * Tests for MailPlusClient — covers availability probe, listFolders,
 * listMessages, getMessage (with/without attachments), send, mark, move.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import {
  allHandlers,
  clearMailplusRequestLog,
  mailplusRequestLog,
  setMailplusAvailable,
} from '../mocks/synology-handlers.js';
import { createTestMailPlusClient } from '../mocks/test-client-factory.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  setMailplusAvailable(true);
  clearMailplusRequestLog();
});
afterAll(() => server.close());

describe('MailPlusClient.isAvailable', () => {
  it('returns true when MailPlus package is installed', async () => {
    const client = createTestMailPlusClient();
    expect(await client.isAvailable()).toBe(true);
  });

  it('returns false when MailPlus package is not installed', async () => {
    setMailplusAvailable(false);
    const client = createTestMailPlusClient();
    expect(await client.isAvailable()).toBe(false);
  });

  it('caches the result across multiple calls', async () => {
    const client = createTestMailPlusClient();
    const first = await client.isAvailable();
    // Toggle after first call — cached value should still return first result
    setMailplusAvailable(!first);
    const second = await client.isAvailable();
    expect(first).toBe(second);
  });
});

describe('MailPlusClient.listFolders', () => {
  it('returns folder list', async () => {
    const client = createTestMailPlusClient();
    const folders = await client.listFolders();
    expect(Array.isArray(folders)).toBe(true);
    expect(folders.length).toBeGreaterThan(0);
    expect(folders[0]).toHaveProperty('id');
    expect(folders[0]).toHaveProperty('path');
  });

  it('accepts optional account parameter', async () => {
    const client = createTestMailPlusClient();
    const folders = await client.listFolders('user@example.com');
    expect(Array.isArray(folders)).toBe(true);
  });
});

describe('MailPlusClient.listMessages', () => {
  it('returns paginated message list', async () => {
    const client = createTestMailPlusClient();
    const result = await client.listMessages({ folder_path: 'INBOX' });
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages[0]?.id).toBe('1001');
    expect(result.messages[0]?.from.address).toBe('alice@example.com');
  });

  it('applies default options when none provided', async () => {
    const client = createTestMailPlusClient();
    const result = await client.listMessages({});
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('messages');
  });

  it('resolves non-standard folder paths through the Mailbox API', async () => {
    const client = createTestMailPlusClient();
    const result = await client.listMessages({ folder_path: 'Projects' });
    expect(result.total).toBe(1);
    expect(result.messages[0]?.subject).toBe('Hello World');
  });

  it('throws a clear error for unknown folder paths', async () => {
    const client = createTestMailPlusClient();
    await expect(client.listMessages({ folder_path: 'Missing Folder' })).rejects.toMatchObject({
      code: 'MAILBOX_NOT_FOUND',
    });
  });
});

describe('MailPlusClient.getMessage', () => {
  it('returns message detail without attachment content by default', async () => {
    const client = createTestMailPlusClient();
    const msg = await client.getMessage({ message_id: 'msg-001' });
    expect(msg.id).toBe('msg-001');
    expect(msg.body_text).toBeTruthy();
    expect(msg.attachments[0]?.content_base64).toBeNull();
  });

  it('fetches attachment content when include_attachments=true', async () => {
    const client = createTestMailPlusClient();
    const msg = await client.getMessage({ message_id: 'msg-001', include_attachments: true });
    expect(msg.attachments[0]?.content_base64).not.toBeNull();
    // Must be valid base64 string
    expect(typeof msg.attachments[0]?.content_base64).toBe('string');
    const download = mailplusRequestLog.find((entry) => entry.method === 'download');
    expect(download).toMatchObject({
      api: 'SYNO.MailClient.Attachment',
      version: '8',
      source: 'query',
    });
    expect(download?.params['md5']).toBe('mock-md5-001');
  });

  it('throws on not-found message', async () => {
    const client = createTestMailPlusClient();
    await expect(client.getMessage({ message_id: 'not-found' })).rejects.toThrow();
  });
});

describe('MailPlusClient.send', () => {
  it('returns message_id and sent_at on success', async () => {
    const client = createTestMailPlusClient();
    const result = await client.send({
      to: ['recipient@example.com'],
      subject: 'Test',
      body: 'Hello',
    });
    expect(result.message_id).toBe('sent-msg-001');
    expect(result.sent_at).toBe(1700001000);
    expect(mailplusRequestLog.filter((entry) => entry.api === 'SYNO.MailClient.Draft')).toEqual([
      expect.objectContaining({ method: 'create', version: '6', source: 'form' }),
      expect.objectContaining({ method: 'send', version: '6', source: 'form' }),
    ]);
  });

  it('uploads attachment before creating and sending draft', async () => {
    const client = createTestMailPlusClient();
    const result = await client.send({
      to: ['recipient@example.com'],
      subject: 'With attachment',
      body: 'See attached',
      attachments: [
        {
          name: 'test.txt',
          content_base64: Buffer.from('hello').toString('base64'),
          mime_type: 'text/plain',
        },
      ],
    });
    expect(result.message_id).toBeDefined();
    const upload = mailplusRequestLog.find((entry) => entry.method === 'upload');
    expect(upload).toMatchObject({
      api: 'SYNO.MailClient.Attachment',
      version: '7',
      source: 'multipart',
    });
    expect(upload?.params['is_inline']).toBe('false');
    const create = mailplusRequestLog.find(
      (entry) => entry.api === 'SYNO.MailClient.Draft' && entry.method === 'create',
    );
    expect(create?.params['attachment']).toBe('["uploaded-att-001"]');
  });
});

describe('MailPlusClient.mark', () => {
  it('uses Message.set_read v10 for read/unread actions', async () => {
    const client = createTestMailPlusClient();
    await expect(
      client.mark({ message_ids: ['msg-001'], action: 'read' }),
    ).resolves.toBeUndefined();
    await expect(
      client.mark({ message_ids: ['msg-002'], action: 'unread' }),
    ).resolves.toBeUndefined();
    expect(mailplusRequestLog.filter((entry) => entry.api === 'SYNO.MailClient.Message')).toEqual([
      expect.objectContaining({
        method: 'set_read',
        version: '10',
        source: 'form',
        params: expect.objectContaining({ id: '["msg-001"]', read: 'true' }),
      }),
      expect.objectContaining({
        method: 'set_read',
        version: '10',
        source: 'form',
        params: expect.objectContaining({ id: '["msg-002"]', read: 'false' }),
      }),
    ]);
  });

  it('uses Message.set_star v10 for flag/unflag actions', async () => {
    const client = createTestMailPlusClient();
    await expect(
      client.mark({ message_ids: ['msg-001'], action: 'flag' }),
    ).resolves.toBeUndefined();
    await expect(
      client.mark({ message_ids: ['msg-002'], action: 'unflag' }),
    ).resolves.toBeUndefined();
    expect(mailplusRequestLog.filter((entry) => entry.api === 'SYNO.MailClient.Message')).toEqual([
      expect.objectContaining({
        method: 'set_star',
        version: '10',
        source: 'form',
        params: expect.objectContaining({ id: '["msg-001"]', star: '1' }),
      }),
      expect.objectContaining({
        method: 'set_star',
        version: '10',
        source: 'form',
        params: expect.objectContaining({ id: '["msg-002"]', star: '0' }),
      }),
    ]);
  });
});

describe('MailPlusClient.move', () => {
  it('resolves mailbox path and uses Message.set_mailbox v10', async () => {
    const client = createTestMailPlusClient();
    await expect(
      client.move({ message_ids: ['msg-001'], dest_folder: 'Archive' }),
    ).resolves.toBeUndefined();
    const move = mailplusRequestLog.find((entry) => entry.method === 'set_mailbox');
    expect(move).toMatchObject({
      api: 'SYNO.MailClient.Message',
      version: '10',
      source: 'form',
      params: expect.objectContaining({ id: '["msg-001"]', mailbox_id: '-2' }),
    });
  });

  it('returns MAILBOX_NOT_FOUND for unknown destination folder', async () => {
    const client = createTestMailPlusClient();
    await expect(
      client.move({ message_ids: ['msg-001'], dest_folder: 'Missing Folder' }),
    ).rejects.toMatchObject({
      code: 'MAILBOX_NOT_FOUND',
    });
  });
});
