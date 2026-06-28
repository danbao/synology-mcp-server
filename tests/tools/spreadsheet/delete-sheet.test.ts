/**
 * Tests for spreadsheet_delete_sheet tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetDeleteSheetTool } from '../../../src/tools/spreadsheet/delete-sheet.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_delete_sheet', () => {
  it('requires confirm=true', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetDeleteSheetTool.handler(
      { file_id: 'sheet-001', sheet_id: 's1', confirm: false },
      ctx,
    )) as Record<string, unknown>;

    expect(result['error']).toBe(true);
    expect(result['code']).toBe('CONFIRMATION_REQUIRED');
  });

  it('deletes sheet when confirmed', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetDeleteSheetTool.handler(
      { file_id: 'sheet-001', sheet_id: 's2', confirm: true },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect(result['deleted_sheet_id']).toBe('s2');
  });

  it('rejects when both file_id and name are missing', () => {
    const parsed = spreadsheetDeleteSheetTool.inputSchema.safeParse({
      sheet_id: 's1',
      confirm: true,
    });
    expect(parsed.success).toBe(false);
  });
});
