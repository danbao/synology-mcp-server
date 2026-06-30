/**
 * MCP tool: download_list_tasks
 * List Download Station tasks with pagination and optional status filtering.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { moduleUnavailableResponse, toMcpError } from '../types.js';
import { downloadTaskAdditionalSchema, downloadTaskStatusSchema } from './schemas.js';

const inputSchema = z.object({
  offset: z.number().int().min(0).describe('Pagination offset').default(0),
  limit: z.number().int().min(1).max(1000).describe('Maximum number of tasks').default(50),
  status: downloadTaskStatusSchema.optional().describe('Optional client-side task status filter.'),
  additional: downloadTaskAdditionalSchema.describe(
    "Additional task fields to request from Download Station: 'detail', 'transfer', 'file'.",
  ),
});

export const downloadListTasksTool: ToolDefinition<typeof inputSchema> = {
  name: 'download_list_tasks',
  description: 'List Download Station tasks with pagination and optional status filtering.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!(await ctx.downloadStationClient.isAvailable())) {
      return moduleUnavailableResponse('Download Station');
    }

    try {
      return await ctx.downloadStationClient.listTasks({
        offset: input.offset,
        limit: input.limit,
        ...(input.status !== undefined ? { status: input.status } : {}),
        additional: input.additional,
      });
    } catch (err) {
      return toMcpError(err);
    }
  },
};
