/**
 * Tests for spreadsheet_rename_sheet tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetRenameSheetTool } from '../../../src/tools/spreadsheet/rename-sheet.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_rename_sheet', () => {
  it('requires confirm=true', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetRenameSheetTool.handler(
      {
        file_id: 'sheet-001',
        sheet_id: 's1',
        new_name: 'Renamed',
        confirm: false,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['error']).toBe(true);
    expect(result['code']).toBe('CONFIRMATION_REQUIRED');
  });

  it('renames sheet when confirmed', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetRenameSheetTool.handler(
      {
        file_id: 'sheet-001',
        sheet_id: 's1',
        new_name: 'Renamed',
        confirm: true,
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect(result['new_name']).toBe('Renamed');
  });

  it('rejects when both file_id and name are missing', () => {
    const parsed = spreadsheetRenameSheetTool.inputSchema.safeParse({
      sheet_id: 's1',
      new_name: 'Renamed',
      confirm: true,
    });
    expect(parsed.success).toBe(false);
  });
});
