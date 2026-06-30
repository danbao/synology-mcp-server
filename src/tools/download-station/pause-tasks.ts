/**
 * MCP tool: download_pause_tasks
 * Pause one or more Download Station tasks.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { confirmRequiredResponse, moduleUnavailableResponse, toMcpError } from '../types.js';
import { downloadTaskIdsSchema } from './schemas.js';

const inputSchema = z.object({
  task_ids: downloadTaskIdsSchema,
  confirm: z.boolean().describe('REQUIRED: must be true to pause tasks').default(false),
});

export const downloadPauseTasksTool: ToolDefinition<typeof inputSchema> = {
  name: 'download_pause_tasks',
  description: 'Pause one or more Download Station tasks. Set confirm=true to execute.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!input.confirm) {
      return confirmRequiredResponse(`pause Download Station tasks ${input.task_ids.join(',')}`);
    }
    if (!(await ctx.downloadStationClient.isAvailable())) {
      return moduleUnavailableResponse('Download Station');
    }

    try {
      return await ctx.downloadStationClient.pauseTasks(input.task_ids);
    } catch (err) {
      return toMcpError(err);
    }
  },
};
