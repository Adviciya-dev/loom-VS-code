import { z } from 'zod';
import { TaskSchema, type Task } from '../models/Task';
import { LoomUserSchema, normalizeUser, type LoomUser } from '../models/User';
import type { Logger } from '../utils/logger';
import type { AuthApi } from './AuthApi';
import {
  AuthRequiredError,
  InvalidResponseError,
  UnauthorizedError,
  type AllTasksResult,
  type LoginResult,
  type TaskPage,
  type TaskPageParams,
} from './ApiTypes';
import type { HttpTransport } from './HttpTransport';

/** What LoomClient needs from the auth layer. Implemented by AuthManager. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Called after a 401; returns a renewed token or throws AuthRequiredError. */
  handleUnauthorized(failedToken?: string): Promise<string>;
  /** Called when even a renewed token is rejected. Must not make requests. */
  invalidateSession(reason: string): Promise<void>;
}

export interface LoomClientOptions {
  cacheTtlMs?: number;
  maxPages?: number;
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<TaskPage>;
}

const MAX_PAGES = 50;

export class LoomClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private cacheGeneration = 0;

  constructor(
    private readonly transport: HttpTransport,
    private readonly authApi: AuthApi,
    private readonly tokens: TokenProvider,
    private readonly logger: Logger,
    options: LoomClientOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.maxPages = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);
    this.now = options.now ?? Date.now;
  }

  /** POST /auth/login (unauthenticated). Prefer AuthManager.login, which also stores the session. */
  login(email: string, password: string): Promise<LoginResult> {
    return this.authApi.login(email, password);
  }

  /** GET /auth/me — the source of truth for the current user. */
  async me(): Promise<LoomUser> {
    const raw = await this.authed((accessToken) =>
      this.transport.request({ method: 'GET', path: '/auth/me', accessToken, schema: MeSchema }),
    );
    return normalizeUser(raw);
  }

  /** GET /general-tasks/page. Cached for 30 seconds per parameter set. */
  getTasksPage(params: TaskPageParams, options: { bypassCache?: boolean } = {}): Promise<TaskPage> {
    const key = JSON.stringify([params.page, params.pageSize, params.assigneeId ?? null, params.sort ?? null, params.order ?? null]);
    const now = this.now();
    const hit = this.cache.get(key);
    if (!options.bypassCache && hit && hit.expiresAt > now) {
      return hit.value;
    }

    const generation = this.cacheGeneration;
    const value = this.fetchTasksPage(params);
    this.cache.set(key, { expiresAt: now + this.cacheTtlMs, value });
    value.catch(() => {
      // Never cache failures.
      if (this.cache.get(key)?.value === value) {
        this.cache.delete(key);
      }
    });
    // If the cache was cleared while this was in flight (logout/user change), don't keep the result.
    void value.then(() => {
      if (generation !== this.cacheGeneration) {
        this.cache.delete(key);
      }
    }, () => undefined);
    return value;
  }

  /** Follows pagination until the last page or the 50-page safety limit. */
  async getAllTasks(
    params: Omit<TaskPageParams, 'page'>,
    options: { bypassCache?: boolean } = {},
  ): Promise<AllTasksResult> {
    const seen = new Set<string>();
    const tasks: Task[] = [];
    let total: number | null = null;
    let skipped = 0;
    let page = 1;
    let pagesFetched = 0;
    let hasNext = true;

    while (hasNext && pagesFetched < this.maxPages) {
      const result = await this.getTasksPage({ ...params, page }, options);
      pagesFetched++;
      if (pagesFetched === 1) {
        total = result.total;
      }
      skipped += result.skipped;
      for (const task of result.tasks) {
        if (!seen.has(task.id)) {
          seen.add(task.id);
          tasks.push(task);
        }
      }
      hasNext = result.hasNextPage && result.tasks.length > 0;
      page++;
    }

    const truncated = hasNext;
    if (truncated) {
      this.logger.warn(`getAllTasks stopped at the ${this.maxPages}-page limit`);
    }
    return { tasks, total, truncated, pagesFetched, skipped };
  }

  /**
   * PATCH /projects/{projectId}/general-tasks/{taskId}. Like the Loom web app,
   * sends every editable field (the current values plus `changes`). The response
   * omits list-only fields (project name, prefix, parent title, counts), so it is
   * merged over the task we already have.
   */
  async updateTask(task: Task, changes: Partial<TaskUpdateBody>): Promise<Task> {
    if (!task.projectId) {
      throw new InvalidResponseError('This task has no project, so it cannot be updated.');
    }
    const body: TaskUpdateBody = { ...taskUpdateBody(task), ...changes };
    const raw = await this.authed((accessToken) =>
      this.transport.request({
        method: 'PATCH',
        path: `/projects/${encodeURIComponent(task.projectId)}/general-tasks/${encodeURIComponent(task.id)}`,
        accessToken,
        body,
        schema: z.record(z.unknown()),
      }),
    );
    this.clearCache();
    return TaskSchema.parse({ ...task, ...raw });
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheGeneration++;
  }

  private async fetchTasksPage(params: TaskPageParams): Promise<TaskPage> {
    const data = await this.authed((accessToken) =>
      this.transport.request({
        method: 'GET',
        path: '/general-tasks/page',
        accessToken,
        query: {
          page: params.page,
          pageSize: params.pageSize,
          assigneeId: params.assigneeId,
          sort: params.sort,
          order: params.order,
        },
        schema: z.unknown(),
      }),
    );
    return parseTaskPage(data, params, this.logger);
  }

  /**
   * Runs an authenticated request. A 401 triggers exactly one renewal + retry;
   * a second 401 ends the session instead of looping.
   */
  private async authed<T>(run: (accessToken: string) => Promise<T>): Promise<T> {
    const token = await this.tokens.getAccessToken();
    try {
      return await run(token);
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err;
      }
    }

    const renewed = await this.tokens.handleUnauthorized(token);
    try {
      return await run(renewed);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await this.tokens.invalidateSession('rejected');
        throw new AuthRequiredError('Your Loom session is no longer valid. Please sign in again.');
      }
      throw err;
    }
  }
}

const MeSchema = z.union([LoomUserSchema, z.object({ user: LoomUserSchema }).transform((v) => v.user)]);

/** The editable fields the Loom web app sends when it saves a task. */
export type TaskUpdateBody = Pick<
  Task,
  | 'title'
  | 'description'
  | 'status'
  | 'priority'
  | 'type'
  | 'assigneeIds'
  | 'startDate'
  | 'dueDate'
  | 'requiresApproval'
  | 'approverIds'
  | 'customFields'
  | 'timeEstimateMinutes'
  | 'sprintId'
>;

export function taskUpdateBody(task: Task): TaskUpdateBody {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    type: task.type,
    assigneeIds: task.assigneeIds,
    startDate: task.startDate,
    dueDate: task.dueDate,
    requiresApproval: task.requiresApproval,
    approverIds: task.approverIds,
    customFields: task.customFields,
    timeEstimateMinutes: task.timeEstimateMinutes,
    sprintId: task.sprintId,
  };
}

// ---------------------------------------------------------------------------
// Page parsing. The paginated response's exact shape isn't documented, so the
// common layouts are accepted and nothing is guessed beyond them.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstNumber(source: Dict, keys: string[]): number | null {
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

function countMap(v: unknown): Record<string, number> | null {
  if (!isDict(v)) {
    return null;
  }
  const entries = Object.entries(v).filter((e): e is [string, number] => typeof e[1] === 'number');
  return entries.length ? Object.fromEntries(entries) : null;
}

export function parseTaskPage(data: unknown, params: TaskPageParams, logger: Logger): TaskPage {
  let items: unknown;
  let meta: Dict = {};
  let counts: Record<string, number> | null = null;

  if (Array.isArray(data)) {
    items = data;
  } else if (isDict(data)) {
    items = data.items ?? data.tasks ?? data.data ?? data.rows ?? data.results;
    meta = { ...data, ...(isDict(data.pagination) ? data.pagination : {}), ...(isDict(data.meta) ? data.meta : {}) };
    counts = countMap(data.counts) ?? countMap(data.statusCounts) ?? countMap(data.taskCounts);
  }

  if (!Array.isArray(items)) {
    throw new InvalidResponseError('Loom returned a task page in an unexpected format.');
  }

  const tasks: Task[] = [];
  let skipped = 0;
  for (const item of items) {
    const parsed = TaskSchema.safeParse(item);
    if (parsed.success) {
      tasks.push(parsed.data);
    } else {
      skipped++;
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
      logger.warn(`Skipped a task that failed validation at ${paths.join(', ')}`);
    }
  }

  const page = firstNumber(meta, ['page', 'currentPage', 'pageNumber']) ?? params.page;
  const pageSize = firstNumber(meta, ['pageSize', 'limit', 'perPage', 'size']) ?? params.pageSize;
  const total = firstNumber(meta, ['total', 'totalCount', 'totalItems', 'totalRecords', 'count']);
  const totalPages = firstNumber(meta, ['totalPages', 'pageCount', 'lastPage']);
  const explicitHasNext = typeof meta.hasNextPage === 'boolean' ? meta.hasNextPage : typeof meta.hasMore === 'boolean' ? meta.hasMore : null;

  let hasNextPage: boolean;
  if (explicitHasNext !== null) {
    hasNextPage = explicitHasNext;
  } else if (totalPages !== null) {
    hasNextPage = page < totalPages;
  } else if (total !== null) {
    hasNextPage = page * pageSize < total;
  } else {
    hasNextPage = items.length >= pageSize;
  }

  return {
    tasks,
    page,
    pageSize,
    total,
    totalPages,
    hasNextPage,
    hasPreviousPage: page > 1,
    counts,
    skipped,
  };
}
