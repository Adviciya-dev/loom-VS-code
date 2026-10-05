import * as vscode from 'vscode';
import { AuthApi } from './api/AuthApi';
import { HttpTransport } from './api/HttpTransport';
import { LoomClient } from './api/LoomClient';
import { LoomTaskWriteApi } from './api/TaskWriteApi';
import { AuthManager } from './auth/AuthManager';
import { TokenManager } from './auth/TokenManager';
import { registerAssignTask } from './commands/assignTask';
import type { LoomContext } from './commands/context';
import { registerCreateTask } from './commands/createTask';
import { registerLinkProject } from './commands/linkProject';
import { performLogin, registerLogin } from './commands/login';
import { registerLogout } from './commands/logout';
import { registerTaskListCommands } from './commands/refreshTasks';
import { registerTaskCommands } from './commands/taskCommands';
import { SCOPE_FILE, parseScopeFile } from './services/projectScope';
import { hasActiveFilters, summarizeTasks } from './services/taskQueries';
import { TaskService } from './services/TaskService';
import { setUnknownValueReporter } from './utils/formatters';
import { Logger } from './utils/logger';
import { AccountView } from './views/AccountView';
import { LoginView } from './views/LoginView';
import { LoomTreeProvider } from './views/LoomTreeProvider';
import { TaskDetailView } from './views/TaskDetailView';

const DEFAULT_API = 'https://loom.adviciya.com/api/v1';
const DEFAULT_WEB = 'https://loom.adviciya.com';

function setting<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('loom').get<T>(key) ?? fallback;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Loom');
  const logger = new Logger(output, context.extensionMode === vscode.ExtensionMode.Development ? 'debug' : 'info');
  setUnknownValueReporter((kind, value) =>
    logger.warnOnce(`${kind}:${value}`, `Unrecognised ${kind} value from Loom: "${value}" — showing a generic label`),
  );

  const config = {
    apiBaseUrl: () => setting('apiBaseUrl', DEFAULT_API) || DEFAULT_API,
    webBaseUrl: () => setting('webBaseUrl', DEFAULT_WEB) || DEFAULT_WEB,
    taskUrlTemplate: () => setting('taskUrlTemplate', '{webBaseUrl}/projects/{projectId}/tasks?task={taskId}'),
    refreshPath: () => setting('auth.refreshPath', ''),
    pageSize: () => Math.min(100, Math.max(1, Math.floor(setting('pageSize', 25)))),
  };

  // --- Core (no UI) ---------------------------------------------------------
  const transport = new HttpTransport({ baseUrl: config.apiBaseUrl, logger });
  const authApi = new AuthApi(transport);
  const auth = new AuthManager({
    authApi,
    tokens: new TokenManager(context.secrets),
    logger,
    refreshPath: config.refreshPath,
  });
  const client = new LoomClient(transport, authApi, auth, logger);
  const service = new TaskService(client, logger, { pageSize: config.pageSize });
  const writeApi = new LoomTaskWriteApi(client);

  // --- UI -------------------------------------------------------------------
  const detailView = new TaskDetailView(context.extensionUri, writeApi, () => service.user);
  const loginView = new LoginView(context.extensionUri, context.globalState, config.apiBaseUrl, (email, password) =>
    performLogin(auth, email, password),
  );
  const treeProvider = new LoomTreeProvider(service);
  const tasksView = vscode.window.createTreeView('loom.tasks', { treeDataProvider: treeProvider, showCollapseAll: true });

  const ctx: LoomContext = { auth, service, writeApi, detailView, logger, output, config };

  context.subscriptions.push(
    output,
    tasksView,
    vscode.window.registerWebviewViewProvider(AccountView.viewId, new AccountView(service)),
    { dispose: () => auth.dispose() },
    { dispose: () => service.dispose() },
    { dispose: () => detailView.dispose() },
    vscode.window.registerWebviewViewProvider(LoginView.viewId, loginView),
    registerLogin(ctx, context.globalState),
    registerLogout(ctx),
    registerLinkProject(),
    registerCreateTask(ctx),
    registerAssignTask(ctx),
    ...registerTaskListCommands(ctx),
    ...registerTaskCommands(ctx),
  );

  // --- Project scope (`.loom` at a workspace folder root) --------------------
  const loadScope = async (): Promise<void> => {
    const ids: string[] = [];
    let found = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, SCOPE_FILE));
        found = true;
        ids.push(...parseScopeFile(new TextDecoder().decode(bytes)));
      } catch {
        // No `.loom` in this folder.
      }
    }
    if (found && ids.length === 0) {
      logger.warn(`${SCOPE_FILE} found but it has no "project=<id>" line — treating the workspace as not a Loom project`);
    }
    logger.info(ids.length ? `Project scope: ${ids.join(', ')}` : 'No .loom file: this workspace is not a Loom project');
    await vscode.commands.executeCommand('setContext', 'loom.hasProject', ids.length > 0);
    await vscode.commands.executeCommand('setContext', 'loom.hasFolder', (vscode.workspace.workspaceFolders ?? []).length > 0);
    service.setScope(ids.length ? ids : null);
  };
  const scopeWatcher = vscode.workspace.createFileSystemWatcher(`**/${SCOPE_FILE}`);
  context.subscriptions.push(
    scopeWatcher,
    scopeWatcher.onDidCreate(() => void loadScope()),
    scopeWatcher.onDidChange(() => void loadScope()),
    scopeWatcher.onDidDelete(() => void loadScope()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void loadScope()),
  );
  await loadScope();

  /** The scoped project's name once a task from it is loaded, so the view says what it's limited to. */
  const scopeLabel = (): string | undefined => {
    const scope = service.scope;
    if (!scope) {
      return undefined;
    }
    const names = [...new Set(service.knownTasks().map((t) => t.projectName).filter(Boolean))];
    return names.length ? names.join(', ') : `${scope.length} project${scope.length === 1 ? '' : 's'}`;
  };

  // Keep view chrome in sync with state.
  service.onDidChange(() => {
    const filters = service.filters;
    const active = hasActiveFilters(filters);
    void vscode.commands.executeCommand('setContext', 'loom.filtersActive', active);
    const parts: string[] = [];
    if (filters.search) {
      parts.push(`“${filters.search}”`);
    }
    if (filters.statuses.length) {
      parts.push(`${filters.statuses.length} status${filters.statuses.length === 1 ? '' : 'es'}`);
    }
    if (filters.priorities.length) {
      parts.push(`${filters.priorities.length} priorit${filters.priorities.length === 1 ? 'y' : 'ies'}`);
    }
    tasksView.description = active ? `Filtered: ${parts.join(', ')}` : scopeLabel();
    const all = service.allValue();
    const summary = all && service.scope ? summarizeTasks(service.inScope(all.tasks)) : null;
    tasksView.badge = summary?.remaining
      ? { value: summary.remaining, tooltip: `${summary.remaining} of ${summary.total} tasks remaining` }
      : undefined;

    const openId = detailView.currentTaskId;
    if (openId) {
      detailView.update(service.findTask(openId));
    }
  });

  // --- Session lifecycle ----------------------------------------------------
  auth.onDidChange((event) => {
    switch (event.type) {
      case 'signedIn':
        loginView.setNotice(null);
        void vscode.commands.executeCommand('setContext', 'loom.authenticated', true);
        void service.start(event.loginUser);
        break;
      case 'signedOut':
        void vscode.commands.executeCommand('setContext', 'loom.authenticated', false);
        service.reset();
        detailView.dispose();
        if (event.reason !== 'logout') {
          loginView.setNotice('Your Loom session has expired. Please sign in again.');
          void vscode.window.showWarningMessage('Your Loom session has expired. Please sign in again.');
        }
        break;
      case 'expiringSoon':
        void vscode.window
          .showWarningMessage('Your Loom session expires in about a minute. Sign in again to stay connected.', 'Sign In')
          .then((choice) => {
            if (choice === 'Sign In') {
              void vscode.commands.executeCommand('loom.login');
            }
          });
        break;
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('loom.apiBaseUrl')) {
        client.clearCache();
        if (auth.isAuthenticated) {
          void service.refresh();
        }
      } else if (e.affectsConfiguration('loom.pageSize') && auth.isAuthenticated) {
        void service.refresh();
      }
    }),
  );

  await vscode.commands.executeCommand('setContext', 'loom.authenticated', false);
  try {
    await auth.initialize();
  } catch (err) {
    logger.error('Could not restore the Loom session', err);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
