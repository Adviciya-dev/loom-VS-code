import * as vscode from 'vscode';
import { InvalidCredentialsError, LoginThrottledError } from '../api/ApiTypes';
import type { AuthManager } from '../auth/AuthManager';
import type { LoomContext } from './context';

export interface LoginOutcome {
  error?: string;
  retryAfterSeconds?: number;
}

/** Shared by the sidebar form and the command: performs the login and maps errors to text. */
export async function performLogin(auth: AuthManager, email: string, password: string): Promise<LoginOutcome> {
  try {
    await auth.login(email, password);
    return {};
  } catch (err) {
    if (err instanceof LoginThrottledError) {
      return { error: err.message, retryAfterSeconds: err.retryAfterSeconds };
    }
    if (err instanceof InvalidCredentialsError) {
      return { error: err.message, retryAfterSeconds: auth.loginThrottleRemaining() || undefined };
    }
    const message = (err as Error)?.message || 'Sign-in failed.';
    return { error: `Couldn't sign in: ${message}` };
  }
}

/**
 * `Loom: Sign In` from the Command Palette, using native inputs. The sidebar
 * shows a form instead; this path also handles re-authentication before expiry.
 */
export function registerLogin(ctx: LoomContext, state: vscode.Memento): vscode.Disposable {
  return vscode.commands.registerCommand('loom.login', async () => {
    const throttled = ctx.auth.loginThrottleRemaining();
    if (throttled > 0) {
      void vscode.window.showWarningMessage(`Too many sign-in attempts. Try again in ${throttled}s.`);
      return;
    }

    const email = await vscode.window.showInputBox({
      title: 'Sign in to Loom (1/2)',
      prompt: 'Email',
      value: state.get<string>('loom.lastEmail') ?? '',
      placeHolder: 'you@adviciya.com',
      ignoreFocusOut: true,
      validateInput: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : 'Enter a valid email address'),
    });
    if (!email) {
      return;
    }
    const password = await vscode.window.showInputBox({
      title: 'Sign in to Loom (2/2)',
      prompt: 'Password',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v ? null : 'Enter your password'),
    });
    if (!password) {
      return;
    }

    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Signing in to Loom…' },
      () => performLogin(ctx.auth, email, password),
    );
    if (outcome.error) {
      void vscode.window.showErrorMessage(outcome.error);
      return;
    }
    await state.update('loom.lastEmail', email.trim());
  });
}
