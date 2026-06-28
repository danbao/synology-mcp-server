/**
 * Tests for spreadsheet_get_styles tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers } from '../../mocks/synology-handlers.js';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetGetStylesTool } from '../../../src/tools/spreadsheet/get-styles.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('spreadsheet_get_styles', () => {
  it('returns style grid for a range', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetGetStylesTool.handler(
      { file_id: 'sheet-001', sheet_name: 'Sheet1', range: 'A1:B2' },
      ctx,
    )) as Record<string, unknown>;

    expect(result['sheet']).toBe('Sheet1');
    expect(result['range']).toBe('Sheet1!A1:B2');
    expect(Array.isArray(result['styles'])).toBe(true);
  });

  it('rejects when both file_id and name are missing', () => {
    const parsed = spreadsheetGetStylesTool.inputSchema.safeParse({
      sheet_name: 'Sheet1',
      range: 'A1:B2',
    });
    expect(parsed.success).toBe(false);
  });
});
