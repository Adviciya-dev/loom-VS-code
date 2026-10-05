import * as vscode from 'vscode';
import { TASK_STATUSES } from '../models/Task';
import { EMPTY_FILTERS } from '../services/taskQueries';
import { formatPriority, formatStatus } from '../utils/formatters';
import type { LoomContext } from './context';

/** Refresh, search and filtering for the Tasks view. */
export function registerTaskListCommands(ctx: LoomContext): vscode.Disposable[] {
  const { service } = ctx;

  return [
    vscode.commands.registerCommand('loom.refreshTasks', () =>
      vscode.window.withProgress({ location: { viewId: 'loom.tasks' } }, () => service.refresh()),
    ),

    vscode.commands.registerCommand('loom.internal.retry', (retry: unknown) => {
      if (typeof retry === 'function') {
        void retry();
      }
    }),

    vscode.commands.registerCommand('loom.search', async () => {
      const search = await vscode.window.showInputBox({
        title: 'Search Loom Tasks',
        prompt: 'Matches key, title, status, parent, sprint and test-case reference. Leave empty to clear.',
        value: service.filters.search,
        placeHolder: 'e.g. THE-129 or login bug',
      });
      if (search !== undefined) {
        service.setFilters({ ...service.filters, search: search.trim() });
      }
    }),

    vscode.commands.registerCommand('loom.filter', async () => {
      type FilterPick = vscode.QuickPickItem & { kind2: 'status' | 'priority'; value: string };
      const knownPriorities = new Set(['high', 'normal', ...service.knownTasks().map((t) => t.priority)]);
      const items: Array<FilterPick | vscode.QuickPickItem> = [
        { label: 'Status', kind: vscode.QuickPickItemKind.Separator },
        ...TASK_STATUSES.map(
          (s): FilterPick => ({
            label: formatStatus(s),
            kind2: 'status',
            value: s,
            picked: service.filters.statuses.includes(s),
          }),
        ),
        { label: 'Priority', kind: vscode.QuickPickItemKind.Separator },
        ...[...knownPriorities].map(
          (p): FilterPick => ({
            label: formatPriority(p),
            kind2: 'priority',
            value: p,
            picked: service.filters.priorities.includes(p),
          }),
        ),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: 'Filter Loom Tasks',
        placeHolder: 'Show only tasks with these statuses and priorities',
        canPickMany: true,
      });
      if (!picked) {
        return;
      }
      const chosen = picked.filter((p): p is FilterPick => 'kind2' in p);
      service.setFilters({
        ...service.filters,
        statuses: chosen.filter((p) => p.kind2 === 'status').map((p) => p.value),
        priorities: chosen.filter((p) => p.kind2 === 'priority').map((p) => p.value),
      });
    }),

    vscode.commands.registerCommand('loom.clearFilters', () => service.setFilters(EMPTY_FILTERS)),
  ];
}
