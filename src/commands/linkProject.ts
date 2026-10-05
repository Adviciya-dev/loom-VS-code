import * as vscode from 'vscode';
import { SCOPE_FILE } from '../services/projectScope';

/** Writes `.loom` (`project=<id>`) at a workspace folder root; the file watcher picks it up. */
export function registerLinkProject(): vscode.Disposable {
  return vscode.commands.registerCommand('loom.linkProject', async () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('Open the project folder first, then link it to a Loom project.');
      return;
    }
    const folder =
      folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder to link to a Loom project' });
    if (!folder) {
      return;
    }
    const projectId = await vscode.window.showInputBox({
      title: 'Link to Loom Project',
      prompt: 'Loom project ID: the part after /projects/ in the project URL',
      placeHolder: '9cc074ac-6a05-4373-a6fc-8d2b69b77294',
      ignoreFocusOut: true,
      validateInput: (v) => (/^[\w-]+$/.test(v.trim()) ? null : 'Paste the project ID (letters, digits and dashes)'),
    });
    if (!projectId) {
      return;
    }
    const content = `# Loom project for this workspace. The Loom sidebar only shows tasks from this project.\nproject=${projectId.trim()}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder.uri, SCOPE_FILE), new TextEncoder().encode(content));
  });
}
