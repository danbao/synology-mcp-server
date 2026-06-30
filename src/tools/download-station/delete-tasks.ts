/**
 * MCP tool: download_delete_tasks
 * Delete one or more Download Station tasks without deleting downloaded files.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { confirmRequiredResponse, moduleUnavailableResponse, toMcpError } from '../types.js';
import { downloadTaskIdsSchema } from './schemas.js';

const inputSchema = z.object({
  task_ids: downloadTaskIdsSchema,
  confirm: z.boolean().describe('REQUIRED: must be true to delete tasks').default(false),
});

export const downloadDeleteTasksTool: ToolDefinition<typeof inputSchema> = {
  name: 'download_delete_tasks',
  description:
    'Delete one or more Download Station tasks. Does not request downloaded file deletion. Set confirm=true to execute.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!input.confirm) {
      return confirmRequiredResponse(`delete Download Station tasks ${input.task_ids.join(',')}`);
    }
    if (!(await ctx.downloadStationClient.isAvailable())) {
      return moduleUnavailableResponse('Download Station');
    }

    try {
      return await ctx.downloadStationClient.deleteTasks(input.task_ids);
    } catch (err) {
      return toMcpError(err);
    }
  },
};
