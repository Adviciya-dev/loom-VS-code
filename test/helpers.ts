import type { FetchFn } from '../src/api/HttpTransport';
import type { SecretStore } from '../src/auth/TokenManager';
import { Logger } from '../src/utils/logger';

/** Unsigned fake JWT with the given expiry. Never a real token. */
export function fakeJwt(expSecondsFromNow: number, now = Date.now(), extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user-1', exp: Math.floor(now / 1000) + expSecondsFromNow, ...extra })}.fake-signature`;
}

export function envelope(data: unknown, success = true, message = 'ok') {
  return { success, data, message, meta: { timestamp: '2026-10-03T00:00:00.000Z' } };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

/** Fetch stub that routes on "METHOD /path" and records every call. */
export function fakeFetch(routes: Record<string, Handler | Handler[]>) {
  const calls: RecordedCall[] = [];
  const counters = new Map<string, number>();
  const fetch: FetchFn = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const key = `${init.method ?? 'GET'} ${path}`;
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[key];
    if (!route) {
      return jsonResponse(404, envelope(null, false, `No route for ${key}`));
    }
    if (Array.isArray(route)) {
      const n = counters.get(key) ?? 0;
      counters.set(key, n + 1);
      return route[Math.min(n, route.length - 1)](call);
    }
    return route(call);
  };
  return { fetch, calls, callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.url.pathname.replace(/^\/api\/v1/, '')}` === key) };
}

export class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key);
  }
  async store(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}

export function captureLogger() {
  const lines: string[] = [];
  return { logger: new Logger({ appendLine: (l) => lines.push(l) }, 'debug'), lines };
}

export const FAKE_EMAIL = 'dev@example.test';
export const FAKE_PASSWORD = 'not-a-real-password-123';

export const fakeUser = { id: 'user-1', email: FAKE_EMAIL, name: 'Dev Example', role: 'developer' };

export function rawTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    projectName: 'The Project',
    projectTaskPrefix: 'THE',
    taskNumber: 129,
    title: 'Fix login redirect',
    description: '<p>Hello <strong>world</strong></p>',
    status: 'in_progress',
    priority: 'high',
    type: 'task',
    assigneeIds: ['user-1'],
    createdById: 'user-2',
    dueDate: '2026-10-10T00:00:00.000Z',
    startDate: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    lastActivityAt: '2026-09-02T00:00:00.000Z',
    parentTaskId: null,
    parentTitle: null,
    parentTaskNumber: null,
    sprintId: null,
    sprintName: null,
    sprintIsActive: false,
    requiresApproval: false,
    approverIds: [],
    approvedByIds: [],
    approvalStatus: 'none',
    dependencyCount: 0,
    dependencyDoneCount: 0,
    isBlocked: false,
    subtaskCount: 3,
    subtaskDoneCount: 1,
    timeEstimateMinutes: 90,
    autoCompletedFromStatus: null,
    customFields: {},
    ...overrides,
  };
}
