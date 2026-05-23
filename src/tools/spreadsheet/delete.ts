/**
 * MCP tool: spreadsheet_delete_file
 *
 * Permanently delete an ENTIRE spreadsheet file (.osheet) via POST /spreadsheets/delete
 * (OpenAPI 3.4.1; requires Synology Office >= 3.7.0).
 *
 * Distinct from `spreadsheet_delete_sheet` (which removes only one tab inside a file).
 * Also evicts the file from the local name cache so subsequent name lookups won't return
 * a stale ID. File may land in DSM Recycle Bin if enabled.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { toMcpError, confirmRequiredResponse } from '../types.js';
import { resolveSpreadsheetId } from '../../utils/spreadsheet-id-resolver.js';

const inputSchema = z
  .object({
    file_id: z.string().optional().describe('Alphanumeric Spreadsheet ID (overrides name lookup).'),
    name: z.string().optional().describe('Spreadsheet display name (resolved via local cache).'),
    path: z.string().optional().describe('Optional Drive path to disambiguate same-name files.'),
    confirm: z.boolean().default(false).describe('Must be true to actually delete.'),
  })
  .refine((v) => (v.file_id ?? '') !== '' || (v.name ?? '') !== '', {
    message: 'Either file_id or name is required',
  });

/** spreadsheet_delete_file tool definition */
export const spreadsheetDeleteFileTool: ToolDefinition<typeof inputSchema> = {
  name: 'spreadsheet_delete_file',
  description:
    'WARNING: Permanently delete an ENTIRE spreadsheet file (.osheet). ' +
    'Different from spreadsheet_delete_sheet which removes only one tab inside a file. ' +
    'Uses the dedicated Spreadsheet API endpoint (Synology Office >= 3.7.0) and also evicts ' +
    'the file from the local name cache. For non-spreadsheet files use drive_delete. ' +
    'Provide either file_id or name; set confirm=true to execute.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!input.confirm) {
      return confirmRequiredResponse(`permanently delete spreadsheet file (${input.file_id ?? input.name})`);
    }

    try {
      const fileId = await resolveSpreadsheetId(input, ctx.spreadsheetIdCache);
      const result = await ctx.spreadsheetClient.deleteSpreadsheet(fileId);
      await ctx.spreadsheetIdCache.unregister(fileId);
      return {
        success: true,
        spreadsheet_id: result.spreadsheetId,
      };
    } catch (err) {
      const mapped = toMcpError(err);
      if (mapped.syno_code === 404) {
        mapped.message = `${mapped.message} (file not found, or endpoint requires Synology Office >= 3.7.0)`;
      } else if (mapped.syno_code === 403) {
        mapped.message = `${mapped.message} (user lacks delete permission on this file)`;
      }
      return mapped;
    }
  },
};
