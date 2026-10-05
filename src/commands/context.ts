import * as vscode from 'vscode';
import {
  AuthRequiredError,
  InvalidCredentialsError,
  LoginThrottledError,
  NetworkError,
  NotSupportedError,
} from '../api/ApiTypes';
import { WRITE_OPERATION_LABELS, type TaskWriteApi, type WriteOperation } from '../api/TaskWriteApi';
import type { AuthManager } from '../auth/AuthManager';
import { taskKey, type Task } from '../models/Task';
import type { TaskService } from '../services/TaskService';
import { buildTaskUrl } from '../services/taskUrl';
import { cleanTitle, formatStatus } from '../utils/formatters';
import type { Logger } from '../utils/logger';
import type { LoomNode } from '../views/LoomTreeProvider';
import type { TaskDetailView } from '../views/TaskDetailView';

export interface LoomContext {
  auth: AuthManager;
  service: TaskService;
  writeApi: TaskWriteApi;
  detailView: TaskDetailView;
  logger: Logger;
  output: vscode.OutputChannel;
  config: {
    webBaseUrl(): string;
    taskUrlTemplate(): string;
  };
}

/** Converts any error into a user-facing message, offering a next step where there is one. */
export async function showError(err: unknown, action: string): Promise<void> {
  if (err instanceof NotSupportedError) {
    void vscode.window.showInformationMessage(err.message);
    return;
  }
  if (err instanceof AuthRequiredError) {
    const choice = await vscode.window.showWarningMessage(err.message, 'Sign In');
    if (choice === 'Sign In') {
      void vscode.commands.executeCommand('loom.login');
    }
    return;
  }
  if (err instanceof InvalidCredentialsError || err instanceof LoginThrottledError) {
    void vscode.window.showErrorMessage(err.message);
    return;
  }
  const reason = err instanceof NetworkError ? "couldn't reach Loom" : (err as Error)?.message || 'unknown error';
  const choice = await vscode.window.showErrorMessage(`Loom: ${action} failed — ${reason}.`, 'Show Logs');
  if (choice === 'Show Logs') {
    void vscode.commands.executeCommand('loom.showLogs');
  }
}

/** Returns false (after telling the user) when the API doesn't support the operation yet. */
export function ensureSupported(ctx: LoomContext, op: WriteOperation): boolean {
  if (ctx.writeApi.supports(op)) {
    return true;
  }
  void vscode.window.showInformationMessage(
    `${WRITE_OPERATION_LABELS[op]} from VS Code isn't available yet: the Loom API endpoint hasn't been documented.`,
  );
  return false;
}

interface TaskPick extends vscode.QuickPickItem {
  task: Task;
}

export function taskQuickPickItem(task: Task): TaskPick {
  return {
    label: `${taskKey(task)}  ${cleanTitle(task.title)}`,
    description: formatStatus(task.status),
    detail: task.projectName || undefined,
    task,
  };
}

/** Lets the user choose among loaded tasks, loading the full assigned list if needed. */
export async function pickTask(ctx: LoomContext, placeHolder = 'Select a Loom task'): Promise<Task | undefined> {
  if (!ctx.service.scope) {
    void vscode.window.showInformationMessage("This workspace isn't a Loom project. Add a .loom file with project=<id> to its root.");
    return undefined;
  }
  if (ctx.service.all.status === 'idle') {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Loading Loom tasks…' },
      () => ctx.service.loadAll(),
    );
  }
  const tasks = ctx.service.knownTasks();
  if (tasks.length === 0) {
    void vscode.window.showInformationMessage('No Loom tasks are loaded yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(tasks.map(taskQuickPickItem), {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.task;
}

/** Accepts a Task, a tree node, or nothing (then prompts). */
export async function resolveTask(ctx: LoomContext, arg: unknown, placeHolder?: string): Promise<Task | undefined> {
  if (isTask(arg)) {
    return ctx.service.findTask(arg.id) ?? arg;
  }
  if (isTaskNode(arg)) {
    return ctx.service.findTask(arg.task.id) ?? arg.task;
  }
  return pickTask(ctx, placeHolder);
}

function isTask(v: unknown): v is Task {
  return typeof v === 'object' && v !== null && 'id' in v && 'taskNumber' in v && 'title' in v;
}

function isTaskNode(v: unknown): v is Extract<LoomNode, { kind: 'task' }> {
  return typeof v === 'object' && v !== null && (v as LoomNode).kind === 'task';
}

export function taskWebUrl(ctx: LoomContext, task: Task): vscode.Uri {
  return vscode.Uri.parse(buildTaskUrl(ctx.config.taskUrlTemplate(), ctx.config.webBaseUrl(), task), true);
}
