/**
 * Tests for spreadsheet_register tool.
 */

import { describe, it, expect } from 'vitest';
import { createTestContext } from '../../mocks/test-client-factory.js';
import { spreadsheetRegisterTool } from '../../../src/tools/spreadsheet/register.js';

describe('spreadsheet_register', () => {
  it('registers a manual spreadsheet id mapping', async () => {
    const ctx = createTestContext();
    const result = (await spreadsheetRegisterTool.handler(
      {
        name: 'Budget',
        path: '/mydrive/Budget.osheet',
        spreadsheet_id: 'abc123',
      },
      ctx,
    )) as Record<string, unknown>;

    expect(result['success']).toBe(true);
    expect((result['entry'] as Record<string, unknown>)['spreadsheetId']).toBe('abc123');
    await expect(ctx.spreadsheetIdCache.resolveByName('Budget', '/mydrive/Budget.osheet')).resolves.toBe(
      'abc123',
    );
  });

  it('rejects empty spreadsheet id', () => {
    const parsed = spreadsheetRegisterTool.inputSchema.safeParse({
      name: 'Budget',
      spreadsheet_id: '',
    });
    expect(parsed.success).toBe(false);
  });
});
