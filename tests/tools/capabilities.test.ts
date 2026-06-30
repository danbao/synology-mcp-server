/**
 * Tests for synology_list_capabilities tool.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { allHandlers, setDownloadStationAvailable } from '../mocks/synology-handlers.js';
import { createTestContext } from '../mocks/test-client-factory.js';
import { synologyListCapabilitiesTool } from '../../src/tools/capabilities.js';

const server = setupServer(...allHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  setDownloadStationAvailable(true);
});
afterAll(() => server.close());

describe('synology_list_capabilities', () => {
  it('reports enabled module availability and tool counts', async () => {
    const ctx = createTestContext();
    const result = (await synologyListCapabilitiesTool.handler({}, ctx)) as {
      modules: Array<Record<string, unknown>>;
      total_tools_enabled: number;
      capability_tool_included: boolean;
    };

    expect(result.capability_tool_included).toBe(true);
    expect(result.total_tools_enabled).toBe(46);
    const download = result.modules.find((module) => module['module'] === 'downloadStation');
    expect(download).toMatchObject({
      enabled: true,
      checked: true,
      api_reachable: true,
      package_available: true,
      tool_count: 6,
    });
  });

  it('reports disabled modules without probing availability', async () => {
    const ctx = createTestContext();
    ctx.features.downloadStation = false;
    setDownloadStationAvailable(false);

    const result = (await synologyListCapabilitiesTool.handler({}, ctx)) as {
      modules: Array<Record<string, unknown>>;
    };

    const download = result.modules.find((module) => module['module'] === 'downloadStation');
    expect(download).toMatchObject({
      enabled: false,
      checked: false,
      api_reachable: null,
      package_available: null,
      tool_count: 0,
    });
  });

  it('reports unavailable enabled packages', async () => {
    setDownloadStationAvailable(false);
    const ctx = createTestContext();

    const result = (await synologyListCapabilitiesTool.handler({}, ctx)) as {
      modules: Array<Record<string, unknown>>;
    };

    const download = result.modules.find((module) => module['module'] === 'downloadStation');
    expect(download).toMatchObject({
      enabled: true,
      checked: true,
      api_reachable: false,
      package_available: false,
      tool_count: 6,
    });
  });
});
