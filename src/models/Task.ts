import { z } from 'zod';

export const TASK_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'to_be_tested',
  'reopen',
  'on_hold',
  'stage_deployement', // sic — the API's spelling; displayed as "Staging Deployment"
  'live_build',
  'done',
] as const;

export type KnownTaskStatus = (typeof TASK_STATUSES)[number];
/** Known statuses keep autocomplete; unknown ones are still representable without crashing. */
export type TaskStatus = KnownTaskStatus | (string & {});

export function isKnownStatus(status: string): status is KnownTaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(status);
}

export interface Task {
  id: string;
  projectId: string;
  projectName: string;
  projectTaskPrefix: string;
  taskNumber: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: 'high' | 'normal' | (string & {});
  type: 'issue' | 'task' | (string & {});
  assigneeIds: string[];
  createdById: string;
  dueDate: string | null;
  startDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  parentTaskId: string | null;
  parentTitle: string | null;
  parentTaskNumber: number | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintIsActive: boolean;
  requiresApproval: boolean;
  approverIds: string[];
  approvedByIds: string[];
  approvalStatus: 'none' | (string & {});
  dependencyCount: number;
  dependencyDoneCount: number;
  isBlocked: boolean;
  subtaskCount: number;
  subtaskDoneCount: number;
  timeEstimateMinutes: number | null;
  autoCompletedFromStatus: string | null;
  customFields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Runtime validation. Identity fields are required; everything else degrades to
// a safe default so one odd field never hides a whole task from the developer.
// ---------------------------------------------------------------------------

const id = z.union([z.string(), z.number()]).transform(String);
const optId = z
  .union([z.string(), z.number()])
  .nullish()
  .transform((v) => (v === null || v === undefined || v === '' ? null : String(v)));
const str = (fallback: string) =>
  z
    .string()
    .nullish()
    .catch(null)
    .transform((v) => v ?? fallback);
const optStr = z
  .string()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
const num = (fallback: number) =>
  z
    .number()
    .nullish()
    .catch(null)
    .transform((v) => v ?? fallback);
const optNum = z
  .number()
  .nullish()
  .catch(null)
  .transform((v) => v ?? null);
const bool = z
  .boolean()
  .nullish()
  .catch(null)
  .transform((v) => v ?? false);
const idList = z
  .array(z.union([z.string(), z.number()]))
  .nullish()
  .catch(null)
  .transform((v) => (v ?? []).map(String));

export const TaskSchema = z.object({
  id,
  projectId: optId.transform((v) => v ?? ''),
  projectName: str(''),
  projectTaskPrefix: str(''),
  taskNumber: num(0),
  title: str(''),
  description: str(''),
  status: str('todo'),
  priority: str('normal'),
  type: str('task'),
  assigneeIds: idList,
  createdById: optId.transform((v) => v ?? ''),
  dueDate: optStr,
  startDate: optStr,
  createdAt: str(''),
  updatedAt: str(''),
  lastActivityAt: optStr,
  parentTaskId: optId,
  parentTitle: optStr,
  parentTaskNumber: optNum,
  sprintId: optId,
  sprintName: optStr,
  sprintIsActive: bool,
  requiresApproval: bool,
  approverIds: idList,
  approvedByIds: idList,
  approvalStatus: str('none'),
  dependencyCount: num(0),
  dependencyDoneCount: num(0),
  isBlocked: bool,
  subtaskCount: num(0),
  subtaskDoneCount: num(0),
  timeEstimateMinutes: optNum,
  autoCompletedFromStatus: optStr,
  customFields: z
    .record(z.unknown())
    .nullish()
    .catch(null)
    .transform((v) => v ?? {}),
}) satisfies z.ZodType<Task, z.ZodTypeDef, unknown>;

export function taskKey(task: Pick<Task, 'projectTaskPrefix' | 'taskNumber'>): string {
  return task.projectTaskPrefix ? `${task.projectTaskPrefix}-${task.taskNumber}` : `#${task.taskNumber}`;
}

export function parentTaskKey(task: Pick<Task, 'projectTaskPrefix' | 'parentTaskNumber'>): string | null {
  if (task.parentTaskNumber === null) {
    return null;
  }
  return taskKey({ projectTaskPrefix: task.projectTaskPrefix, taskNumber: task.parentTaskNumber });
}
