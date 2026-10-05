import * as vscode from 'vscode';
import { showError, type LoomContext } from './context';

export function registerLogout(ctx: LoomContext): vscode.Disposable {
  return vscode.commands.registerCommand('loom.logout', async () => {
    const choice = await vscode.window.showWarningMessage('Sign out of Loom?', { modal: true }, 'Sign Out');
    if (choice !== 'Sign Out') {
      return;
    }
    try {
      await ctx.auth.logout();
    } catch (err) {
      await showError(err, 'Sign out');
    }
  });
}
