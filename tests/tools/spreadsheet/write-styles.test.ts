/**
 * Tests for spreadsheet_write_styles tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetWriteStylesTool } from '../../../src/tools/spreadsheet/write-styles.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_write_styles', () => {
  it('writes a rectangular style block', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetWriteStylesTool.handler(
      {
        file_id: 'sheet-001',
        sheet_name: 'Sheet1',
        start_row: 0,
        start_col: 0,
        styles: [
          [{ textFormat: { bold: true } }, { textFormat: { bold: true } }],
          [{ bg: 'ffff00' }, { bg: 'ffff00' }],
        ],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect(result['rows_updated']).toBe(2);
    expect(result['cols_updated']).toBe(2);
  });

  it('rejects non-rectangular styles via Zod', () => {
    const parsed = spreadsheetWriteStylesTool.inputSchema.safeParse({
      file_id: 'sheet-001',
      sheet_name: 'Sheet1',
      start_row: 0,
      start_col: 0,
      styles: [
        [{ textFormat: { bold: true } }, { textFormat: { bold: true } }],
        [{ bg: 'ffff00' }],
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects when both file_id and name missing', () => {
    const parsed = spreadsheetWriteStylesTool.inputSchema.safeParse({
      sheet_name: 'Sheet1',
      start_row: 0,
      start_col: 0,
      styles: [[{ textFormat: { bold: true } }]],
    });
    expect(parsed.success).toBe(false);
  });

  it('maps 404 to friendly Office 3.7.0 hint', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetWriteStylesTool.handler(
      {
        file_id: 'not-found',
        sheet_name: 'Sheet1',
        start_row: 0,
        start_col: 0,
        styles: [[{ textFormat: { bold: true } }]],
      },
      ctx,
    )) as Record<string, unknown>;
    expect(result['error']).toBe(true);
  });
});
