import * as vscode from 'vscode';
import { escapeHtml } from '../utils/sanitizer';
import { contentSecurityPolicy, createNonce } from './webviewUtils';

type FromWebview = { type: 'login'; email: string; password: string } | { type: 'ready' };

type ToWebview =
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string; retryAfterSeconds?: number }
  | { type: 'notice'; message: string | null };

const LAST_EMAIL_KEY = 'loom.lastEmail';

/**
 * Sidebar sign-in form, shown while signed out. A webview is used here because a
 * native tree can't host a password form. The password goes straight from the
 * form to the login handler; it is never stored, echoed back or logged.
 */
export class LoginView implements vscode.WebviewViewProvider {
  static readonly viewId = 'loom.login';

  private view: vscode.WebviewView | undefined;
  private notice: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: vscode.Memento,
    private readonly apiHost: () => string,
    private readonly onLogin: (email: string, password: string) => Promise<{ error?: string; retryAfterSeconds?: number }>,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);
    view.webview.onDidReceiveMessage((msg: FromWebview) => this.handleMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /** Message shown above the form, e.g. after the session expires. */
  setNotice(message: string | null): void {
    this.notice = message;
    this.post({ type: 'notice', message });
  }

  private async handleMessage(msg: FromWebview): Promise<void> {
    if (msg.type === 'ready') {
      this.post({ type: 'notice', message: this.notice });
      return;
    }
    if (msg.type !== 'login' || typeof msg.email !== 'string' || typeof msg.password !== 'string') {
      return;
    }
    this.post({ type: 'busy', busy: true });
    const result = await this.onLogin(msg.email, msg.password);
    this.post({ type: 'busy', busy: false });
    if (result.error) {
      this.post({ type: 'error', message: result.error, retryAfterSeconds: result.retryAfterSeconds });
    } else {
      this.notice = null;
      await this.state.update(LAST_EMAIL_KEY, msg.email.trim());
    }
  }

  private post(message: ToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private render(webview: vscode.Webview): string {
    const nonce = createNonce();
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg'));
    const lastEmail = this.state.get<string>(LAST_EMAIL_KEY) ?? '';
    let host = '';
    try {
      host = new URL(this.apiHost()).host;
    } catch {
      host = this.apiHost();
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 20px 16px 16px;
    margin: 0;
  }
  .brand { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; margin-bottom: 20px; }
  .brand img { width: 56px; height: 56px; border-radius: 13px; box-shadow: 0 4px 14px rgba(49, 46, 129, 0.35); }
  .brand h1 { font-size: 1.25em; font-weight: 600; margin: 4px 0 0; }
  .brand p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.4; }
  form { display: flex; flex-direction: column; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; font-size: 0.92em; }
  input {
    font: inherit;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
    border-radius: 2px;
    outline: none;
  }
  input:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  button {
    font: inherit;
    padding: 6px 12px;
    margin-top: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  button:disabled { opacity: 0.6; cursor: default; }
  .msg { padding: 8px 10px; border-radius: 2px; line-height: 1.4; display: none; }
  .msg.show { display: block; }
  .error {
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }
  .notice {
    background: var(--vscode-inputValidation-infoBackground);
    border: 1px solid var(--vscode-inputValidation-infoBorder);
    margin-bottom: 12px;
  }
  .footer { margin-top: 18px; font-size: 0.85em; color: var(--vscode-descriptionForeground); text-align: center; line-height: 1.5; }
  .spinner {
    display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
    border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
</head>
<body>
  <div class="brand">
    <img src="${iconUri}" alt="">
    <h1>Sign in to Loom</h1>
    <p>Your Adviciya tasks, right inside VS Code.</p>
  </div>

  <div id="notice" class="msg notice" role="status"></div>

  <form id="form" novalidate>
    <label>Email
      <input id="email" type="email" autocomplete="username" placeholder="you@adviciya.com" value="${escapeHtml(lastEmail)}" required>
    </label>
    <label>Password
      <input id="password" type="password" autocomplete="current-password" required>
    </label>
    <div id="error" class="msg error" role="alert"></div>
    <button id="submit" type="submit">Sign In</button>
  </form>

  <div class="footer">
    Connecting to ${escapeHtml(host)}<br>
    Your password is sent only to Loom and never stored.
  </div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const form = document.getElementById('form');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const submit = document.getElementById('submit');
  const errorBox = document.getElementById('error');
  const noticeBox = document.getElementById('notice');
  let throttleTimer = null;

  (email.value ? password : email).focus();

  function showError(text) {
    errorBox.textContent = text || '';
    errorBox.classList.toggle('show', Boolean(text));
  }

  function setBusy(busy) {
    submit.disabled = busy;
    email.disabled = busy;
    password.disabled = busy;
    if (busy) {
      submit.innerHTML = '<span class="spinner" aria-hidden="true"></span>Signing in…';
    } else {
      submit.textContent = 'Sign In';
    }
  }

  function throttle(seconds) {
    clearInterval(throttleTimer);
    let left = seconds;
    submit.disabled = true;
    submit.textContent = 'Try again in ' + left + 's';
    throttleTimer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(throttleTimer);
        submit.disabled = false;
        submit.textContent = 'Sign In';
      } else {
        submit.textContent = 'Try again in ' + left + 's';
      }
    }, 1000);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submit.disabled) return;
    showError('');
    if (!email.value.trim()) { showError('Enter your email address.'); email.focus(); return; }
    if (!password.value) { showError('Enter your password.'); password.focus(); return; }
    vscode.postMessage({ type: 'login', email: email.value, password: password.value });
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'busy') {
      setBusy(msg.busy);
      if (!msg.busy) {
        // Never keep the password around longer than the request.
        password.value = '';
      }
    } else if (msg.type === 'error') {
      showError(msg.message);
      if (msg.retryAfterSeconds) { throttle(msg.retryAfterSeconds); }
      password.focus();
    } else if (msg.type === 'notice') {
      noticeBox.textContent = msg.message || '';
      noticeBox.classList.toggle('show', Boolean(msg.message));
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
  }
}
