import * as vscode from 'vscode';
import { taskKey } from '../models/Task';
import { formatPriority } from '../utils/formatters';
import { ensureSupported, showError, type LoomContext } from './context';

/**
 * `Loom: Create Task…`. The input flow is complete, but it only runs once a
 * create endpoint is implemented in the TaskWriteApi — until then the command
 * explains why it is unavailable instead of collecting input it can't use.
 */
export function registerCreateTask(ctx: LoomContext): vscode.Disposable {
  return vscode.commands.registerCommand('loom.createTask', async () => {
    if (!ensureSupported(ctx, 'createTask')) {
      return;
    }

    // Projects are derived from loaded tasks; TODO(loom-api): use a projects endpoint once documented.
    const projects = new Map<string, string>();
    for (const t of ctx.service.knownTasks()) {
      if (t.projectId) {
        projects.set(t.projectId, t.projectName || t.projectTaskPrefix);
      }
    }
    if (projects.size === 0) {
      void vscode.window.showInformationMessage('No Loom projects are known yet. Refresh your tasks and try again.');
      return;
    }
    const project = await vscode.window.showQuickPick(
      [...projects].map(([id, name]) => ({ label: name, id })),
      { title: 'Create Loom Task (1/3)', placeHolder: 'Project' },
    );
    if (!project) {
      return;
    }

    const title = await vscode.window.showInputBox({
      title: 'Create Loom Task (2/3)',
      prompt: 'Title',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'A title is required'),
    });
    if (!title) {
      return;
    }

    const priority = await vscode.window.showQuickPick(
      ['normal', 'high'].map((p) => ({ label: formatPriority(p), value: p })),
      { title: 'Create Loom Task (3/3)', placeHolder: 'Priority' },
    );
    if (!priority) {
      return;
    }

    const me = ctx.service.user;
    try {
      const task = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating Loom task…' },
        () =>
          ctx.writeApi.createTask({
            projectId: project.id,
            title: title.trim(),
            priority: priority.value,
            assigneeIds: me ? [me.id] : [],
          }),
      );
      void vscode.window.showInformationMessage(`Created ${taskKey(task)}.`);
      await ctx.service.refresh();
    } catch (err) {
      await showError(err, 'Create task');
    }
  });
}
