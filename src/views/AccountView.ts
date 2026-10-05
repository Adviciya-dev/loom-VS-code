import * as vscode from 'vscode';
import { initials, type LoomUser } from '../models/User';
import { groupByStatus, summarizeTasks, type TaskGroup, type TaskSummary } from '../services/taskQueries';
import type { TaskService } from '../services/TaskService';
import { escapeHtml } from '../utils/sanitizer';
import { contentSecurityPolicy, createNonce } from './webviewUtils';

type FromWebview =
  | { type: 'ready' }
  | { type: 'filterStatus'; status: string }
  | { type: 'openGithub' }
  | { type: 'linkProject' }
  | { type: 'retry' };

/** CSS class per status; colours come from the theme, matching the tree's status icons. */
const STATUS_CLASS: Record<string, string> = {
  todo: 's-todo',
  in_progress: 's-progress',
  in_review: 's-review',
  to_be_tested: 's-test',
  reopen: 's-reopen',
  on_hold: 's-hold',
  stage_deployement: 's-stage',
  live_build: 's-live',
  done: 's-done',
};

const RADIUS = 40;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Account section: the signed-in user plus an overview of their tasks in the
 * workspace's Loom project, drawn as a status donut. A webview is used because
 * a native tree can't draw a chart. Content is rebuilt in the extension
 * (escaped) and swapped in by the page, so updates don't flicker.
 */
export class AccountView implements vscode.WebviewViewProvider {
  static readonly viewId = 'loom.account';

  private view: vscode.WebviewView | undefined;

  constructor(private readonly service: TaskService) {
    service.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.shell(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.handleMessage(msg));
    view.onDidChangeVisibility(() => this.update());
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  private handleMessage(msg: FromWebview): void {
    switch (msg?.type) {
      case 'ready':
        this.update();
        break;
      case 'filterStatus': {
        if (typeof msg.status !== 'string') {
          return;
        }
        const f = this.service.filters;
        const only = f.statuses.length === 1 && f.statuses[0] === msg.status;
        this.service.setFilters({ ...f, statuses: only ? [] : [msg.status] });
        void vscode.commands.executeCommand('loom.tasks.focus');
        break;
      }
      case 'openGithub': {
        const gh = this.service.user?.githubUsername;
        if (gh) {
          void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${encodeURIComponent(gh)}`));
        }
        break;
      }
      case 'linkProject':
        void vscode.commands.executeCommand('loom.linkProject');
        break;
      case 'retry':
        void this.service.refresh();
        break;
    }
  }

  private update(): void {
    if (this.view?.visible) {
      void this.view.webview.postMessage({ type: 'render', html: this.body() });
    }
  }

  // --- Content -------------------------------------------------------------

  private body(): string {
    const state = this.service.userState;
    if (state.status === 'idle' || state.status === 'loading') {
      return `<p class="muted">Loading profile…</p>`;
    }
    if (state.status === 'error') {
      return `<p class="muted">Could not load your profile.</p><button class="link" data-msg="retry">Retry</button>`;
    }
    return this.profile(state.value) + this.overview();
  }

  private profile(user: LoomUser): string {
    const gh = user.githubUsername
      ? `<button class="link" data-msg="openGithub" title="Open GitHub profile">@${escapeHtml(user.githubUsername)}</button>`
      : '';
    return `<header class="profile">
  <div class="avatar" aria-hidden="true">${escapeHtml(initials(user))}</div>
  <div class="who">
    <div class="name">${escapeHtml(user.name)}${user.role ? ` <span class="role">${escapeHtml(user.role)}</span>` : ''}</div>
    <div class="muted">${escapeHtml(user.email)}</div>
    ${gh}
  </div>
</header>`;
  }

  private overview(): string {
    if (!this.service.scope) {
      return `<section class="card empty">
  <p>This isn't a Loom project, so there's no task overview.</p>
  <button class="link" data-msg="linkProject">Link to Loom Project</button>
</section>`;
    }
    const all = this.service.allValue();
    if (!all) {
      return this.service.all.status === 'error'
        ? `<section class="card empty"><p>Couldn't load tasks.</p><button class="link" data-msg="retry">Retry</button></section>`
        : `<section class="card empty"><p class="muted">Loading tasks…</p></section>`;
    }
    const tasks = this.service.inScope(all.tasks);
    const project = tasks.find((t) => t.projectName)?.projectName;
    const heading = `<h2>${project ? escapeHtml(project) : 'Project'} <span class="muted">· your tasks</span></h2>`;
    if (tasks.length === 0) {
      return `<section class="card">${heading}<p class="muted">No tasks assigned to you in this project.</p></section>`;
    }
    const summary = summarizeTasks(tasks);
    const groups = groupByStatus(tasks).filter((g) => g.tasks.length > 0);
    return `<section class="card">
  ${heading}
  <div class="chart">${this.donut(groups, summary)}${this.legend(groups)}</div>
  ${this.tiles(summary)}
</section>`;
  }

  private donut(groups: TaskGroup[], s: TaskSummary): string {
    let offset = 0;
    const arcs = groups
      .map((g) => {
        const len = (g.tasks.length / s.total) * CIRCUMFERENCE;
        const arc = `<circle class="arc ${STATUS_CLASS[g.key] ?? 's-other'}" r="${RADIUS}" cx="50" cy="50"
  stroke-dasharray="${len.toFixed(2)} ${(CIRCUMFERENCE - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
  data-msg="filterStatus" data-status="${escapeHtml(g.key)}"><title>${escapeHtml(g.label)}: ${g.tasks.length}</title></circle>`;
        offset += len;
        return arc;
      })
      .join('');
    return `<svg class="donut" viewBox="0 0 100 100" role="img" aria-label="${s.percent}% done, ${s.done} of ${s.total} tasks">
  <circle class="track" r="${RADIUS}" cx="50" cy="50"/>
  <g transform="rotate(-90 50 50)">${arcs}</g>
  <text x="50" y="47" class="pct">${s.percent}%</text>
  <text x="50" y="62" class="sub">${s.done}/${s.total} done</text>
</svg>`;
  }

  private legend(groups: TaskGroup[]): string {
    const active = this.service.filters.statuses;
    const rows = groups
      .map((g) => {
        const on = active.length === 1 && active[0] === g.key;
        return `<li><button class="row${on ? ' on' : ''}" data-msg="filterStatus" data-status="${escapeHtml(g.key)}"
  title="${on ? 'Show all statuses' : `Show only ${escapeHtml(g.label)} in My Tasks`}">
  <span class="dot ${STATUS_CLASS[g.key] ?? 's-other'}"></span><span class="lbl">${escapeHtml(g.label)}</span><span class="n">${g.tasks.length}</span>
</button></li>`;
      })
      .join('');
    return `<ul class="legend">${rows}</ul>`;
  }

  private tiles(s: TaskSummary): string {
    const tile = (value: number, label: string, tone = '') =>
      `<div class="tile${value && tone ? ` ${tone}` : ''}"><div class="v">${value}</div><div class="k">${label}</div></div>`;
    return `<div class="tiles">
  ${tile(s.remaining, 'Remaining')}
  ${tile(s.overdue, 'Overdue', 'bad')}
  ${tile(s.dueSoon, 'Due ≤ 7 days', 'warn')}
  ${tile(s.blocked, 'Blocked', 'bad')}
</div>`;
  }

  // --- Page shell ------------------------------------------------------------

  private shell(webview: vscode.Webview): string {
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 12px 12px; margin: 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .link { color: var(--vscode-textLink-foreground); }
  .link:hover { text-decoration: underline; }

  .profile { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
  .avatar { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 600; color: #fff; background: linear-gradient(135deg, #6366f1, #312e81); }
  .who { min-width: 0; line-height: 1.35; }
  .who > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name { font-weight: 600; }
  .role { font-weight: 400; font-size: 0.85em; padding: 0 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 6px; padding: 10px; }
  .card.empty p { margin: 0 0 6px; }
  h2 { font-size: 1em; font-weight: 600; margin: 0 0 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h2 .muted { font-weight: 400; }

  .chart { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .donut { width: 112px; height: 112px; flex: none; }
  .track { fill: none; stroke: var(--vscode-editorWidget-background, rgba(128,128,128,.15)); stroke-width: 14; }
  .arc { fill: none; stroke-width: 14; cursor: pointer; transition: stroke-width .1s; }
  .arc:hover { stroke-width: 17; }
  .pct { text-anchor: middle; font-size: 18px; font-weight: 700; fill: var(--vscode-foreground); }
  .sub { text-anchor: middle; font-size: 8.5px; fill: var(--vscode-descriptionForeground); }

  .legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 120px; }
  .row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px 4px; border-radius: 4px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.on { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .lbl { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { font-variant-numeric: tabular-nums; opacity: .85; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 6px; margin-top: 10px; }
  .tile { border-radius: 4px; padding: 6px 8px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.1)); }
  .tile .v { font-size: 1.35em; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile .k { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .tile.bad .v { color: var(--vscode-charts-red); }
  .tile.warn .v { color: var(--vscode-charts-yellow); }

  .s-todo     { --c: var(--vscode-descriptionForeground); }
  .s-progress { --c: var(--vscode-charts-blue); }
  .s-review   { --c: var(--vscode-charts-purple); }
  .s-test     { --c: var(--vscode-charts-yellow); }
  .s-reopen   { --c: var(--vscode-charts-red); }
  .s-hold     { --c: var(--vscode-charts-orange); }
  .s-stage    { --c: var(--vscode-terminal-ansiCyan, #0aa); }
  .s-live     { --c: var(--vscode-terminal-ansiBrightGreen, #5c5); }
  .s-done     { --c: var(--vscode-charts-green); }
  .s-other    { --c: var(--vscode-disabledForeground); }
  .arc { stroke: var(--c); }
  .dot { background: var(--c); }
</style>
</head>
<body>
<div id="root"><p class="muted">Loading…</p></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'render') root.innerHTML = e.data.html;
  });
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-msg]');
    if (el) vscode.postMessage({ type: el.dataset.msg, status: el.dataset.status });
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}
