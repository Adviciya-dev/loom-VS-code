import type { AllTasksResult } from '../api/ApiTypes';
import type { LoomClient } from '../api/LoomClient';
import type { Task } from '../models/Task';
import { mergeUsers, type LoomUser } from '../models/User';
import { Emitter } from '../utils/emitter';
import type { Logger } from '../utils/logger';
import { tasksInScope } from './projectScope';
import { EMPTY_FILTERS, type TaskFilters } from './taskQueries';

export type LoadState<T> =
  | { status: 'idle' }
  | { status: 'loading'; previous?: T }
  | { status: 'loaded'; value: T }
  | { status: 'error'; error: Error; previous?: T };

export interface TaskServiceOptions {
  pageSize: () => number;
}

/** Default sort for the assigned-tasks query, per the API documentation. */
const SORT = 'createdAt';
const ORDER = 'desc';

/**
 * Application state for the sidebar: current user, the tasks assigned to them
 * in the workspace's Loom project, and view preferences. Contains no UI code.
 */
export class TaskService {
  private _user: LoomUser | null = null;
  private _userState: LoadState<LoomUser> = { status: 'idle' };
  private _all: LoadState<AllTasksResult> = { status: 'idle' };
  private _filters: TaskFilters = EMPTY_FILTERS;
  private _scope: string[] | null = null;
  private generation = 0;

  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly client: LoomClient,
    private readonly logger: Logger,
    private readonly options: TaskServiceOptions,
  ) {}

  get user(): LoomUser | null {
    return this._user;
  }
  get userState(): LoadState<LoomUser> {
    return this._userState;
  }
  get all(): LoadState<AllTasksResult> {
    return this._all;
  }
  get filters(): TaskFilters {
    return this._filters;
  }
  /** Project IDs from the workspace's `.loom` files, or `null` for every project. */
  get scope(): readonly string[] | null {
    return this._scope;
  }

  /**
   * Sets the workspace's Loom projects. With no project nothing is fetched: the
   * workspace isn't a Loom project. The API has no documented project filter, so
   * every assigned task is fetched and filtered here.
   */
  setScope(projectIds: string[] | null): void {
    const next = projectIds && projectIds.length ? [...projectIds] : null;
    if (JSON.stringify(next) === JSON.stringify(this._scope)) {
      return;
    }
    this._scope = next;
    this.emitter.fire();
    if (next && this._user) {
      void this.loadAll();
    }
  }

  inScope(tasks: Task[]): Task[] {
    return tasksInScope(tasks, this._scope);
  }

  /** Called after sign-in: `/auth/me` first, then the assigned tasks if the workspace is a Loom project. */
  async start(loginUser: LoomUser | null): Promise<void> {
    await this.loadUser(loginUser);
    if (this._user && this._scope) {
      await this.loadAll();
    }
  }

  async loadUser(loginUser: LoomUser | null): Promise<void> {
    const gen = this.generation;
    this._userState = { status: 'loading' };
    this.emitter.fire();
    try {
      const me = await this.client.me();
      if (gen !== this.generation) {
        return;
      }
      if (this._user && this._user.id !== me.id) {
        // A different account: nothing cached for the previous one may leak through.
        this.client.clearCache();
        this._all = { status: 'idle' };
      }
      this._user = mergeUsers(me, loginUser);
      this._userState = { status: 'loaded', value: this._user };
    } catch (err) {
      if (gen !== this.generation) {
        return;
      }
      this.logger.error('Failed to load the current user', err);
      this._userState = { status: 'error', error: err as Error };
    }
    this.emitter.fire();
  }

  /** Loads every task assigned to the current user (up to the 50-page limit). */
  async loadAll(options: { force?: boolean } = {}): Promise<void> {
    const user = this._user;
    if (!user || (this._all.status === 'loading' && !options.force)) {
      return;
    }
    const gen = this.generation;
    const previous = this._all.status === 'loaded' ? this._all.value : undefined;
    this._all = { status: 'loading', previous };
    this.emitter.fire();
    try {
      const result = await this.client.getAllTasks(
        { pageSize: this.options.pageSize(), assigneeId: user.id, sort: SORT, order: ORDER },
        { bypassCache: options.force },
      );
      if (gen !== this.generation) {
        return;
      }
      this._all = { status: 'loaded', value: result };
    } catch (err) {
      if (gen !== this.generation) {
        return;
      }
      this.logger.error('Failed to load all assigned tasks', err);
      this._all = { status: 'error', error: err as Error, previous };
    }
    this.emitter.fire();
  }

  async refresh(): Promise<void> {
    this.client.clearCache();
    if (!this._user) {
      await this.loadUser(null);
    }
    if (this._scope) {
      await this.loadAll({ force: true });
    }
  }

  /** Swaps in a task the server just returned, so the views update without refetching every page. */
  applyTaskUpdate(task: Task): void {
    const s = this._all;
    if (s.status !== 'loaded') {
      return;
    }
    this._all = { status: 'loaded', value: { ...s.value, tasks: s.value.tasks.map((t) => (t.id === task.id ? task : t)) } };
    this.emitter.fire();
  }

  setFilters(filters: TaskFilters): void {
    this._filters = filters;
    this.emitter.fire();
  }


  allValue(): AllTasksResult | undefined {
    const s = this._all;
    return s.status === 'loaded' ? s.value : s.status === 'idle' ? undefined : s.previous;
  }

  /** Every task currently held in the current project scope, de-duplicated. */
  knownTasks(): Task[] {
    return this.inScope(this.heldTasks());
  }

  findTask(id: string): Task | undefined {
    return this.heldTasks().find((t) => t.id === id);
  }

  private heldTasks(): Task[] {
    const map = new Map<string, Task>();
    for (const task of this.allValue()?.tasks ?? []) {
      map.set(task.id, task);
    }
    return [...map.values()];
  }

  /** Clears everything on sign-out. In-flight responses from before are discarded. */
  reset(): void {
    this.generation++;
    this.client.clearCache();
    this._user = null;
    this._userState = { status: 'idle' };
    this._all = { status: 'idle' };
    this._filters = EMPTY_FILTERS;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
