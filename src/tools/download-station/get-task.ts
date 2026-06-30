/**
 * MCP tool: download_get_task
 * Get details for one or more Download Station tasks.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { moduleUnavailableResponse, toMcpError } from '../types.js';
import { downloadTaskAdditionalSchema, downloadTaskIdsSchema } from './schemas.js';

const inputSchema = z.object({
  task_ids: downloadTaskIdsSchema,
  additional: downloadTaskAdditionalSchema.describe(
    "Additional task fields to request from Download Station: 'detail', 'transfer', 'file'.",
  ),
});

export const downloadGetTaskTool: ToolDefinition<typeof inputSchema> = {
  name: 'download_get_task',
  description: 'Get details for one or more Download Station tasks by task ID.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!(await ctx.downloadStationClient.isAvailable())) {
      return moduleUnavailableResponse('Download Station');
    }

    try {
      const tasks = await ctx.downloadStationClient.getTasks({
        task_ids: input.task_ids,
        additional: input.additional,
      });
      return { tasks };
    } catch (err) {
      return toMcpError(err);
    }
  },
};
