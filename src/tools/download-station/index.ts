/**
 * Aggregates all Download Station tool definitions into a single exported array.
 */

import { downloadListTasksTool } from './list-tasks.js';
import { downloadGetTaskTool } from './get-task.js';
import { downloadCreateTaskTool } from './create-task.js';
import { downloadPauseTasksTool } from './pause-tasks.js';
import { downloadResumeTasksTool } from './resume-tasks.js';
import { downloadDeleteTasksTool } from './delete-tasks.js';
import type { ToolDefinition } from '../types.js';

/** All 6 Download Station tool definitions, ready for MCP server registration. */
export const downloadStationTools: ToolDefinition[] = [
  downloadListTasksTool,
  downloadGetTaskTool,
  downloadCreateTaskTool,
  downloadPauseTasksTool,
  downloadResumeTasksTool,
  downloadDeleteTasksTool,
];
