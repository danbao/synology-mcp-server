/**
 * MCP tool: spreadsheet_write_styles
 * Bulk overwrite cell formats via dedicated PUT /spreadsheets/{id}/styles endpoint
 * (OpenAPI 3.4.1; requires Synology Office >= 3.7.0).
 *
 * Offset-based (0-based startRow/startCol), distinct from batch_update.updateStyle
 * which uses A1 range + sheetId. Use this for style-only bulk writes; use
 * spreadsheet_batch_update for mixed value+style edits.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { toMcpError } from '../types.js';
import { resolveSpreadsheetId } from '../../utils/spreadsheet-id-resolver.js';
import type { CellFormat } from '../../types/synology-types.js';

const numberFormatSchema = z
  .object({
    type: z.enum(['DEFAULT', 'DATE_TIME', 'DATE', 'TIME', 'TEXT', 'DURATION']).optional(),
    pattern: z.string().optional(),
  })
  .partial();

const textFormatSchema = z
  .object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    color: z.string().optional().describe('Hex color without #, e.g. "ff0000"'),
    name: z.string().optional().describe('Font family name'),
    size: z.number().optional().describe('Font size in points'),
  })
  .partial();

const cellFormatSchema = z
  .object({
    numberFormat: numberFormatSchema.nullable().optional(),
    verticalAlignment: z.enum(['top', 'middle', 'bottom']).nullable().optional(),
    textFormat: textFormatSchema.optional(),
    bg: z.string().nullable().optional().describe('Background color (hex without #)'),
    quotePrefix: z.boolean().optional(),
    horizontalAlignment: z.enum(['left', 'center', 'right']).nullable().optional(),
    wrapStrategy: z.enum(['wrap', 'clip']).nullable().optional(),
    borders: z.array(z.string().nullable()).nullable().optional().describe('Border colors [top,right,bottom,left]'),
  })
  .partial();

const inputSchema = z
  .object({
    file_id: z.string().optional().describe('Alphanumeric Spreadsheet ID (overrides name lookup).'),
    name: z.string().optional().describe('Spreadsheet display name (resolved via local cache).'),
    path: z.string().optional().describe('Optional Drive path to disambiguate same-name files.'),
    sheet_name: z.string().describe('Target sheet name, e.g. "Sheet1"'),
    start_row: z.number().int().min(0).describe('0-based starting row offset'),
    start_col: z.number().int().min(0).describe('0-based starting column offset'),
    styles: z
      .array(z.array(cellFormatSchema))
      .min(1)
      .describe('2D grid; styles[i][j] applies to cell (start_row+i, start_col+j). Must be rectangular.'),
  })
  .refine((v) => (v.file_id ?? '') !== '' || (v.name ?? '') !== '', {
    message: 'Either file_id or name is required',
  })
  .refine(
    (v) => {
      const first = v.styles[0];
      if (first === undefined) return true;
      const width = first.length;
      return width > 0 && v.styles.every((row) => row.length === width);
    },
    { message: 'styles must be a rectangular non-empty 2D grid (all rows same length)' },
  );

/** spreadsheet_write_styles tool definition */
export const spreadsheetWriteStylesTool: ToolDefinition<typeof inputSchema> = {
  name: 'spreadsheet_write_styles',
  description:
    'Bulk overwrite cell styles (fonts, colors, alignment, number formats, borders) for a rectangular block in a Synology Spreadsheet. ' +
    'Uses offset-based PUT /styles endpoint — simpler than batch_update for style-only writes. ' +
    'Requires Synology Office >= 3.7.0. For mixed value+style edits use spreadsheet_batch_update. ' +
    'Provide either file_id or name.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    try {
      const fileId = await resolveSpreadsheetId(input, ctx.spreadsheetIdCache);
      await ctx.spreadsheetClient.writeStyles({
        file_id: fileId,
        sheet_name: input.sheet_name,
        start_row: input.start_row,
        start_col: input.start_col,
        styles: input.styles as CellFormat[][],
      });
      return {
        success: true,
        sheet: input.sheet_name,
        rows_updated: input.styles.length,
        cols_updated: input.styles[0]?.length ?? 0,
      };
    } catch (err) {
      const mapped = toMcpError(err);
      if (mapped.syno_code === 404) {
        mapped.message = `${mapped.message} (endpoint likely requires Synology Office >= 3.7.0)`;
      }
      return mapped;
    }
  },
};
