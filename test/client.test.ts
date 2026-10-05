import { describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, InvalidResponseError, LoomApiError, NetworkError } from '../src/api/ApiTypes';
import { AuthApi } from '../src/api/AuthApi';
import { HttpTransport, type FetchFn } from '../src/api/HttpTransport';
import { LoomClient, parseTaskPage, type TokenProvider } from '../src/api/LoomClient';
import { LoomTaskWriteApi } from '../src/api/TaskWriteApi';
import { AuthManager } from '../src/auth/AuthManager';
import { TokenManager } from '../src/auth/TokenManager';
import { TaskSchema } from '../src/models/Task';
import { nullLogger } from '../src/utils/logger';
import { MemorySecrets, envelope, fakeFetch, fakeJwt, fakeUser, jsonResponse, rawTask } from './helpers';

function makeClient(fetch: FetchFn, tokens: TokenProvider, opts: { now?: () => number; timeoutMs?: number } = {}) {
  const transport = new HttpTransport({
    baseUrl: () => 'https://loom.test/api/v1/',
    logger: nullLogger,
    fetch,
    sleep: async () => undefined,
    timeoutMs: opts.timeoutMs,
  });
  return new LoomClient(transport, new AuthApi(transport), tokens, nullLogger, { now: opts.now });
}

function staticTokens(token = 'fake-access'): TokenProvider & { invalidated: string[] } {
  const invalidated: string[] = [];
  return {
    invalidated,
    getAccessToken: async () => token,
    handleUnauthorized: async () => {
      throw new AuthRequiredError();
    },
    invalidateSession: async (reason) => {
      invalidated.push(reason);
    },
  };
}

function page(tasks: unknown[], meta: Record<string, unknown>) {
  return jsonResponse(200, envelope({ items: tasks, ...meta }));
}

describe('LoomClient /auth/me', () => {
  it('sends the bearer token and normalises the user', async () => {
    const net = fakeFetch({
      'GET /auth/me': () => jsonResponse(200, envelope({ ...fakeUser, githubUsername: 'devgh' })),
    });
    const client = makeClient(net.fetch, staticTokens('fake-access'));

    const me = await client.me();

    expect(me).toEqual({
      id: 'user-1',
      email: fakeUser.email,
      name: 'Dev Example',
      role: 'developer',
      avatarUrl: null,
      githubUsername: 'devgh',
    });
    expect(net.calls[0].headers.Authorization).toBe('Bearer fake-access');
    expect(net.calls[0].url.toString()).toBe('https://loom.test/api/v1/auth/me');
  });

  it('accepts a { user } wrapper', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(200, envelope({ user: fakeUser })) });
    expect((await makeClient(net.fetch, staticTokens()).me()).id).toBe('user-1');
  });
});

describe('LoomClient 401 handling', () => {
  it('renews once and retries the request once', async () => {
    const renewed = fakeJwt(3600, Date.now(), { v: 2 });
    const net = fakeFetch({
      'GET /auth/me': [
        () => jsonResponse(401, envelope(null, false, 'jwt expired')),
        (call) =>
          call.headers.Authorization === `Bearer ${renewed}`
            ? jsonResponse(200, envelope(fakeUser))
            : jsonResponse(401, envelope(null, false, 'bad')),
      ],
      'POST /auth/refresh': () => jsonResponse(200, envelope({ accessToken: renewed })),
    });
    const tokens = new TokenManager(new MemorySecrets());
    await tokens.save({ accessToken: fakeJwt(3600), refreshToken: 'fake-refresh', loginUser: null });
    const transport = new HttpTransport({ baseUrl: () => 'https://loom.test/api/v1', logger: nullLogger, fetch: net.fetch });
    const auth = new AuthManager({
      authApi: new AuthApi(transport),
      tokens,
      logger: nullLogger,
      refreshPath: () => '/auth/refresh',
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    await auth.initialize();
    const client = new LoomClient(transport, new AuthApi(transport), auth, nullLogger);

    expect((await client.me()).id).toBe('user-1');
    expect(net.callsTo('GET /auth/me')).toHaveLength(2);
    expect(net.callsTo('POST /auth/refresh')).toHaveLength(1);
  });

  it('does not loop: a second 401 ends the session', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(401, envelope(null, false, 'nope')) });
    const tokens: TokenProvider & { invalidated: string[] } = {
      ...staticTokens(),
      handleUnauthorized: vi.fn(async () => 'fake-renewed'),
    };
    const client = makeClient(net.fetch, tokens);

    await expect(client.me()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(net.calls).toHaveLength(2);
    expect(tokens.handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(tokens.invalidated).toEqual(['rejected']);
  });

  it('propagates AuthRequiredError when renewal is not possible', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(401, envelope(null, false, 'nope')) });
    await expect(makeClient(net.fetch, staticTokens()).me()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(net.calls).toHaveLength(1);
  });

  it('shares one renewal across concurrent 401s', async () => {
    const renewed = fakeJwt(3600, Date.now(), { v: 2 });
    let refreshCalls = 0;
    const net = fakeFetch({
      'GET /auth/me': (call) =>
        call.headers.Authorization === `Bearer ${renewed}`
          ? jsonResponse(200, envelope(fakeUser))
          : jsonResponse(401, envelope(null, false, 'expired')),
      'POST /auth/refresh': async () => {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return jsonResponse(200, envelope({ accessToken: renewed }));
      },
    });
    const tokens = new TokenManager(new MemorySecrets());
    await tokens.save({ accessToken: fakeJwt(3600), refreshToken: 'fake-refresh', loginUser: null });
    const transport = new HttpTransport({ baseUrl: () => 'https://loom.test/api/v1', logger: nullLogger, fetch: net.fetch });
    const auth = new AuthManager({
      authApi: new AuthApi(transport),
      tokens,
      logger: nullLogger,
      refreshPath: () => '/auth/refresh',
      scheduler: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    await auth.initialize();
    const client = new LoomClient(transport, new AuthApi(transport), auth, nullLogger);

    const users = await Promise.all([client.me(), client.me(), client.me(), client.me()]);

    expect(users.every((u) => u.id === 'user-1')).toBe(true);
    expect(refreshCalls).toBe(1);
  });
});

describe('HttpTransport behaviour', () => {
  it('retries 5xx responses up to two times', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(503, envelope(null, false, 'down')) });
    await expect(makeClient(net.fetch, staticTokens()).me()).rejects.toMatchObject({ status: 503 });
    expect(net.calls).toHaveLength(3);
  });

  it('retries network errors and then succeeds', async () => {
    const net = fakeFetch({
      'GET /auth/me': [
        () => {
          throw new TypeError('fetch failed');
        },
        () => jsonResponse(200, envelope(fakeUser)),
      ],
    });
    expect((await makeClient(net.fetch, staticTokens()).me()).id).toBe('user-1');
    expect(net.calls).toHaveLength(2);
  });

  it('never retries ordinary 4xx errors', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(403, envelope(null, false, 'Forbidden')) });
    const err = await makeClient(net.fetch, staticTokens()).me().catch((e) => e);
    expect(err).toBeInstanceOf(LoomApiError);
    expect(err.message).toBe('Forbidden');
    expect(net.calls).toHaveLength(1);
  });

  it('times out after the configured duration', async () => {
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const err = await makeClient(hang, staticTokens(), { timeoutMs: 20 }).me().catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.timedOut).toBe(true);
  });

  it('checks success === true, not just the HTTP status', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(200, envelope(fakeUser, false, 'Nope')) });
    await expect(makeClient(net.fetch, staticTokens()).me()).rejects.toThrow('Nope');
  });

  it('rejects non-envelope bodies', async () => {
    const net = fakeFetch({ 'GET /auth/me': () => jsonResponse(200, fakeUser) });
    await expect(makeClient(net.fetch, staticTokens()).me()).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('Task pages', () => {
  const params = { page: 1, pageSize: 2, assigneeId: 'user-1', sort: 'createdAt', order: 'desc' as const };

  it('sends only the documented query parameters', async () => {
    const net = fakeFetch({ 'GET /general-tasks/page': () => page([rawTask()], { total: 1, page: 1, pageSize: 2 }) });
    await makeClient(net.fetch, staticTokens()).getTasksPage(params);
    expect(Object.fromEntries(net.calls[0].url.searchParams)).toEqual({
      page: '1',
      pageSize: '2',
      assigneeId: 'user-1',
      sort: 'createdAt',
      order: 'desc',
    });
  });

  it('reports API totals exactly as returned', async () => {
    const net = fakeFetch({
      'GET /general-tasks/page': () => page([rawTask(), rawTask({ id: 'task-2' })], { total: 137, totalPages: 69, page: 1, pageSize: 2 }),
    });
    const result = await makeClient(net.fetch, staticTokens()).getTasksPage(params);
    expect(result.total).toBe(137);
    expect(result.totalPages).toBe(69);
    expect(result.hasNextPage).toBe(true);
    expect(result.hasPreviousPage).toBe(false);
  });

  it('caches pages for 30 seconds and clears the cache on demand', async () => {
    let now = 0;
    const net = fakeFetch({ 'GET /general-tasks/page': () => page([rawTask()], { total: 1 }) });
    const client = makeClient(net.fetch, staticTokens(), { now: () => now });

    await client.getTasksPage(params);
    await client.getTasksPage(params);
    expect(net.calls).toHaveLength(1);

    now += 30_001;
    await client.getTasksPage(params);
    expect(net.calls).toHaveLength(2);

    client.clearCache();
    await client.getTasksPage(params);
    expect(net.calls).toHaveLength(3);

    await client.getTasksPage(params, { bypassCache: true });
    expect(net.calls).toHaveLength(4);
  });

  it('does not cache failures', async () => {
    const net = fakeFetch({
      'GET /general-tasks/page': [() => jsonResponse(400, envelope(null, false, 'bad')), () => page([rawTask()], { total: 1 })],
    });
    const client = makeClient(net.fetch, staticTokens());
    await expect(client.getTasksPage(params)).rejects.toThrow('bad');
    await expect(client.getTasksPage(params)).resolves.toMatchObject({ total: 1 });
  });

  it('follows pagination in getAllTasks', async () => {
    const net = fakeFetch({
      'GET /general-tasks/page': (call) => {
        const p = Number(call.url.searchParams.get('page'));
        const items = p < 3 ? [rawTask({ id: `t${p}a` }), rawTask({ id: `t${p}b` })] : [rawTask({ id: 't3a' })];
        return page(items, { total: 5, page: p, pageSize: 2 });
      },
    });
    const all = await makeClient(net.fetch, staticTokens()).getAllTasks({ pageSize: 2, assigneeId: 'user-1' });
    expect(all.tasks.map((t) => t.id)).toEqual(['t1a', 't1b', 't2a', 't2b', 't3a']);
    expect(all.total).toBe(5);
    expect(all.truncated).toBe(false);
    expect(net.calls).toHaveLength(3);
  });

  it('stops getAllTasks at 50 pages', async () => {
    const net = fakeFetch({
      'GET /general-tasks/page': (call) => {
        const p = Number(call.url.searchParams.get('page'));
        return page([rawTask({ id: `t${p}` })], { total: 10_000, page: p, pageSize: 1 });
      },
    });
    const all = await makeClient(net.fetch, staticTokens()).getAllTasks({ pageSize: 1 });
    expect(net.calls).toHaveLength(50);
    expect(all.pagesFetched).toBe(50);
    expect(all.truncated).toBe(true);
  });
});

describe('parseTaskPage', () => {
  const params = { page: 2, pageSize: 10 };

  it('accepts a bare array and infers paging from length', () => {
    const result = parseTaskPage([rawTask()], params, nullLogger);
    expect(result.page).toBe(2);
    expect(result.total).toBeNull();
    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(true);
  });

  it('reads nested pagination metadata and count maps verbatim', () => {
    const result = parseTaskPage(
      { tasks: [rawTask()], pagination: { currentPage: 3, limit: 10, totalCount: 31 }, statusCounts: { done: 4, todo: 7 } },
      params,
      nullLogger,
    );
    expect(result).toMatchObject({ page: 3, pageSize: 10, total: 31, hasNextPage: true, counts: { done: 4, todo: 7 } });
  });

  it('skips invalid items instead of failing the whole page', () => {
    const result = parseTaskPage({ items: [rawTask(), { title: 'no id' }] }, params, nullLogger);
    expect(result.tasks).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('throws on an unrecognised shape', () => {
    expect(() => parseTaskPage({ something: 1 }, params, nullLogger)).toThrow(InvalidResponseError);
  });
});

describe('Changing task status (PATCH)', () => {
  const ROUTE = 'PATCH /projects/proj-1/general-tasks/task-1';
  // The update response, like Loom's: no projectName / projectTaskPrefix / parentTitle / counts.
  const updated = (status: string) => {
    const { projectName, projectTaskPrefix, parentTitle, parentTaskNumber, subtaskCount, subtaskDoneCount, ...rest } = rawTask();
    void [projectName, projectTaskPrefix, parentTitle, parentTaskNumber, subtaskCount, subtaskDoneCount];
    return { ...rest, status, updatedAt: '2026-10-03T17:38:44.712Z' };
  };

  it('sends every editable field with the new status to the project task URL', async () => {
    const net = fakeFetch({ [ROUTE]: () => jsonResponse(200, envelope(updated('done'))) });
    const client = makeClient(net.fetch, staticTokens('fake-access'));
    const task = TaskSchema.parse(rawTask());

    await new LoomTaskWriteApi(client).changeStatus(task, 'done');

    const [call] = net.callsTo(ROUTE);
    expect(call.headers.Authorization).toBe('Bearer fake-access');
    expect(call.body).toEqual({
      title: 'Fix login redirect',
      description: '<p>Hello <strong>world</strong></p>',
      status: 'done',
      priority: 'high',
      type: 'task',
      assigneeIds: ['user-1'],
      startDate: null,
      dueDate: '2026-10-10T00:00:00.000Z',
      requiresApproval: false,
      approverIds: [],
      customFields: {},
      timeEstimateMinutes: 90,
      sprintId: null,
    });
  });

  it('merges the response over the task, keeping list-only fields', async () => {
    const net = fakeFetch({ [ROUTE]: () => jsonResponse(200, envelope(updated('done'))) });
    const result = await makeClient(net.fetch, staticTokens()).updateTask(TaskSchema.parse(rawTask()), { status: 'done' });
    expect(result.status).toBe('done');
    expect(result.updatedAt).toBe('2026-10-03T17:38:44.712Z');
    expect(result.projectName).toBe('The Project');
    expect(result.projectTaskPrefix).toBe('THE');
    expect(result.subtaskCount).toBe(3);
  });

  it('renews once after a 401 and retries the PATCH', async () => {
    const net = fakeFetch({
      [ROUTE]: (call) =>
        call.headers.Authorization === 'Bearer renewed'
          ? jsonResponse(200, envelope(updated('in_review')))
          : jsonResponse(401, envelope(null, false, 'jwt expired')),
    });
    const tokens: TokenProvider = {
      getAccessToken: async () => 'stale',
      handleUnauthorized: async () => 'renewed',
      invalidateSession: async () => undefined,
    };
    const result = await makeClient(net.fetch, tokens).updateTask(TaskSchema.parse(rawTask()), { status: 'in_review' });
    expect(result.status).toBe('in_review');
    expect(net.callsTo(ROUTE)).toHaveLength(2);
  });

  it('fails when Loom reports success: false, even with HTTP 200', async () => {
    const net = fakeFetch({ [ROUTE]: () => jsonResponse(200, envelope(null, false, 'Invalid status transition')) });
    await expect(makeClient(net.fetch, staticTokens()).updateTask(TaskSchema.parse(rawTask()), { status: 'done' })).rejects.toThrow(
      'Invalid status transition',
    );
  });

  it('only reports changeStatus as supported', () => {
    const api = new LoomTaskWriteApi({ updateTask: async (t) => t });
    expect(api.supports('changeStatus')).toBe(true);
    expect(api.supports('changePriority')).toBe(false);
    expect(api.supports('addComment')).toBe(false);
  });
});
