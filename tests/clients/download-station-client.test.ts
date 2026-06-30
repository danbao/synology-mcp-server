/**
 * Tests for DownloadStationClient — availability and task management APIs.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import {
  allHandlers,
  clearDsmRequestLog,
  dsmRequestLog,
  setDownloadStationAvailable,
} from '../mocks/synology-handlers.js';
import { createTestDownloadStationClient } from '../mocks/test-client-factory.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  setDownloadStationAvailable(true);
  clearDsmRequestLog();
});
afterAll(() => server.close());

describe('DownloadStationClient.isAvailable', () => {
  it('returns true when Download Station package is installed', async () => {
    const client = createTestDownloadStationClient();
    expect(await client.isAvailable()).toBe(true);
  });

  it('returns false when Download Station package is not installed', async () => {
    setDownloadStationAvailable(false);
    const client = createTestDownloadStationClient();
    expect(await client.isAvailable()).toBe(false);
  });

  it('caches the result across multiple calls', async () => {
    const client = createTestDownloadStationClient();
    const first = await client.isAvailable();
    setDownloadStationAvailable(!first);
    const second = await client.isAvailable();
    expect(second).toBe(first);
  });
});

describe('DownloadStationClient task reads', () => {
  it('lists tasks and normalizes additional detail/transfer data', async () => {
    const client = createTestDownloadStationClient();
    const result = await client.listTasks({
      offset: 0,
      limit: 50,
      additional: ['detail', 'transfer'],
    });

    expect(result.total).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      id: 'dbid_001',
      title: 'ubuntu.iso',
      status: 'downloading',
      size: 1024,
      additional: {
        detail: { destination: 'downloads' },
        transfer: { speed_download: 1024 },
      },
    });
    expect(dsmRequestLog).toContainEqual(
      expect.objectContaining({
        api: 'SYNO.DownloadStation.Task',
        method: 'list',
        httpMethod: 'GET',
        source: 'query',
        params: expect.objectContaining({ additional: 'detail,transfer' }),
      }),
    );
  });

  it('gets task details by id', async () => {
    const client = createTestDownloadStationClient();
    const tasks = await client.getTasks({
      task_ids: ['dbid_001'],
      additional: ['detail', 'transfer', 'file'],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.additional?.files?.[0]?.filename).toBe('ubuntu.iso');
    expect(dsmRequestLog).toContainEqual(
      expect.objectContaining({
        api: 'SYNO.DownloadStation.Task',
        method: 'getinfo',
        params: expect.objectContaining({ id: 'dbid_001', additional: 'detail,transfer,file' }),
      }),
    );
  });
});

describe('DownloadStationClient task writes', () => {
  it('creates a URL task using POST form body', async () => {
    const client = createTestDownloadStationClient();
    const result = await client.createTask({
      uri: 'https://example.com/ubuntu.iso',
      destination: 'downloads',
    });

    expect(result).toEqual({ success: true, task_id: 'dbid_002' });
    expect(dsmRequestLog).toContainEqual(
      expect.objectContaining({
        api: 'SYNO.DownloadStation.Task',
        method: 'create',
        httpMethod: 'POST',
        source: 'form',
        params: expect.objectContaining({
          uri: 'https://example.com/ubuntu.iso',
          destination: 'downloads',
        }),
      }),
    );
  });

  it('pauses, resumes, and deletes tasks using POST form body', async () => {
    const client = createTestDownloadStationClient();

    await expect(client.pauseTasks(['dbid_001'])).resolves.toEqual({
      success: true,
      task_ids: ['dbid_001'],
    });
    await expect(client.resumeTasks(['dbid_001'])).resolves.toEqual({
      success: true,
      task_ids: ['dbid_001'],
    });
    await expect(client.deleteTasks(['dbid_001'])).resolves.toEqual({
      success: true,
      task_ids: ['dbid_001'],
    });

    expect(
      dsmRequestLog
        .filter((entry) => entry.api === 'SYNO.DownloadStation.Task' && entry.httpMethod === 'POST')
        .map((entry) => ({
          method: entry.method,
          source: entry.source,
          id: entry.params['id'],
          forceComplete: entry.params['force_complete'],
        })),
    ).toEqual([
      { method: 'pause', source: 'form', id: 'dbid_001', forceComplete: undefined },
      { method: 'resume', source: 'form', id: 'dbid_001', forceComplete: undefined },
      { method: 'delete', source: 'form', id: 'dbid_001', forceComplete: 'false' },
    ]);
  });
});
