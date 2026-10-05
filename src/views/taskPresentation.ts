import * as vscode from 'vscode';
import { isKnownStatus, parentTaskKey, taskKey, type KnownTaskStatus, type Task } from '../models/Task';
import type { LoomUser } from '../models/User';
import {
  cleanTitle,
  extractTestCaseRef,
  formatApprovalStatus,
  formatDate,
  formatMinutes,
  formatPriority,
  formatRelativeTime,
  formatStatus,
  isOverdue,
} from '../utils/formatters';
import { descriptionPreview } from '../utils/sanitizer';

const STATUS_ICONS: Record<KnownTaskStatus, [string, string | undefined]> = {
  todo: ['circle-large-outline', undefined],
  in_progress: ['play-circle', 'charts.blue'],
  in_review: ['eye', 'charts.purple'],
  to_be_tested: ['beaker', 'charts.yellow'],
  reopen: ['issue-reopened', 'charts.red'],
  on_hold: ['debug-pause', 'charts.orange'],
  stage_deployement: ['rocket', 'charts.blue'],
  live_build: ['globe', 'charts.green'],
  done: ['pass-filled', 'charts.green'],
};

export function statusIcon(status: string): vscode.ThemeIcon {
  if (!isKnownStatus(status)) {
    return new vscode.ThemeIcon('circle-outline');
  }
  const [icon, color] = STATUS_ICONS[status];
  return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
}

export function assigneeSummary(task: Task, me: LoomUser | null): string {
  if (task.assigneeIds.length === 0) {
    return 'Unassigned';
  }
  const includesMe = me !== null && task.assigneeIds.includes(me.id);
  const others = task.assigneeIds.length - (includesMe ? 1 : 0);
  if (includesMe) {
    return others > 0 ? `You + ${others} other${others === 1 ? '' : 's'}` : 'You';
  }
  return `${task.assigneeIds.length} assignee${task.assigneeIds.length === 1 ? '' : 's'}`;
}

/** Short one-line description shown next to the task title in the tree. */
export function treeDescription(task: Task): string {
  const parts: string[] = [];
  const tc = extractTestCaseRef(task.title);
  if (tc) {
    parts.push(`[${tc}]`);
  }
  parts.push(formatStatus(task.status));
  if (task.priority && task.priority !== 'normal') {
    parts.push(formatPriority(task.priority));
  }
  const due = formatDate(task.dueDate);
  if (due) {
    parts.push(isOverdue(task.dueDate, task.status) ? `⚠ Due ${due}` : `Due ${due}`);
  }
  if (task.subtaskCount > 0) {
    parts.push(`${task.subtaskDoneCount}/${task.subtaskCount} subtasks`);
  }
  if (task.isBlocked) {
    parts.push('Blocked');
  }
  return parts.join(' · ');
}

function md(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export function treeTooltip(task: Task, me: LoomUser | null): vscode.MarkdownString {
  const rows: Array<[string, string | null]> = [
    ['Status', formatStatus(task.status)],
    ['Priority', formatPriority(task.priority)],
    ['Project', task.projectName || null],
    ['Assignee', assigneeSummary(task, me)],
    ['Due', formatDate(task.dueDate)],
    ['Last activity', formatRelativeTime(task.lastActivityAt)],
    ['Parent', task.parentTaskId ? [parentTaskKey(task), task.parentTitle ? cleanTitle(task.parentTitle) : null].filter(Boolean).join(' ') : null],
    ['Subtasks', task.subtaskCount > 0 ? `${task.subtaskDoneCount} of ${task.subtaskCount} done` : null],
    [
      'Dependencies',
      task.dependencyCount > 0
        ? `${task.dependencyDoneCount} of ${task.dependencyCount} done${task.isBlocked ? ' (blocked)' : ''}`
        : task.isBlocked
          ? 'Blocked'
          : null,
    ],
    ['Approval', task.requiresApproval || task.approvalStatus !== 'none' ? formatApprovalStatus(task.approvalStatus) : null],
    ['Sprint', task.sprintName ? `${task.sprintName}${task.sprintIsActive ? ' (active)' : ''}` : null],
    ['Estimate', formatMinutes(task.timeEstimateMinutes)],
  ];

  const out = new vscode.MarkdownString(undefined, true);
  out.supportHtml = false;
  out.isTrusted = false;
  const tc = extractTestCaseRef(task.title);
  out.appendMarkdown(`**${md(taskKey(task))}** ${md(cleanTitle(task.title))}`);
  if (tc) {
    out.appendMarkdown(`  \n$(beaker) Related TC: \`${tc}\``);
  }
  out.appendMarkdown('\n\n');
  for (const [label, value] of rows) {
    if (value) {
      out.appendMarkdown(`${label}: ${md(value)}  \n`);
    }
  }
  const preview = descriptionPreview(task.description);
  if (preview) {
    out.appendMarkdown(`\n---\n\n${md(preview)}`);
  }
  return out;
}
