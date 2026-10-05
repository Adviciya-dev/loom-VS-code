import * as vscode from 'vscode';
import { taskKey } from '../models/Task';
import { ensureSupported, resolveTask, showError, type LoomContext } from './context';

/** `Loom: Assign Task…` — covers both assigning and reassigning. */
export function registerAssignTask(ctx: LoomContext): vscode.Disposable {
  return vscode.commands.registerCommand('loom.assignTask', async (arg?: unknown) => {
    if (!ensureSupported(ctx, 'assignTask')) {
      return;
    }
    const task = await resolveTask(ctx, arg, 'Select the task to assign');
    if (!task) {
      return;
    }

    // TODO(loom-api): offer a people picker once a users/members endpoint is documented.
    const me = ctx.service.user;
    type Choice = vscode.QuickPickItem & { ids?: string[]; custom?: boolean };
    const choices: Choice[] = [];
    if (me) {
      choices.push({ label: '$(person) Assign to me', ids: [...new Set([...task.assigneeIds, me.id])] });
      choices.push({ label: '$(arrow-swap) Reassign to me only', ids: [me.id] });
    }
    choices.push({ label: '$(edit) Enter user IDs…', custom: true });
    if (task.assigneeIds.length) {
      choices.push({ label: '$(circle-slash) Unassign everyone', ids: [] });
    }

    const picked = await vscode.window.showQuickPick(choices, { title: `Assign ${taskKey(task)}` });
    if (!picked) {
      return;
    }
    let ids = picked.ids;
    if (picked.custom) {
      const input = await vscode.window.showInputBox({
        title: `Assign ${taskKey(task)}`,
        prompt: 'Comma-separated Loom user IDs',
        value: task.assigneeIds.join(', '),
      });
      if (input === undefined) {
        return;
      }
      ids = input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    try {
      await ctx.writeApi.assignTask(task.id, ids ?? []);
      void vscode.window.showInformationMessage(`Updated assignees for ${taskKey(task)}.`);
      await ctx.service.refresh();
    } catch (err) {
      await showError(err, 'Assign task');
    }
  });
}
