import * as vscode from 'vscode';
import type { TaskWriteApi, WriteOperation } from '../api/TaskWriteApi';
import { parentTaskKey, taskKey, type Task } from '../models/Task';
import type { LoomUser } from '../models/User';
import {
  cleanTitle,
  extractTestCaseRef,
  formatApprovalStatus,
  formatDate,
  formatDateTime,
  formatMinutes,
  formatPriority,
  formatRelativeTime,
  formatStatus,
  isOverdue,
} from '../utils/formatters';
import { escapeHtml, sanitizeDescriptionHtml } from '../utils/sanitizer';
import { assigneeSummary } from './taskPresentation';
import { contentSecurityPolicy, createNonce } from './webviewUtils';

type FromWebview =
  | { type: 'command'; command: string }
  | { type: 'openLink'; href: string };

const ACTIONS: Array<{ op: WriteOperation; command: string; label: string }> = [
  { op: 'changeStatus', command: 'loom.changeStatus', label: 'Change Status' },
  { op: 'changePriority', command: 'loom.changePriority', label: 'Change Priority' },
  { op: 'assignTask', command: 'loom.assignTask', label: 'Assign' },
  { op: 'addComment', command: 'loom.addComment', label: 'Add Comment' },
];

const ALLOWED_COMMANDS = new Set(['loom.openInBrowser', 'loom.copyTaskKey', ...ACTIONS.map((a) => a.command)]);

/**
 * Read-only task detail. A webview is used because descriptions are rich HTML;
 * the HTML is sanitized and rendered under a strict CSP with no remote content.
 */
export class TaskDetailView {
  private panel: vscode.WebviewPanel | undefined;
  private task: Task | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly writeApi: TaskWriteApi,
    private readonly currentUser: () => LoomUser | null,
  ) {}

  get currentTaskId(): string | undefined {
    return this.panel ? this.task?.id : undefined;
  }

  show(task: Task): void {
    this.task = task;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('loom.taskDetail', taskKey(task), vscode.ViewColumn.Active, {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      });
      this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
      this.panel.webview.onDidReceiveMessage((msg: FromWebview) => this.handleMessage(msg));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.task = undefined;
      });
    } else {
      this.panel.reveal(undefined, false);
    }
    this.render();
  }

  /** Re-renders with fresher data if the open task was reloaded. */
  update(task: Task | undefined): void {
    if (this.panel && task && task.id === this.task?.id) {
      this.task = task;
      this.render();
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private handleMessage(msg: FromWebview): void {
    if (!this.task) {
      return;
    }
    if (msg.type === 'command' && ALLOWED_COMMANDS.has(msg.command)) {
      void vscode.commands.executeCommand(msg.command, this.task);
    } else if (msg.type === 'openLink' && typeof msg.href === 'string') {
      try {
        const uri = vscode.Uri.parse(msg.href, true);
        if (['http', 'https', 'mailto'].includes(uri.scheme)) {
          void vscode.env.openExternal(uri);
        }
      } catch {
        // Ignore malformed links.
      }
    }
  }

  private render(): void {
    if (!this.panel || !this.task) {
      return;
    }
    const task = this.task;
    this.panel.title = taskKey(task);
    this.panel.webview.html = this.html(this.panel.webview, task);
  }

  private html(webview: vscode.Webview, task: Task): string {
    const nonce = createNonce();
    const e = escapeHtml;
    const tc = extractTestCaseRef(task.title);
    const description = sanitizeDescriptionHtml(task.description);
    const overdue = isOverdue(task.dueDate, task.status);
    const parentKey = parentTaskKey(task);

    const field = (label: string, value: string | null, extraClass = '') =>
      value ? `<div class="field"><dt>${e(label)}</dt><dd class="${extraClass}">${e(value)}</dd></div>` : '';

    const progress = (label: string, done: number, total: number) => {
      if (total <= 0) {
        return '';
      }
      const pct = Math.round((Math.min(done, total) / total) * 100);
      return `<div class="field"><dt>${e(label)}</dt><dd>
        <div class="progress" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${total}" aria-label="${e(label)}">
          <span data-pct="${pct}"></span>
        </div>
        <span class="muted">${done} of ${total} done</span></dd></div>`;
    };

    const actions = ACTIONS.map(({ op, command, label }) => {
      const supported = this.writeApi.supports(op);
      return `<button class="secondary" data-command="${command}" ${supported ? '' : 'disabled title="Not available yet: the Loom API endpoint hasn\'t been documented"'}>${e(label)}</button>`;
    }).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${e(taskKey(task))}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 24px 32px 48px;
    line-height: 1.5;
  }
  main { max-width: 960px; margin: 0 auto; }
  .key { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); font-size: 0.95em; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  h1 { font-size: 1.6em; font-weight: 600; margin: 6px 0 12px; line-height: 1.3; overflow-wrap: anywhere; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 1px 8px; border-radius: 10px; font-size: 0.85em; font-weight: 500;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    white-space: nowrap;
  }
  .badge.status-done, .badge.status-live_build { background: var(--vscode-testing-iconPassed, #388a34); color: #fff; }
  .badge.status-in_progress, .badge.status-stage_deployement { background: var(--vscode-charts-blue, #3794ff); color: #fff; }
  .badge.status-reopen, .badge.blocked { background: var(--vscode-charts-red, #f14c4c); color: #fff; }
  .badge.status-on_hold { background: var(--vscode-charts-orange, #d18616); color: #fff; }
  .badge.status-in_review { background: var(--vscode-charts-purple, #b180d7); color: #fff; }
  .badge.status-to_be_tested { background: var(--vscode-charts-yellow, #cca700); color: #000; }
  .badge.priority-high, .badge.priority-urgent { background: transparent; color: var(--vscode-charts-red, #f14c4c); border: 1px solid currentColor; }
  .badge.tc { background: transparent; color: var(--vscode-textLink-foreground); border: 1px solid currentColor; font-family: var(--vscode-editor-font-family); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  button {
    font: inherit; padding: 4px 12px; border-radius: 2px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    color: var(--vscode-button-foreground); background: var(--vscode-button-background);
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 32px; align-items: start; }
  @media (max-width: 720px) { .layout { grid-template-columns: 1fr; } body { padding: 16px; } }
  h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin: 0 0 8px; font-weight: 600; }
  .description { overflow-wrap: anywhere; }
  .description :first-child { margin-top: 0; }
  .description code, .description pre {
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
    background: var(--vscode-textCodeBlock-background); border-radius: 3px;
  }
  .description code { padding: 1px 4px; }
  .description pre { padding: 8px 12px; overflow-x: auto; }
  .description pre code { padding: 0; background: none; }
  .description a { color: var(--vscode-textLink-foreground); }
  .description blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-textBlockQuote-foreground, inherit); }
  .description table { border-collapse: collapse; }
  .description td, .description th { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35)); padding: 4px 8px; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
  aside {
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.35));
    border-radius: 4px; padding: 16px;
    background: var(--vscode-sideBar-background, transparent);
  }
  dl { margin: 0; display: flex; flex-direction: column; gap: 12px; }
  dt { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .overdue { color: var(--vscode-errorForeground); font-weight: 600; }
  .muted { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .progress { height: 4px; border-radius: 2px; position: relative; margin: 4px 0; overflow: hidden; background: color-mix(in srgb, var(--vscode-progressBar-background, #0e70c0) 25%, transparent); }
  .progress span { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--vscode-progressBar-background, #0e70c0); }
  .footnote { margin-top: 24px; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<main>
  <div class="key">
    <span>${e(taskKey(task))}</span>
    ${task.projectName ? `<span>·</span><span>${e(task.projectName)}</span>` : ''}
    ${task.type ? `<span>·</span><span>${e(task.type[0].toUpperCase() + task.type.slice(1))}</span>` : ''}
  </div>
  <h1>${e(cleanTitle(task.title))}</h1>

  <div class="badges">
    <span class="badge status-${e(task.status)}">${e(formatStatus(task.status))}</span>
    <span class="badge priority-${e(task.priority)}">${e(formatPriority(task.priority))} priority</span>
    ${tc ? `<span class="badge tc" title="Related test case">TC ${e(tc)}</span>` : ''}
    ${task.isBlocked ? '<span class="badge blocked">Blocked</span>' : ''}
    ${task.requiresApproval || task.approvalStatus !== 'none' ? `<span class="badge">Approval: ${e(formatApprovalStatus(task.approvalStatus))}</span>` : ''}
    ${task.autoCompletedFromStatus ? `<span class="badge">Auto-completed from ${e(formatStatus(task.autoCompletedFromStatus))}</span>` : ''}
  </div>

  <div class="toolbar">
    <button data-command="loom.openInBrowser">Open in Loom</button>
    <button class="secondary" data-command="loom.copyTaskKey">Copy Key</button>
    ${actions}
  </div>

  <div class="layout">
    <section>
      <h2>Description</h2>
      <div class="description">${description || '<p class="empty">No description.</p>'}</div>
    </section>
    <aside>
      <dl>
        ${field('Assignee', assigneeSummary(task, this.currentUser()))}
        ${field('Due date', formatDate(task.dueDate) ? `${formatDate(task.dueDate)}${overdue ? ' (overdue)' : ''}` : null, overdue ? 'overdue' : '')}
        ${field('Start date', formatDate(task.startDate))}
        ${field('Parent task', task.parentTaskId ? [parentKey, task.parentTitle ? cleanTitle(task.parentTitle) : null].filter(Boolean).join(' ') : null)}
        ${progress('Subtasks', task.subtaskDoneCount, task.subtaskCount)}
        ${progress('Dependencies', task.dependencyDoneCount, task.dependencyCount)}
        ${field('Sprint', task.sprintName ? `${task.sprintName}${task.sprintIsActive ? ' (active)' : ''}` : null)}
        ${field('Estimate', formatMinutes(task.timeEstimateMinutes))}
        ${field('Approvers', task.requiresApproval ? `${task.approvedByIds.length} of ${task.approverIds.length} approved` : null)}
        ${field('Last activity', task.lastActivityAt ? `${formatRelativeTime(task.lastActivityAt)} (${formatDateTime(task.lastActivityAt)})` : null)}
        ${field('Created', formatDateTime(task.createdAt))}
        ${field('Updated', formatDateTime(task.updatedAt))}
      </dl>
    </aside>
  </div>
  ${ACTIONS.some((a) => !this.writeApi.supports(a.op)) ? '<p class="footnote">Editing from VS Code will be enabled as the Loom API endpoints become available.</p>' : ''}
</main>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('button[data-command]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      vscode.postMessage({ type: 'command', command: btn.getAttribute('data-command') });
    });
  });
  // Inline style attributes are blocked by the CSP, so widths are applied here.
  document.querySelectorAll('.progress span[data-pct]').forEach(function (bar) {
    bar.style.width = bar.getAttribute('data-pct') + '%';
  });
  document.querySelectorAll('.description a[href]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', href: a.getAttribute('href') });
    });
  });
})();
</script>
</body>
</html>`;
  }
}
