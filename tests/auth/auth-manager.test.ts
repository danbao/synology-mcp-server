/**
 * Unit tests for AuthManager — login, token caching, invalidation, logout.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { AuthManager } from '../../src/auth/auth-manager.js';
import { AuthError, NetworkError } from '../../src/errors.js';
import type { SynologyConfig } from '../../src/types/index.js';

const BASE_CONFIG: SynologyConfig = {
  host: 'nas.local',
  port: 5000,
  https: false,
  ignoreCert: false,
  username: 'admin',
  password: 'secret',
  tokenTtlMs: 3_600_000,
  requestTimeoutMs: 5_000,
};

const AUTH_URL = 'http://nas.local:5000/webapi/auth.cgi';
const RFC_6238_SHA1_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const server = setupServer(
  http.post(AUTH_URL, () => HttpResponse.json({ success: true, data: { sid: 'test-sid-123' } })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  vi.restoreAllMocks();
  server.resetHandlers();
});
afterAll(() => server.close());

async function readFormBody(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

describe('AuthManager.getToken', () => {
  it('performs login and returns sid', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    const token = await mgr.getToken();
    expect(token).toBe('test-sid-123');
  });

  it('returns cached token on second call', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    const t1 = await mgr.getToken();
    const t2 = await mgr.getToken();
    expect(t1).toBe(t2);
  });

  it('coalesces concurrent first-token requests into one login', async () => {
    let loginCount = 0;
    server.use(
      http.post(AUTH_URL, async () => {
        loginCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return HttpResponse.json({ success: true, data: { sid: 'test-sid-123' } });
      }),
    );

    const mgr = new AuthManager(BASE_CONFIG);
    const tokens = await Promise.all([mgr.getToken(), mgr.getToken(), mgr.getToken()]);
    expect(tokens).toEqual(['test-sid-123', 'test-sid-123', 'test-sid-123']);
    expect(loginCount).toBe(1);
  });

  it('throws AuthError on bad credentials', async () => {
    server.use(
      http.post(AUTH_URL, () => HttpResponse.json({ success: false, error: { code: 400 } })),
    );
    const mgr = new AuthManager(BASE_CONFIG);
    await expect(mgr.getToken()).rejects.toThrow(AuthError);
  });

  it('posts configured otpCode when present', async () => {
    let formBody: URLSearchParams | undefined;
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        formBody = await readFormBody(request);
        return HttpResponse.json({ success: true, data: { sid: 'test-sid-123' } });
      }),
    );

    const mgr = new AuthManager({ ...BASE_CONFIG, otpCode: '123456' });
    await expect(mgr.getToken()).resolves.toBe('test-sid-123');
    expect(formBody?.get('otp_code')).toBe('123456');
  });

  it('generates otp_code from otpSecret when otpCode is absent', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(59_000);
    let formBody: URLSearchParams | undefined;
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        formBody = await readFormBody(request);
        return HttpResponse.json({ success: true, data: { sid: 'test-sid-123' } });
      }),
    );

    const mgr = new AuthManager({ ...BASE_CONFIG, otpSecret: RFC_6238_SHA1_SECRET });
    await expect(mgr.getToken()).resolves.toBe('test-sid-123');
    expect(formBody?.get('otp_code')).toBe('287082');
  });

  it('prefers explicit otpCode over generated otpSecret codes', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(59_000);
    let formBody: URLSearchParams | undefined;
    server.use(
      http.post(AUTH_URL, async ({ request }) => {
        formBody = await readFormBody(request);
        return HttpResponse.json({ success: true, data: { sid: 'test-sid-123' } });
      }),
    );

    const mgr = new AuthManager({
      ...BASE_CONFIG,
      otpCode: '654321',
      otpSecret: RFC_6238_SHA1_SECRET,
    });
    await expect(mgr.getToken()).resolves.toBe('test-sid-123');
    expect(formBody?.get('otp_code')).toBe('654321');
  });

  it('surfaces 2FA challenge responses clearly', async () => {
    server.use(
      http.post(AUTH_URL, () =>
        HttpResponse.json({
          success: false,
          error: {
            code: 403,
            errors: {
              token: 'redacted-2fa-token',
              types: [{ type: 'authenticator' }, { type: 'otp' }],
            },
          },
        }),
      ),
    );
    const mgr = new AuthManager(BASE_CONFIG);
    await expect(mgr.getToken()).rejects.toThrow('2FA verification required');
    await expect(mgr.getToken()).rejects.toThrow('SYNO_OTP_SECRET');
  });

  it('throws NetworkError when NAS unreachable', async () => {
    server.use(http.post(AUTH_URL, () => HttpResponse.error()));
    const mgr = new AuthManager(BASE_CONFIG);
    await expect(mgr.getToken()).rejects.toThrow(NetworkError);
  });
});

describe('AuthManager.invalidate', () => {
  it('forces re-login after invalidation', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    await mgr.getToken(); // prime cache
    mgr.invalidate();
    // After invalidation, next call should trigger a new login request
    const token = await mgr.getToken();
    expect(token).toBe('test-sid-123');
  });
});

describe('AuthManager.logout', () => {
  it('clears token without throwing', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    await mgr.getToken();
    // logout is best-effort; add a handler that returns success
    server.use(http.post(AUTH_URL, () => HttpResponse.json({ success: true })));
    await expect(mgr.logout()).resolves.not.toThrow();
  });

  it('handles logout when no token is cached', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    // No prior login — should be a no-op
    await expect(mgr.logout()).resolves.not.toThrow();
  });

  it('swallows logout errors silently', async () => {
    const mgr = new AuthManager(BASE_CONFIG);
    await mgr.getToken();
    server.use(http.post(AUTH_URL, () => HttpResponse.error()));
    await expect(mgr.logout()).resolves.not.toThrow();
  });
});
