/**
 * Streamable HTTP transport bootstrap for the MCP server.
 * Hosts a single MCP endpoint (default: /mcp) with POST, GET, and DELETE.
 */

import * as http from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { verifyBearer } from '../utils/bearer-auth.js';
import { isOriginAllowed } from '../utils/origin-guard.js';

interface SessionRecord {
  transport: StreamableHTTPServerTransport;
  server: Server;
  closed: boolean;
}

/** Options for starting the Streamable HTTP transport. */
export interface StreamableHttpTransportOptions {
  host: string;
  port: number;
  path: string;
  authToken: string;
  /** Exact Origin values allowed when the request includes an Origin header. */
  allowedOrigins?: string[];
}

/**
 * Starts an HTTP server hosting the MCP Streamable HTTP transport.
 *
 * @param createMcpServer - Factory that creates a fresh MCP Server per session.
 * @param opts - Bind host/port/path, required auth token, optional origins.
 * @returns Object with `httpServer` and `close()` for graceful shutdown.
 */
export function startStreamableHttpTransport(
  createMcpServer: () => Server,
  opts: StreamableHttpTransportOptions,
): { httpServer: http.Server; close: () => Promise<void> } {
  const allowedOrigins = opts.allowedOrigins ?? [];
  const sessions = new Map<string, SessionRecord>();

  const httpServer = http.createServer((req, res) => {
    void handleRequest(createMcpServer, sessions, opts, allowedOrigins, req, res);
  });

  httpServer.listen(opts.port, opts.host);

  /** Track open sockets so close() can force-destroy them (avoids keep-alive hangs). */
  const sockets = new Set<Socket>();
  httpServer.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  const close = async (): Promise<void> => {
    for (const record of sessions.values()) {
      await closeSession(record);
    }
    sessions.clear();

    for (const sock of sockets) {
      sock.destroy();
    }
    sockets.clear();

    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err !== undefined) reject(err);
        else resolve();
      });
    });
  };

  return { httpServer, close };
}

async function handleRequest(
  createMcpServer: () => Server,
  sessions: Map<string, SessionRecord>,
  opts: StreamableHttpTransportOptions,
  allowedOrigins: readonly string[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const pathname = getPathname(req, opts.host);
  if (pathname !== opts.path) {
    writeJson(res, 404, { error: 'Not found' });
    return;
  }

  if (!verifyBearer(getHeader(req, 'authorization'), opts.authToken)) {
    writeJson(res, 401, { error: 'Unauthorized: missing or invalid Bearer token' });
    return;
  }

  const origin = getHeader(req, 'origin');
  if (origin !== undefined && origin !== '' && !isOriginAllowed(origin, allowedOrigins, opts.host)) {
    writeJson(res, 403, { error: 'Forbidden: Origin not allowed' });
    return;
  }

  try {
    if (req.method === 'POST') {
      await handlePost(createMcpServer, sessions, req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      await handleSessionRequest(sessions, req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST, DELETE' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Streamable HTTP transport error: ${msg}\n`);
    if (!res.headersSent) {
      writeJsonRpcError(res, 500, -32603, 'Internal server error');
    }
  }
}

async function handlePost(
  createMcpServer: () => Server,
  sessions: Map<string, SessionRecord>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    writeJsonRpcError(res, 400, -32700, 'Parse error');
    return;
  }

  const sessionId = getHeader(req, 'mcp-session-id');
  if (sessionId !== undefined && sessionId !== '') {
    const existing = sessions.get(sessionId);
    if (existing === undefined) {
      writeJsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    await existing.transport.handleRequest(req, res, body);
    return;
  }

  if (!containsInitializeRequest(body)) {
    writeJsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
    return;
  }

  let initializedSessionId: string | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      initializedSessionId = newSessionId;
      sessions.set(newSessionId, record);
    },
  });

  const server = createMcpServer();
  const record: SessionRecord = { transport, server, closed: false };

  const cleanup = (): void => {
    const sid = transport.sessionId ?? initializedSessionId;
    if (sid !== undefined) {
      sessions.delete(sid);
    }
    void closeSession(record).catch(() => undefined);
  };

  transport.onclose = cleanup;
  transport.onerror = (err) => {
    process.stderr.write(`Streamable HTTP session error: ${err.message}\n`);
  };

  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    await closeSession(record);
    throw err;
  }
}

async function handleSessionRequest(
  sessions: Map<string, SessionRecord>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const sessionId = getHeader(req, 'mcp-session-id');
  if (sessionId === undefined || sessionId === '') {
    writeJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    return;
  }

  const record = sessions.get(sessionId);
  if (record === undefined) {
    writeJsonRpcError(res, 404, -32001, 'Session not found');
    return;
  }

  await record.transport.handleRequest(req, res);
}

async function closeSession(record: SessionRecord): Promise<void> {
  if (record.closed) {
    return;
  }
  record.closed = true;
  await record.server.close();
}

function containsInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((message) => isInitializeRequest(message));
  }
  return isInitializeRequest(body);
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getPathname(req: http.IncomingMessage, fallbackHost: string): string {
  const base = `http://${req.headers.host ?? fallbackHost}`;
  return new URL(req.url ?? '/', base).pathname;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeJsonRpcError(
  res: http.ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
): void {
  writeJson(res, httpStatus, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}
