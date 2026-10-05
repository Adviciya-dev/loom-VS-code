import { TASK_STATUSES, parentTaskKey, taskKey, type Task } from '../models/Task';
import { cleanTitle, extractTestCaseRef, formatStatus } from '../utils/formatters';

export interface TaskFilters {
  search: string;
  statuses: string[];
  priorities: string[];
}

export const EMPTY_FILTERS: TaskFilters = { search: '', statuses: [], priorities: [] };

export type GroupMode = 'none' | 'project' | 'parent';

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
}

export function hasActiveFilters(filters: TaskFilters): boolean {
  return Boolean(filters.search.trim()) || filters.statuses.length > 0 || filters.priorities.length > 0;
}

/** Client-side filtering only; the server is never asked to filter beyond `assigneeId`. */
export function filterTasks(tasks: Task[], filters: TaskFilters): Task[] {
  const terms = filters.search.toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter((task) => {
    if (filters.statuses.length && !filters.statuses.includes(task.status)) {
      return false;
    }
    if (filters.priorities.length && !filters.priorities.includes(task.priority)) {
      return false;
    }
    if (!terms.length) {
      return true;
    }
    const haystack = [
      taskKey(task),
      task.title,
      cleanTitle(task.title),
      task.projectName,
      formatStatus(task.status),
      task.priority,
      task.parentTitle ?? '',
      task.sprintName ?? '',
      extractTestCaseRef(task.title) ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function byLabel(a: TaskGroup, b: TaskGroup): number {
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
}

export function groupByProject(tasks: Task[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = task.projectId || `name:${task.projectName}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: task.projectName || 'No project', tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()].sort(byLabel);
}

export const NO_PARENT_KEY = '__no_parent__';

export function groupByParent(tasks: Task[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const key = task.parentTaskId ?? NO_PARENT_KEY;
    let group = groups.get(key);
    if (!group) {
      const parentKey = parentTaskKey(task);
      const label =
        key === NO_PARENT_KEY
          ? 'No parent task'
          : [parentKey, task.parentTitle ? cleanTitle(task.parentTitle) : null].filter(Boolean).join(' ') || 'Parent task';
      group = { key, label, tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  const noParent = groups.get(NO_PARENT_KEY);
  groups.delete(NO_PARENT_KEY);
  const sorted = [...groups.values()].sort(byLabel);
  return noParent ? [...sorted, noParent] : sorted;
}

/** Known statuses in workflow order, then any unknown statuses that appear in the data. */
export function groupByStatus(tasks: Task[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const status of TASK_STATUSES) {
    groups.set(status, { key: status, label: formatStatus(status), tasks: [] });
  }
  for (const task of tasks) {
    let group = groups.get(task.status);
    if (!group) {
      group = { key: task.status, label: formatStatus(task.status), tasks: [] };
      groups.set(task.status, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()];
}

export function groupTasks(tasks: Task[], mode: GroupMode): TaskGroup[] | null {
  switch (mode) {
    case 'project':
      return groupByProject(tasks);
    case 'parent':
      return groupByParent(tasks);
    default:
      return null;
  }
}

export interface TaskTreeEntry {
  task: Task;
  children: TaskTreeEntry[];
}

/**
 * Nests subtasks under their parent when the parent is in the same list, at any
 * depth. A subtask whose parent isn't in the list stays at the top level.
 * Input order is preserved at every level.
 */
export function nestTasks(tasks: Task[]): TaskTreeEntry[] {
  const entries = new Map<string, TaskTreeEntry>();
  for (const task of tasks) {
    entries.set(task.id, { task, children: [] });
  }
  const roots: TaskTreeEntry[] = [];
  for (const task of tasks) {
    const entry = entries.get(task.id)!;
    const parent = task.parentTaskId ? entries.get(task.parentTaskId) : undefined;
    if (parent && parent !== entry && !isAncestor(entry, parent)) {
      parent.children.push(entry);
    } else {
      roots.push(entry);
    }
  }
  return roots;
}

/** Guards against a parent cycle in bad data, which would otherwise hide tasks. */
function isAncestor(candidate: TaskTreeEntry, of: TaskTreeEntry): boolean {
  const stack = [...candidate.children];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === of) {
      return true;
    }
    stack.push(...next.children);
  }
  return false;
}

/** Statuses that count as finished, matching `isOverdue`. */
export const COMPLETE_STATUSES: readonly string[] = ['done', 'live_build'];

export interface TaskSummary {
  total: number;
  done: number;
  remaining: number;
  /** Whole-number percentage of tasks done; 0 when there are no tasks. */
  percent: number;
  overdue: number;
  /** Not done, not overdue, due within the next 7 days (today included). */
  dueSoon: number;
  blocked: number;
}

export function summarizeTasks(tasks: Task[], now: Date = new Date()): TaskSummary {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekEnd = startOfToday + 8 * 24 * 60 * 60 * 1000;
  let done = 0;
  let overdue = 0;
  let dueSoon = 0;
  let blocked = 0;
  for (const task of tasks) {
    if (COMPLETE_STATUSES.includes(task.status)) {
      done++;
      continue;
    }
    if (task.isBlocked) {
      blocked++;
    }
    const due = task.dueDate ? Date.parse(task.dueDate) : NaN;
    if (Number.isNaN(due)) {
      continue;
    }
    if (due < startOfToday) {
      overdue++;
    } else if (due < weekEnd) {
      dueSoon++;
    }
  }
  const total = tasks.length;
  return {
    total,
    done,
    remaining: total - done,
    percent: total ? Math.round((done / total) * 100) : 0,
    overdue,
    dueSoon,
    blocked,
  };
}
