import * as vscode from 'vscode';
import { TASK_STATUSES, taskKey } from '../models/Task';
import { formatPriority, formatStatus } from '../utils/formatters';
import { ensureSupported, pickTask, resolveTask, showError, taskWebUrl, type LoomContext } from './context';

/** Viewing, opening and editing individual tasks. */
export function registerTaskCommands(ctx: LoomContext): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('loom.viewTaskDetails', async (arg?: unknown) => {
      const task = await resolveTask(ctx, arg);
      if (task) {
        ctx.detailView.show(task);
      }
    }),

    vscode.commands.registerCommand('loom.openTask', async () => {
      const task = await pickTask(ctx, 'Search by key (e.g. THE-129), title or project');
      if (task) {
        ctx.detailView.show(task);
      }
    }),

    vscode.commands.registerCommand('loom.openInBrowser', async (arg?: unknown) => {
      const task = await resolveTask(ctx, arg, 'Select a task to open in Loom');
      if (!task) {
        return;
      }
      try {
        await vscode.env.openExternal(taskWebUrl(ctx, task));
      } catch (err) {
        await showError(err, 'Open in Loom');
      }
    }),

    vscode.commands.registerCommand('loom.copyTaskKey', async (arg?: unknown) => {
      const task = await resolveTask(ctx, arg);
      if (task) {
        await vscode.env.clipboard.writeText(taskKey(task));
        void vscode.window.setStatusBarMessage(`Copied ${taskKey(task)}`, 2500);
      }
    }),

    vscode.commands.registerCommand('loom.changeStatus', async (arg?: unknown) => {
      if (!ensureSupported(ctx, 'changeStatus')) {
        return;
      }
      const task = await resolveTask(ctx, arg, 'Select the task to update');
      if (!task) {
        return;
      }
      const picked = await vscode.window.showQuickPick(
        TASK_STATUSES.map((s) => ({
          label: formatStatus(s),
          description: s === task.status ? '(current)' : undefined,
          value: s,
        })),
        { title: `Change status of ${taskKey(task)}` },
      );
      if (!picked || picked.value === task.status) {
        return;
      }
      try {
        const updated = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Moving ${taskKey(task)} to ${picked.label}…` },
          () => ctx.writeApi.changeStatus(task, picked.value),
        );
        ctx.service.applyTaskUpdate(updated);
        void vscode.window.setStatusBarMessage(`${taskKey(task)} → ${formatStatus(updated.status)}`, 3000);
      } catch (err) {
        await showError(err, 'Change status');
      }
    }),

    vscode.commands.registerCommand('loom.changePriority', async (arg?: unknown) => {
      if (!ensureSupported(ctx, 'changePriority')) {
        return;
      }
      const task = await resolveTask(ctx, arg, 'Select the task to update');
      if (!task) {
        return;
      }
      const picked = await vscode.window.showQuickPick(
        ['high', 'normal'].map((p) => ({
          label: formatPriority(p),
          description: p === task.priority ? '(current)' : undefined,
          value: p,
        })),
        { title: `Change priority of ${taskKey(task)}` },
      );
      if (!picked || picked.value === task.priority) {
        return;
      }
      try {
        await ctx.writeApi.changePriority(task.id, picked.value);
        await ctx.service.refresh();
      } catch (err) {
        await showError(err, 'Change priority');
      }
    }),

    vscode.commands.registerCommand('loom.addComment', async (arg?: unknown) => {
      if (!ensureSupported(ctx, 'addComment')) {
        return;
      }
      const task = await resolveTask(ctx, arg, 'Select the task to comment on');
      if (!task) {
        return;
      }
      const body = await vscode.window.showInputBox({
        title: `Comment on ${taskKey(task)}`,
        prompt: 'Comment',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'Enter a comment'),
      });
      if (!body) {
        return;
      }
      try {
        await ctx.writeApi.addComment(task.id, body.trim());
        void vscode.window.setStatusBarMessage(`Comment added to ${taskKey(task)}`, 2500);
      } catch (err) {
        await showError(err, 'Add comment');
      }
    }),

    vscode.commands.registerCommand('loom.showLogs', () => ctx.output.show(true)),
  ];
}
