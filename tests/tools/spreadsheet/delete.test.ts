/**
 * Tests for spreadsheet_delete_file tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import {
  createTestContext,
  createTestSpreadsheetIdCache,
  createTestSpreadsheetClient,
  createTestDriveClient,
  createTestMailPlusClient,
  createTestCalendarClient,
} from '../../mocks/test-client-factory.js';
import { spreadsheetDeleteFileTool } from '../../../src/tools/spreadsheet/delete.js';
import type { ToolContext } from '../../../src/tools/types.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_delete_file', () => {
  it('requires confirm=true', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetDeleteFileTool.handler(
      { file_id: 'sheet-001' },
      ctx,
    )) as Record<string, unknown>;
    expect(result['code']).toBe('CONFIRMATION_REQUIRED');
  });

  it('deletes and evicts cache entry', async () => {
    // Build context with a pre-populated cache so we can assert eviction.
    const cache = createTestSpreadsheetIdCache();
    await cache.register('My Sheet', null, 'sheet-001', 'manual');

    const ctx: ToolContext = {
      driveClient: createTestDriveClient(),
      spreadsheetClient: createTestSpreadsheetClient(),
      mailplusClient: createTestMailPlusClient(),
      calendarClient: createTestCalendarClient(),
      spreadsheetIdCache: cache,
    };

    const result = (await spreadsheetDeleteFileTool.handler(
      { file_id: 'sheet-001', confirm: true },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect(result['spreadsheet_id']).toBe('sheet-001');

    const remaining = await cache.list();
    expect(remaining.find((e) => e.spreadsheetId === 'sheet-001')).toBeUndefined();
  });

  it('rejects when both file_id and name missing', () => {
    const parsed = spreadsheetDeleteFileTool.inputSchema.safeParse({ confirm: true });
    expect(parsed.success).toBe(false);
  });

  it('maps 403 to friendly permission hint', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetDeleteFileTool.handler(
      { file_id: 'forbidden', confirm: true },
      ctx,
    )) as Record<string, unknown>;
    expect(result['error']).toBe(true);
    expect(String(result['message'])).toMatch(/permission/i);
  });

  it('maps 404 to friendly Office 3.7.0 hint', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetDeleteFileTool.handler(
      { file_id: 'not-found', confirm: true },
      ctx,
    )) as Record<string, unknown>;
    expect(result['error']).toBe(true);
    expect(String(result['message'])).toMatch(/3\.7\.0|not found/i);
  });
});
