import { taskKey, type Task } from '../models/Task';

/**
 * Fills the `loom.taskUrlTemplate` placeholders. Subtasks also get
 * `taskProject=<projectId>`, which the Loom web app uses when opening a
 * nested task.
 */
export function buildTaskUrl(template: string, webBaseUrl: string, task: Task): string {
  const base = webBaseUrl.replace(/\/+$/, '');
  let url = template
    .replace(/\{webBaseUrl\}/g, base)
    .replace(/\{taskId\}/g, encodeURIComponent(task.id))
    .replace(/\{projectId\}/g, encodeURIComponent(task.projectId))
    .replace(/\{taskKey\}/g, encodeURIComponent(taskKey(task)))
    .replace(/\{taskNumber\}/g, String(task.taskNumber));
  if (task.parentTaskId && task.projectId && !/[?&]taskProject=/.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}taskProject=${encodeURIComponent(task.projectId)}`;
  }
  return url;
}
