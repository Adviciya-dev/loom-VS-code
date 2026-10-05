import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, InvalidCredentialsError, LoginThrottledError, NetworkError } from '../src/api/ApiTypes';
import { AuthApi } from '../src/api/AuthApi';
import { HttpTransport } from '../src/api/HttpTransport';
import { AuthManager, type AuthEvent, type Scheduler } from '../src/auth/AuthManager';
import { TokenManager, decodeJwtExpiry } from '../src/auth/TokenManager';
import { nullLogger } from '../src/utils/logger';
import {
  FAKE_EMAIL,
  FAKE_PASSWORD,
  MemorySecrets,
  envelope,
  fakeFetch,
  fakeJwt,
  fakeUser,
  jsonResponse,
} from './helpers';

const noTimers: Scheduler = { setTimeout: () => 0, clearTimeout: () => undefined };

function setup(opts: { refreshPath?: string; now?: () => number; routes?: Parameters<typeof fakeFetch>[0] } = {}) {
  const net = fakeFetch(opts.routes ?? {});
  const transport = new HttpTransport({
    baseUrl: () => 'https://loom.test/api/v1',
    logger: nullLogger,
    fetch: net.fetch,
    sleep: async () => undefined,
  });
  const secrets = new MemorySecrets();
  const tokens = new TokenManager(secrets);
  const auth = new AuthManager({
    authApi: new AuthApi(transport),
    tokens,
    logger: nullLogger,
    refreshPath: () => opts.refreshPath ?? '',
    now: opts.now,
    scheduler: noTimers,
  });
  const events: AuthEvent[] = [];
  auth.onDidChange((e) => events.push(e));
  return { auth, secrets, tokens, net, events };
}

describe('TokenManager', () => {
  it('decodes JWT expiry locally', () => {
    const now = Date.UTC(2026, 9, 3);
    expect(decodeJwtExpiry(fakeJwt(3600, now))).toBe(Math.floor(now / 1000) * 1000 + 3_600_000);
    expect(decodeJwtExpiry('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiry('a.%%%.c')).toBeNull();
  });

  it('discards corrupt stored sessions', async () => {
    const secrets = new MemorySecrets();
    secrets.data.set('loom.session.v1', '{not json');
    expect(await new TokenManager(secrets).load()).toBeNull();
    expect(secrets.data.size).toBe(0);
  });
});

describe('AuthManager login', () => {
  it('signs in, stores tokens securely and never stores the password', async () => {
    const access = fakeJwt(3600);
    const { auth, secrets, net, events } = setup({
      routes: {
        'POST /auth/login': () => jsonResponse(200, envelope({ accessToken: access, refreshToken: 'fake-refresh', user: fakeUser })),
      },
    });

    const user = await auth.login(FAKE_EMAIL, FAKE_PASSWORD);

    expect(user?.id).toBe('user-1');
    expect(net.calls[0].body).toEqual({ email: FAKE_EMAIL, password: FAKE_PASSWORD });
    expect(auth.isAuthenticated).toBe(true);
    expect(await auth.getAccessToken()).toBe(access);
    const stored = [...secrets.data.values()].join('');
    expect(stored).toContain(access);
    expect(stored).not.toContain(FAKE_PASSWORD);
    expect(events).toEqual([{ type: 'signedIn', loginUser: expect.objectContaining({ id: 'user-1' }) }]);
  });

  it('reports invalid credentials and throttles retries for 30 seconds', async () => {
    let now = 1_000_000;
    const { auth, net } = setup({
      now: () => now,
      routes: { 'POST /auth/login': () => jsonResponse(401, envelope(null, false, 'Invalid credentials')) },
    });

    await expect(auth.login(FAKE_EMAIL, 'wrong-password')).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(auth.isAuthenticated).toBe(false);

    now += 10_000;
    await expect(auth.login(FAKE_EMAIL, 'wrong-password')).rejects.toBeInstanceOf(LoginThrottledError);
    expect(auth.loginThrottleRemaining()).toBe(20);
    expect(net.calls).toHaveLength(1); // throttled attempt never reached the server

    now += 20_001;
    await expect(auth.login(FAKE_EMAIL, 'wrong-password')).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(net.calls).toHaveLength(2);
  });

  it('rejects a 200 response whose envelope says success=false', async () => {
    const { auth } = setup({
      routes: { 'POST /auth/login': () => jsonResponse(200, envelope(null, false, 'Account disabled')) },
    });
    await expect(auth.login(FAKE_EMAIL, FAKE_PASSWORD)).rejects.toThrow('Account disabled');
    expect(auth.isAuthenticated).toBe(false);
  });

  it('validates input before calling the server', async () => {
    const { auth, net } = setup();
    await expect(auth.login('not-an-email', FAKE_PASSWORD)).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(auth.login(FAKE_EMAIL, '')).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(net.calls).toHaveLength(0);
  });
});

describe('AuthManager session', () => {
  it('restores a valid stored session across restarts', async () => {
    const { tokens, auth, events } = setup();
    const access = fakeJwt(3600);
    await tokens.save({ accessToken: access, refreshToken: null, loginUser: null });

    expect(await auth.initialize()).toBe(true);
    expect(await auth.getAccessToken()).toBe(access);
    expect(events[0].type).toBe('signedIn');
  });

  it('clears an expired stored session when no refresh endpoint is configured', async () => {
    const { tokens, auth, secrets } = setup();
    await tokens.save({ accessToken: fakeJwt(-10), refreshToken: 'fake-refresh', loginUser: null });

    expect(await auth.initialize()).toBe(false);
    expect(auth.isAuthenticated).toBe(false);
    expect(secrets.data.size).toBe(0);
  });

  it('returns the current token while it is valid and not near expiry', async () => {
    const { tokens, auth, net } = setup({ refreshPath: '/auth/refresh' });
    await tokens.save({ accessToken: fakeJwt(600), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();
    await auth.getAccessToken();
    expect(net.calls).toHaveLength(0);
  });

  it('renews a token that expires within 60 seconds via the configured refresh endpoint', async () => {
    const renewed = fakeJwt(3600);
    const { tokens, auth, net } = setup({
      refreshPath: '/auth/refresh',
      routes: { 'POST /auth/refresh': () => jsonResponse(200, envelope({ accessToken: renewed, refreshToken: 'fake-refresh-2' })) },
    });
    await tokens.save({ accessToken: fakeJwt(30), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();

    expect(await auth.getAccessToken()).toBe(renewed);
    expect(net.calls[0].body).toEqual({ refreshToken: 'fake-refresh' });
    expect((await tokens.load())?.refreshToken).toBe('fake-refresh-2');
  });

  it('makes only one renewal request when many callers need a token at once', async () => {
    const renewed = fakeJwt(3600);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { tokens, auth, net } = setup({
      refreshPath: '/auth/refresh',
      routes: {
        'POST /auth/refresh': async () => {
          await gate;
          return jsonResponse(200, envelope({ accessToken: renewed }));
        },
      },
    });
    await tokens.save({ accessToken: fakeJwt(10), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();

    const pending = Promise.all([
      auth.getAccessToken(),
      auth.getAccessToken(),
      auth.handleUnauthorized(),
      auth.getAccessToken(),
      auth.handleUnauthorized(),
    ]);
    release();
    const results = await pending;

    expect(results.every((t) => t === renewed)).toBe(true);
    expect(net.callsTo('POST /auth/refresh')).toHaveLength(1);
  });

  it('requires sign-in when the token is near expiry and there is no refresh endpoint', async () => {
    let now = Date.now();
    const { tokens, auth, events } = setup({ now: () => now });
    await tokens.save({ accessToken: fakeJwt(30, now), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();

    // Still valid: keep using it rather than failing early.
    await expect(auth.getAccessToken()).resolves.toBeTruthy();

    now += 31_000;
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(auth.isAuthenticated).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'signedOut', reason: 'expired' });
  });

  it('ends the session when the refresh endpoint rejects the refresh token', async () => {
    const { tokens, auth, secrets } = setup({
      refreshPath: '/auth/refresh',
      routes: { 'POST /auth/refresh': () => jsonResponse(401, envelope(null, false, 'expired')) },
    });
    await tokens.save({ accessToken: fakeJwt(3600), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();

    await expect(auth.handleUnauthorized()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(auth.isAuthenticated).toBe(false);
    expect(secrets.data.size).toBe(0);
  });

  it('keeps a still-valid token when proactive renewal fails due to the network', async () => {
    const current = fakeJwt(30);
    const { tokens, auth } = setup({
      refreshPath: '/auth/refresh',
      routes: {
        'POST /auth/refresh': () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await tokens.save({ accessToken: current, refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();
    expect(await auth.getAccessToken()).toBe(current);
    expect(auth.isAuthenticated).toBe(true);
  });

  it('does not renew again when another request already replaced the failed token', async () => {
    const { tokens, auth, net } = setup({ refreshPath: '/auth/refresh' });
    const current = fakeJwt(3600);
    await tokens.save({ accessToken: current, refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();
    expect(await auth.handleUnauthorized('some-older-token')).toBe(current);
    expect(net.calls).toHaveLength(0);
  });

  it('logout clears stored credentials and notifies listeners', async () => {
    const { tokens, auth, secrets, events } = setup();
    await tokens.save({ accessToken: fakeJwt(3600), refreshToken: 'fake-refresh', loginUser: null });
    await auth.initialize();

    await auth.logout();

    expect(auth.isAuthenticated).toBe(false);
    expect(secrets.data.size).toBe(0);
    expect(events.at(-1)).toEqual({ type: 'signedOut', reason: 'logout' });
    await expect(auth.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('warns before expiry when the token cannot be renewed automatically', async () => {
    const now = Date.now();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const net = fakeFetch({});
    const tokens = new TokenManager(new MemorySecrets());
    await tokens.save({ accessToken: fakeJwt(600, now), refreshToken: null, loginUser: null });
    const auth = new AuthManager({
      authApi: new AuthApi(new HttpTransport({ baseUrl: () => 'https://loom.test/api/v1', logger: nullLogger, fetch: net.fetch })),
      tokens,
      logger: nullLogger,
      refreshPath: () => '',
      now: () => now,
      scheduler: { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => undefined },
    });
    const listener = vi.fn();
    auth.onDidChange(listener);
    await auth.initialize();

    const warning = timers.find((t) => Math.abs(t.ms - 540_000) < 1000);
    expect(warning).toBeDefined();
    warning!.fn();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'expiringSoon' }));
  });

  it('surfaces network errors during login without throttling', async () => {
    const { auth } = setup({
      routes: {
        'POST /auth/login': () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await expect(auth.login(FAKE_EMAIL, FAKE_PASSWORD)).rejects.toBeInstanceOf(NetworkError);
    expect(auth.loginThrottleRemaining()).toBe(0);
  });
});
