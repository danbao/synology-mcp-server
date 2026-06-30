/**
 * Tests for Download Station MCP tools.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers, setDownloadStationAvailable } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { downloadListTasksTool } from '../../../src/tools/download-station/list-tasks.js';
import { downloadGetTaskTool } from '../../../src/tools/download-station/get-task.js';
import { downloadCreateTaskTool } from '../../../src/tools/download-station/create-task.js';
import { downloadPauseTasksTool } from '../../../src/tools/download-station/pause-tasks.js';
import { downloadResumeTasksTool } from '../../../src/tools/download-station/resume-tasks.js';
import { downloadDeleteTasksTool } from '../../../src/tools/download-station/delete-tasks.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  setDownloadStationAvailable(true);
});
afterAll(() => server.close());

describe('Download Station read tools', () => {
  it('lists tasks', async () => {
    const ctx = createTestContext();
    const result = (await downloadListTasksTool.handler(
      { offset: 0, limit: 50, additional: ['detail', 'transfer'] },
      ctx,
    )) as Record<string, unknown>;

    expect(result['total']).toBe(1);
    expect(Array.isArray(result['tasks'])).toBe(true);
  });

  it('gets task details', async () => {
    const ctx = createTestContext();
    const result = (await downloadGetTaskTool.handler(
      { task_ids: ['dbid_001'], additional: ['detail', 'transfer', 'file'] },
      ctx,
    )) as Record<string, unknown>;

    expect(Array.isArray(result['tasks'])).toBe(true);
  });

  it('returns MODULE_UNAVAILABLE when Download Station is not installed', async () => {
    setDownloadStationAvailable(false);
    const ctx = createTestContext();
    const result = (await downloadListTasksTool.handler(
      { offset: 0, limit: 50, additional: ['detail', 'transfer'] },
      ctx,
    )) as Record<string, unknown>;

    expect(result['error']).toBe(true);
    expect(result['code']).toBe('MODULE_UNAVAILABLE');
    expect(result['message']).toBe('Download Station is not installed on this NAS.');
  });
});

describe('Download Station write tools', () => {
  it('requires confirm=true for create/pause/resume/delete', async () => {
    const ctx = createTestContext();

    await expect(
      downloadCreateTaskTool.handler({ uri: 'https://example.com/ubuntu.iso' }, ctx),
    ).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      downloadPauseTasksTool.handler({ task_ids: ['dbid_001'] }, ctx),
    ).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      downloadResumeTasksTool.handler({ task_ids: ['dbid_001'] }, ctx),
    ).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await expect(
      downloadDeleteTasksTool.handler({ task_ids: ['dbid_001'] }, ctx),
    ).resolves.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
  });

  it('creates, pauses, resumes, and deletes tasks when confirmed', async () => {
    const ctx = createTestContext();

    await expect(
      downloadCreateTaskTool.handler(
        {
          uri: 'https://example.com/ubuntu.iso',
          destination: 'downloads',
          confirm: true,
        },
        ctx,
      ),
    ).resolves.toMatchObject({ success: true, task_id: 'dbid_002' });

    await expect(
      downloadPauseTasksTool.handler({ task_ids: ['dbid_001'], confirm: true }, ctx),
    ).resolves.toMatchObject({ success: true, task_ids: ['dbid_001'] });
    await expect(
      downloadResumeTasksTool.handler({ task_ids: ['dbid_001'], confirm: true }, ctx),
    ).resolves.toMatchObject({ success: true, task_ids: ['dbid_001'] });
    await expect(
      downloadDeleteTasksTool.handler({ task_ids: ['dbid_001'], confirm: true }, ctx),
    ).resolves.toMatchObject({ success: true, task_ids: ['dbid_001'] });
  });
});
