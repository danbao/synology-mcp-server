/**
 * Unit tests for SpreadsheetClient.
 * Uses MSW to intercept HTTP calls to the Synology API.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import {
  allHandlers,
  clearSpreadsheetRequestLog,
  spreadsheetRequestLog,
} from '../mocks/synology-handlers.js';
import { createTestSpreadsheetClient, TEST_CONFIG } from '../mocks/test-client-factory.js';
import { SpreadsheetAuthManager } from '../../src/auth/spreadsheet-auth-manager.js';
import { SpreadsheetClient } from '../../src/clients/spreadsheet-client.js';

const server = setupServer(...allHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  clearSpreadsheetRequestLog();
});
afterAll(() => server.close());

describe('SpreadsheetClient.getInfo', () => {
  it('returns spreadsheet metadata', async () => {
    const client = createTestSpreadsheetClient();
    const info = await client.getInfo('sheet-001');
    expect(info.file_id).toBe('sheet-001');
    expect(info.sheets).toHaveLength(2);
    expect(info.sheets[0]?.name).toBe('Sheet1');
  });

  it('throws on not-found file_id', async () => {
    const client = createTestSpreadsheetClient();
    await expect(client.getInfo('not-found')).rejects.toThrow();
  });
});

describe('SpreadsheetClient.getCells', () => {
  it('returns cell data', async () => {
    const client = createTestSpreadsheetClient();
    const data = await client.getCells({ file_id: 'sheet-001' });
    expect(data.sheet_name).toBe('Sheet1');
    expect(data.values).toHaveLength(3);
  });

  it('accepts optional sheet_name and range', async () => {
    const client = createTestSpreadsheetClient();
    const data = await client.getCells({
      file_id: 'sheet-001',
      sheet_name: 'Sheet1',
      range: 'A1:D3',
      include_formulas: false,
    });
    expect(data.range).toBe('Sheet1!A1:D3');
  });

  it('throws on not-found file_id', async () => {
    const client = createTestSpreadsheetClient();
    await expect(client.getCells({ file_id: 'not-found' })).rejects.toThrow();
  });
});

describe('SpreadsheetClient.setCells', () => {
  it('returns success=true', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.setCells({
      file_id: 'sheet-001',
      sheet_name: 'Sheet1',
      start_cell: 'A1',
      values: [['Hello', 'World']],
    });
    expect(result.success).toBe(true);
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'PUT',
      path: '/spreadsheets/sheet-001/values/Sheet1!A1%3AB1',
      body: { values: [['Hello', 'World']] },
    });
  });

  it('throws on not-found file_id', async () => {
    const client = createTestSpreadsheetClient();
    await expect(
      client.setCells({
        file_id: 'not-found',
        sheet_name: 'Sheet1',
        start_cell: 'A1',
        values: [['x']],
      }),
    ).rejects.toThrow();
  });
});

describe('SpreadsheetClient.create', () => {
  it('returns new file_id', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.create({ name: 'NewSheet' });
    expect(result.file_id).toBe('new-sheet-001');
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'POST',
      path: '/spreadsheets/create',
      body: { name: 'NewSheet' },
    });
  });

  it('authorizes with dedicated Spreadsheet credentials when configured', async () => {
    const config = {
      ...TEST_CONFIG,
      otpSecret: 'GEZDGNBVGY3TQOJQ',
      spreadsheetUsername: 'office-bot',
      spreadsheetPassword: 'office-secret',
    };
    const client = new SpreadsheetClient(config, new SpreadsheetAuthManager(config));
    const result = await client.create({ name: 'NewSheet' });
    expect(result.file_id).toBe('new-sheet-001');
    expect(spreadsheetRequestLog[0]).toMatchObject({
      httpMethod: 'POST',
      path: '/spreadsheets/authorize',
      body: {
        username: 'office-bot',
        password: 'office-secret',
        host: 'nas.local:5000',
        protocol: 'http',
      },
    });
  });

  it('fails before /authorize when main DSM account uses OTP without dedicated Spreadsheet credentials', async () => {
    const config = {
      ...TEST_CONFIG,
      otpSecret: 'GEZDGNBVGY3TQOJQ',
    };
    const client = new SpreadsheetClient(config, new SpreadsheetAuthManager(config));

    await expect(client.create({ name: 'NewSheet' })).rejects.toThrow(/SYNO_SS_USERNAME/);
    expect(spreadsheetRequestLog).toHaveLength(0);
  });
});

describe('SpreadsheetClient.addSheet', () => {
  it('returns success and sheet_id', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.addSheet({
      file_id: 'sheet-001',
      sheet_name: 'NewTab',
    });
    expect(result.success).toBe(true);
    expect(result.sheet_id).toBe('new-sheet-tab-001');
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'POST',
      path: '/spreadsheets/sheet-001/sheet/add',
      body: { sheetName: 'NewTab' },
    });
  });

  it('throws on not-found file_id', async () => {
    const client = createTestSpreadsheetClient();
    await expect(client.addSheet({ file_id: 'not-found', sheet_name: 'Tab' })).rejects.toThrow();
  });
});

describe('SpreadsheetClient.exportFile', () => {
  it('returns binary buffer with metadata', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.exportFile({ file_id: 'sheet-001', format: 'xlsx' });
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.file_name).toBe('Budget.xlsx');
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'GET',
      path: '/spreadsheets/sheet-001/xlsx',
    });
  });
});

describe('SpreadsheetClient.writeStyles', () => {
  it('returns success on PUT /styles', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.writeStyles({
      file_id: 'sheet-001',
      sheet_name: 'Sheet1',
      start_row: 0,
      start_col: 0,
      styles: [[{ textFormat: { bold: true } }]],
    });
    expect(result.success).toBe(true);
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'PUT',
      path: '/spreadsheets/sheet-001/styles',
      body: {
        sheetName: 'Sheet1',
        startRow: 0,
        startCol: 0,
        rows: [{ values: [{ userEnteredFormat: { textFormat: { bold: true } } }] }],
      },
    });
  });

  it('throws on 404 endpoint', async () => {
    const client = createTestSpreadsheetClient();
    await expect(
      client.writeStyles({
        file_id: 'not-found',
        sheet_name: 'Sheet1',
        start_row: 0,
        start_col: 0,
        styles: [[{ textFormat: { bold: true } }]],
      }),
    ).rejects.toThrow();
  });
});

describe('SpreadsheetClient.deleteSpreadsheet', () => {
  it('echoes the deleted spreadsheetId', async () => {
    const client = createTestSpreadsheetClient();
    const result = await client.deleteSpreadsheet('sheet-001');
    expect(result.spreadsheetId).toBe('sheet-001');
    expect(spreadsheetRequestLog.at(-1)).toMatchObject({
      httpMethod: 'POST',
      path: '/spreadsheets/delete',
      body: { spreadsheetId: 'sheet-001' },
    });
  });

  it('throws on 404', async () => {
    const client = createTestSpreadsheetClient();
    await expect(client.deleteSpreadsheet('not-found')).rejects.toThrow();
  });

  it('throws on 403 forbidden', async () => {
    const client = createTestSpreadsheetClient();
    await expect(client.deleteSpreadsheet('forbidden')).rejects.toThrow();
  });
});
