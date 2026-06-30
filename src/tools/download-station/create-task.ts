/**
 * MCP tool: download_create_task
 * Create a Download Station URL or magnet download task.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types.js';
import { confirmRequiredResponse, moduleUnavailableResponse, toMcpError } from '../types.js';

const inputSchema = z.object({
  uri: z
    .string()
    .min(1)
    .describe('HTTP/HTTPS/FTP URL or magnet URI to add to Download Station.'),
  destination: z
    .string()
    .min(1)
    .optional()
    .describe('Optional Download Station destination folder name/path.'),
  confirm: z.boolean().describe('REQUIRED: must be true to create the task').default(false),
});

export const downloadCreateTaskTool: ToolDefinition<typeof inputSchema> = {
  name: 'download_create_task',
  description:
    'Create a Download Station URL or magnet download task. Set confirm=true to execute.',
  inputSchema,
  async handler(input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    if (!input.confirm) {
      return confirmRequiredResponse(`create Download Station task for '${input.uri}'`);
    }
    if (!(await ctx.downloadStationClient.isAvailable())) {
      return moduleUnavailableResponse('Download Station');
    }

    try {
      return await ctx.downloadStationClient.createTask({
        uri: input.uri,
        ...(input.destination !== undefined ? { destination: input.destination } : {}),
      });
    } catch (err) {
      return toMcpError(err);
    }
  },
};
