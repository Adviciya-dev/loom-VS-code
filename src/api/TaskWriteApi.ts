import type { Task, TaskStatus } from '../models/Task';
import { NotSupportedError } from './ApiTypes';
import type { LoomClient } from './LoomClient';

/**
 * Write operations the UI is built for. `LoomTaskWriteApi` implements the ones
 * with a confirmed endpoint; the rest refuse — no requests are guessed at.
 *
 * When Loom documents another endpoint, implement it in `LoomTaskWriteApi` using
 * LoomClient's authenticated request flow and add it to `SUPPORTED`. The commands
 * already gate on `supports` and need no changes.
 */
export type WriteOperation =
  | 'createTask'
  | 'assignTask'
  | 'changeStatus'
  | 'changePriority'
  | 'editTask'
  | 'addComment';

export const WRITE_OPERATION_LABELS: Record<WriteOperation, string> = {
  createTask: 'Creating tasks',
  assignTask: 'Assigning tasks',
  changeStatus: 'Changing task status',
  changePriority: 'Changing task priority',
  editTask: 'Editing tasks',
  addComment: 'Adding comments',
};

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: string;
  type?: string;
  assigneeIds?: string[];
  dueDate?: string | null;
  parentTaskId?: string | null;
}

export interface EditTaskInput {
  title?: string;
  description?: string;
  dueDate?: string | null;
  startDate?: string | null;
}

export interface TaskWriteApi {
  supports(operation: WriteOperation): boolean;
  createTask(input: CreateTaskInput): Promise<Task>;
  /** Replaces the assignee list (covers both assign and reassign). */
  assignTask(taskId: string, assigneeIds: string[]): Promise<Task>;
  /** Needs the whole task: Loom's update endpoint takes every editable field. */
  changeStatus(task: Task, status: TaskStatus): Promise<Task>;
  changePriority(taskId: string, priority: string): Promise<Task>;
  editTask(taskId: string, input: EditTaskInput): Promise<Task>;
  addComment(taskId: string, body: string): Promise<void>;
}

export class UndocumentedTaskWriteApi implements TaskWriteApi {
  supports(_operation: WriteOperation): boolean {
    return false;
  }

  // TODO(loom-api): POST endpoint for task creation is not documented.
  async createTask(): Promise<Task> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.createTask);
  }

  // TODO(loom-api): endpoint for updating assignees is not documented.
  async assignTask(): Promise<Task> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.assignTask);
  }

  async changeStatus(_task: Task, _status: TaskStatus): Promise<Task> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.changeStatus);
  }

  // TODO(loom-api): endpoint for priority changes is not documented.
  async changePriority(): Promise<Task> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.changePriority);
  }

  // TODO(loom-api): endpoint for editing task fields is not documented.
  async editTask(): Promise<Task> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.editTask);
  }

  // TODO(loom-api): comments endpoint is not documented.
  async addComment(): Promise<void> {
    throw new NotSupportedError(WRITE_OPERATION_LABELS.addComment);
  }
}

/** Operations with a confirmed Loom endpoint; everything else still refuses. */
export class LoomTaskWriteApi extends UndocumentedTaskWriteApi {
  private static readonly SUPPORTED: ReadonlySet<WriteOperation> = new Set(['changeStatus']);

  constructor(private readonly client: Pick<LoomClient, 'updateTask'>) {
    super();
  }

  override supports(operation: WriteOperation): boolean {
    return LoomTaskWriteApi.SUPPORTED.has(operation);
  }

  /** PATCH /projects/{projectId}/general-tasks/{taskId} with `status` changed. */
  override changeStatus(task: Task, status: TaskStatus): Promise<Task> {
    return this.client.updateTask(task, { status });
  }
}
