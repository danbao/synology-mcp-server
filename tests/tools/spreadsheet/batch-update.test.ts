/**
 * Tests for spreadsheet_batch_update tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetBatchUpdateTool } from '../../../src/tools/spreadsheet/batch-update.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_batch_update', () => {
  it('requires confirm=true', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetBatchUpdateTool.handler(
      {
        file_id: 'sheet-001',
        sheet_id: 's1',
        action: 'insert_rows',
        index: 1,
        count: 2,
        confirm: false,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['error']).toBe(true);
    expect(result['code']).toBe('CONFIRMATION_REQUIRED');
  });

  it('runs batch update when confirmed', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetBatchUpdateTool.handler(
      {
        file_id: 'sheet-001',
        sheet_id: 's1',
        action: 'delete_columns',
        index: 3,
        count: 1,
        confirm: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect(result['action']).toBe('delete_columns');
    expect(result['index']).toBe(3);
    expect(result['count']).toBe(1);
  });

  it('rejects when both file_id and name are missing', () => {
    const parsed = spreadsheetBatchUpdateTool.inputSchema.safeParse({
      sheet_id: 's1',
      action: 'insert_rows',
      index: 0,
      count: 1,
      confirm: true,
    });
    expect(parsed.success).toBe(false);
  });
});
