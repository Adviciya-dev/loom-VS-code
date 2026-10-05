import type { Task } from '../models/Task';

/** Name of the file, at a workspace folder's root, that ties the folder to Loom projects. */
export const SCOPE_FILE = '.loom';

/**
 * Parses a `.loom` file: `key=value` lines, `#` comments. Every `project=<id>`
 * line adds a project; a comma-separated list is accepted too.
 */
export function parseScopeFile(text: string): string[] {
  const ids: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^project\s*[=:]\s*(.+)$/i.exec(line);
    if (!match) {
      continue;
    }
    for (const id of match[1].split(',')) {
      const clean = id.trim().replace(/^["']|["']$/g, '');
      if (clean && !ids.includes(clean)) {
        ids.push(clean);
      }
    }
  }
  return ids;
}

/** `null` scope means "no `.loom` file": every project is shown. */
export function tasksInScope(tasks: Task[], scope: readonly string[] | null): Task[] {
  return scope ? tasks.filter((t) => scope.includes(t.projectId)) : tasks;
}
