import * as vscode from 'vscode';
import { AuthRequiredError, NetworkError } from '../api/ApiTypes';
import { taskKey, type Task } from '../models/Task';
import {
  filterTasks,
  groupByStatus,
  hasActiveFilters,
  nestTasks,
  type TaskGroup,
  type TaskTreeEntry,
} from '../services/taskQueries';
import type { TaskService } from '../services/TaskService';
import { cleanTitle } from '../utils/formatters';
import { statusIcon, treeDescription, treeTooltip } from './taskPresentation';

/** Status groups that start collapsed, so finished work doesn't crowd the list. */
const COLLAPSED_STATUSES = new Set(['done', 'live_build']);

export type LoomNode =
  | { kind: 'group'; group: TaskGroup }
  | { kind: 'task'; parentKey: string; task: Task; children: TaskTreeEntry[] }
  | { kind: 'message'; id: string; label: string; icon?: string; tooltip?: string; command?: vscode.Command };

/**
 * The Loom "My Tasks" sidebar: tasks assigned to the current user in the
 * workspace's Loom project, grouped by status, with subtasks nested under
 * their parents within each status. Pure
 * presentation over TaskService state. When the workspace has no `.loom` file
 * the tree is empty and the view's welcome content explains why.
 */
export class LoomTreeProvider implements vscode.TreeDataProvider<LoomNode> {
  private readonly changeEmitter = new vscode.EventEmitter<LoomNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly service: TaskService) {
    service.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getChildren(node?: LoomNode): LoomNode[] {
    if (!node) {
      return this.service.scope ? this.rootChildren() : [];
    }
    if (node.kind === 'group') {
      return this.taskNodes(nestTasks(node.group.tasks), node.group.key);
    }
    if (node.kind === 'task') {
      return this.taskNodes(node.children, `${node.parentKey}/${node.task.id}`);
    }
    return [];
  }

  getTreeItem(node: LoomNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group':
        return this.groupItem(node);
      case 'task':
        return this.taskItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.label);
        item.id = `msg:${node.id}`;
        item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
        item.tooltip = node.tooltip;
        item.command = node.command;
        return item;
      }
    }
  }

  private rootChildren(): LoomNode[] {
    const state = this.service.all;
    const all = this.service.allValue();
    const pending = this.stateMessage();
    if (!all) {
      return pending ? [pending] : [{ kind: 'message', id: 'loading', label: 'Loading…', icon: 'loading~spin' }];
    }

    const nodes: LoomNode[] = pending ? [pending] : [];
    const scoped = this.service.inScope(all.tasks);
    const tasks = filterTasks(scoped, this.service.filters);
    if (tasks.length === 0) {
      nodes.push(this.emptyMessage(scoped.length > 0));
    } else {
      nodes.push(
        ...groupByStatus(tasks)
          .filter((g) => g.tasks.length > 0)
          .map((group): LoomNode => ({ kind: 'group', group })),
      );
    }

    if (all.skipped > 0) {
      nodes.push({
        kind: 'message',
        id: 'skipped',
        label: `${all.skipped} task${all.skipped === 1 ? '' : 's'} couldn't be displayed`,
        icon: 'warning',
        tooltip: 'Some tasks had unexpected data. See Loom: Show Logs.',
        command: { command: 'loom.showLogs', title: 'Show Logs' },
      });
    }
    if (all.truncated && state.status === 'loaded') {
      nodes.push({
        kind: 'message',
        id: 'truncated',
        label: `Showing tasks from the first ${all.pagesFetched} pages only`,
        icon: 'info',
        tooltip: 'The 50-page limit was reached. Older tasks are not listed.',
      });
    }
    return nodes;
  }

  private taskNodes(entries: TaskTreeEntry[], parentKey: string): LoomNode[] {
    return entries.map((e): LoomNode => ({ kind: 'task', parentKey, task: e.task, children: e.children }));
  }

  private stateMessage(): LoomNode | null {
    const state = this.service.all;
    if (state.status === 'loading') {
      return { kind: 'message', id: 'loading', label: 'Loading…', icon: 'loading~spin' };
    }
    if (state.status === 'error') {
      const err = state.error;
      if (err instanceof AuthRequiredError) {
        return {
          kind: 'message',
          id: 'auth',
          label: 'Sign in to load tasks',
          icon: 'sign-in',
          command: { command: 'loom.login', title: 'Sign In' },
        };
      }
      const retry = () => this.service.loadAll({ force: true });
      return {
        kind: 'message',
        id: 'error',
        label: err instanceof NetworkError ? "Couldn't reach Loom — click to retry" : 'Failed to load — click to retry',
        icon: 'error',
        tooltip: err.message,
        command: { command: 'loom.internal.retry', title: 'Retry', arguments: [retry] },
      };
    }
    return null;
  }

  private emptyMessage(filteredOut: boolean): LoomNode {
    if (filteredOut || hasActiveFilters(this.service.filters)) {
      return {
        kind: 'message',
        id: 'filtered',
        label: 'No tasks match the current filters',
        icon: 'filter',
        command: { command: 'loom.clearFilters', title: 'Clear Filters' },
        tooltip: 'Click to clear search and filters',
      };
    }
    return { kind: 'message', id: 'empty', label: 'No tasks assigned to you in this project', icon: 'check-all' };
  }

  private groupItem(node: Extract<LoomNode, { kind: 'group' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.group.label,
      COLLAPSED_STATUSES.has(node.group.key)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `status:${node.group.key}`;
    item.description = String(node.group.tasks.length);
    item.contextValue = 'loomGroup';
    item.iconPath = statusIcon(node.group.key);
    return item;
  }

  private taskItem(node: Extract<LoomNode, { kind: 'task' }>): vscode.TreeItem {
    const { task } = node;
    const item = new vscode.TreeItem(
      `${taskKey(task)}  ${cleanTitle(task.title)}`,
      node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `task:${node.parentKey}:${task.id}`;
    item.description = treeDescription(task);
    item.tooltip = treeTooltip(task, this.service.user);
    item.iconPath = task.isBlocked ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')) : statusIcon(task.status);
    item.contextValue = 'loomTask';
    item.command = { command: 'loom.viewTaskDetails', title: 'View Task Details', arguments: [task] };
    item.accessibilityInformation = { label: `${taskKey(task)} ${cleanTitle(task.title)}, ${treeDescription(task)}` };
    return item;
  }
}
