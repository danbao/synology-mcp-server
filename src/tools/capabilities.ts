/**
 * MCP tool: synology_list_capabilities
 * Reports MCP feature flags, package/API availability, and tool counts.
 */

import { z } from 'zod';
import type { FeatureModule } from './module-metadata.js';
import { MODULE_METADATA } from './module-metadata.js';
import type { ToolDefinition, ToolContext } from './types.js';

const inputSchema = z.object({});

interface ModuleCapability {
  module: FeatureModule;
  name: string;
  tool_prefix: string;
  tool_count: number;
  enabled: boolean;
  checked: boolean;
  api_reachable: boolean | null;
  package_available: boolean | null;
  error?: string;
}

export const synologyListCapabilitiesTool: ToolDefinition<typeof inputSchema> = {
  name: 'synology_list_capabilities',
  description:
    'List enabled MCP modules, package/API availability, and tool counts for this Synology MCP server.',
  inputSchema,
  async handler(_input: z.infer<typeof inputSchema>, ctx: ToolContext) {
    const modules: ModuleCapability[] = [];

    for (const meta of MODULE_METADATA) {
      const enabled = ctx.features[meta.key];
      if (!enabled) {
        modules.push({
          module: meta.key,
          name: meta.displayName,
          tool_prefix: meta.toolPrefix,
          tool_count: 0,
          enabled,
          checked: false,
          api_reachable: null,
          package_available: null,
        });
        continue;
      }

      const availability = await checkAvailability(meta.key, ctx);
      modules.push({
        module: meta.key,
        name: meta.displayName,
        tool_prefix: meta.toolPrefix,
        tool_count: meta.toolCount,
        enabled,
        checked: true,
        api_reachable: availability.available,
        package_available: availability.available,
        ...(availability.error !== undefined ? { error: availability.error } : {}),
      });
    }

    return {
      modules,
      total_tools_enabled:
        modules.reduce((sum, module) => sum + module.tool_count, 0) + 1,
      capability_tool_included: true,
    };
  },
};

async function checkAvailability(
  module: FeatureModule,
  ctx: ToolContext,
): Promise<{ available: boolean; error?: string }> {
  try {
    switch (module) {
      case 'drive':
        return { available: await ctx.driveClient.isAvailable() };
      case 'spreadsheet':
        return { available: await ctx.spreadsheetClient.isAvailable() };
      case 'mailplus':
        return { available: await ctx.mailplusClient.isAvailable() };
      case 'calendar':
        return { available: await ctx.calendarClient.isAvailable() };
      case 'downloadStation':
        return { available: await ctx.downloadStationClient.isAvailable() };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message };
  }
}
