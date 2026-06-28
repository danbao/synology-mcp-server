/**
 * Tests for Streamable HTTP transport Bearer auth, Origin guard, and sessions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { createTestContext } from '../mocks/test-client-factory.js';
import { createServer } from '../../src/server/create-server.js';
import { startStreamableHttpTransport } from '../../src/server/transport-streamable-http.js';
import { aggregateTools } from '../../src/tools/index.js';

const FEATURES = { drive: false, spreadsheet: false, mailplus: false, calendar: false };
const TEST_TOKEN = 'test-secret-token-xyz';
const MCP_PATH = '/mcp';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  destroyOnHeaders = false,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(payload !== undefined ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (res) => {
        if (destroyOnHeaders) {
          const result = { status: res.statusCode ?? 0, headers: res.headers, body: '' };
          resolve(result);
          res.destroy();
          req.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (destroyOnHeaders && (code === 'ECONNRESET' || code === 'ECONNABORTED')) return;
      reject(err);
    });
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

function initializeRequest(id = 1): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'transport-test', version: '1.0.0' },
    },
  };
}

let closeFn: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (closeFn !== undefined) {
    await closeFn();
    closeFn = undefined;
  }
});

function startServer(allowedOrigins?: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const tools = aggregateTools(FEATURES);
    const ctx = createTestContext();
    const makeServer = () => createServer(tools, ctx);

    const { httpServer, close } = startStreamableHttpTransport(makeServer, {
      host: '127.0.0.1',
      port: 0,
      path: MCP_PATH,
      authToken: TEST_TOKEN,
      allowedOrigins: allowedOrigins ?? [],
    });
    closeFn = close;

    httpServer.on('error', reject);
    httpServer.once('listening', () => {
      const addr = httpServer.address();
      if (addr !== null && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('Could not get server port'));
      }
    });
  });
}

describe('Streamable HTTP transport — Bearer auth required', () => {
  it('rejects POST /mcp with no Authorization header', async () => {
    const port = await startServer();
    const res = await request(port, 'POST', MCP_PATH, {}, initializeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects POST /mcp with wrong token', async () => {
    const port = await startServer();
    const res = await request(
      port,
      'POST',
      MCP_PATH,
      { Authorization: 'Bearer wrong-token' },
      initializeRequest(),
    );
    expect(res.status).toBe(401);
  });

  it('accepts initialize POST with correct token and returns a session id', async () => {
    const port = await startServer();
    const res = await request(
      port,
      'POST',
      MCP_PATH,
      { Authorization: `Bearer ${TEST_TOKEN}`, Accept: 'application/json, text/event-stream' },
      initializeRequest(),
    );
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toEqual(expect.any(String));
  });
});

describe('Streamable HTTP transport — Origin guard', () => {
  it('rejects request with disallowed Origin header', async () => {
    const port = await startServer([]);
    const res = await request(
      port,
      'POST',
      MCP_PATH,
      {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Origin: 'http://evil.example.com',
        Accept: 'application/json, text/event-stream',
      },
      initializeRequest(),
    );
    expect(res.status).toBe(403);
  });

  it('allows request with matching Origin header', async () => {
    const port = await startServer(['http://trusted.example.com']);
    const res = await request(
      port,
      'POST',
      MCP_PATH,
      {
        Authorization: `Bearer ${TEST_TOKEN}`,
        Origin: 'http://trusted.example.com',
        Accept: 'application/json, text/event-stream',
      },
      initializeRequest(),
    );
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toEqual(expect.any(String));
  });
});

describe('Streamable HTTP transport — sessions and routing', () => {
  it('supports initialized POST, GET stream, and DELETE session close', async () => {
    const port = await startServer();
    const init = await request(
      port,
      'POST',
      MCP_PATH,
      { Authorization: `Bearer ${TEST_TOKEN}`, Accept: 'application/json, text/event-stream' },
      initializeRequest(),
    );
    const sessionId = String(init.headers['mcp-session-id']);

    const initialized = await request(
      port,
      'POST',
      MCP_PATH,
      {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId,
        Accept: 'application/json, text/event-stream',
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    );
    expect([200, 202]).toContain(initialized.status);

    const stream = await request(
      port,
      'GET',
      MCP_PATH,
      {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Mcp-Session-Id': sessionId,
        Accept: 'text/event-stream',
      },
      undefined,
      true,
    );
    expect(stream.status).toBe(200);

    const deleted = await request(port, 'DELETE', MCP_PATH, {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Mcp-Session-Id': sessionId,
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await request(port, 'GET', MCP_PATH, {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Mcp-Session-Id': sessionId,
      Accept: 'text/event-stream',
    });
    expect(afterDelete.status).toBe(404);
  });

  it('rejects follow-up requests without a session id', async () => {
    const port = await startServer();
    const res = await request(port, 'GET', MCP_PATH, {
      Authorization: `Bearer ${TEST_TOKEN}`,
      Accept: 'text/event-stream',
    });
    expect(res.status).toBe(400);
  });

  it('does not expose legacy SSE routes', async () => {
    const port = await startServer();
    const sse = await request(port, 'GET', '/sse', { Authorization: `Bearer ${TEST_TOKEN}` });
    const messages = await request(port, 'POST', '/messages', { Authorization: `Bearer ${TEST_TOKEN}` });
    expect(sse.status).toBe(404);
    expect(messages.status).toBe(404);
  });
});
