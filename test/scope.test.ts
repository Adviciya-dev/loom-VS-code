import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task } from '../src/models/Task';
import { parseScopeFile, tasksInScope } from '../src/services/projectScope';
import { nestTasks, summarizeTasks } from '../src/services/taskQueries';
import { buildTaskUrl } from '../src/services/taskUrl';
import { rawTask } from './helpers';

const task = (overrides: Record<string, unknown> = {}): Task => TaskSchema.parse(rawTask(overrides));

const PROJECT = '9cc074ac-6a05-4373-a6fc-8d2b69b77294';
const TEMPLATE = '{webBaseUrl}/projects/{projectId}/tasks?task={taskId}';

describe('.loom scope file', () => {
  it('reads project=<id> lines, ignoring comments and blanks', () => {
    expect(parseScopeFile(`# Loom\nproject=${PROJECT}\n\n`)).toEqual([PROJECT]);
  });

  it('accepts several projects, quotes and spacing, without duplicates', () => {
    expect(parseScopeFile('project = "a", b\nproject=a\nPROJECT: c # trailing')).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing when there is no project line', () => {
    expect(parseScopeFile('name=x\n')).toEqual([]);
  });

  it('filters tasks to the scoped projects, or keeps all with no scope', () => {
    const tasks = [task({ id: '1', projectId: 'a' }), task({ id: '2', projectId: 'b' })];
    expect(tasksInScope(tasks, ['b']).map((t) => t.id)).toEqual(['2']);
    expect(tasksInScope(tasks, null)).toHaveLength(2);
  });
});

describe('nestTasks', () => {
  it('nests subtasks and sub-subtasks under parents in the list', () => {
    const tree = nestTasks([
      task({ id: 'sub', parentTaskId: 'top' }),
      task({ id: 'top' }),
      task({ id: 'subsub', parentTaskId: 'sub' }),
      task({ id: 'other' }),
    ]);
    expect(tree.map((e) => e.task.id)).toEqual(['top', 'other']);
    expect(tree[0].children.map((e) => e.task.id)).toEqual(['sub']);
    expect(tree[0].children[0].children.map((e) => e.task.id)).toEqual(['subsub']);
  });

  it('keeps a subtask at the top level when its parent is not loaded', () => {
    expect(nestTasks([task({ id: 'sub', parentTaskId: 'missing' })]).map((e) => e.task.id)).toEqual(['sub']);
  });

  it('never loses tasks in a parent cycle', () => {
    const tree = nestTasks([task({ id: 'a', parentTaskId: 'b' }), task({ id: 'b', parentTaskId: 'a' })]);
    const count = (es: typeof tree): number => es.reduce((n, e) => n + 1 + count(e.children), 0);
    expect(count(tree)).toBe(2);
  });
});

describe('buildTaskUrl', () => {
  it('opens a top-level task by id within its project', () => {
    expect(buildTaskUrl(TEMPLATE, 'https://loom.adviciya.com/', task({ id: 't1', projectId: PROJECT }))).toBe(
      `https://loom.adviciya.com/projects/${PROJECT}/tasks?task=t1`,
    );
  });

  it('adds taskProject for subtasks', () => {
    expect(buildTaskUrl(TEMPLATE, 'https://loom.adviciya.com', task({ id: 't2', projectId: PROJECT, parentTaskId: 'p' }))).toBe(
      `https://loom.adviciya.com/projects/${PROJECT}/tasks?task=t2&taskProject=${PROJECT}`,
    );
  });
});

describe('summarizeTasks', () => {
  const now = new Date(2026, 9, 3, 12); // 3 Oct 2026, local noon
  const day = (d: number) => new Date(2026, 9, d).toISOString();

  it('counts done, remaining, overdue, due soon and blocked', () => {
    const s = summarizeTasks(
      [
        task({ id: '1', status: 'done', dueDate: day(1) }),
        task({ id: '2', status: 'live_build' }),
        task({ id: '3', status: 'todo', dueDate: day(1) }),
        task({ id: '4', status: 'in_progress', dueDate: day(5), isBlocked: true }),
        task({ id: '5', status: 'todo', dueDate: day(20) }),
        task({ id: '6', status: 'todo', dueDate: null }),
      ],
      now,
    );
    expect(s).toEqual({ total: 6, done: 2, remaining: 4, percent: 33, overdue: 1, dueSoon: 1, blocked: 1 });
  });

  it('handles an empty list', () => {
    expect(summarizeTasks([], now).percent).toBe(0);
  });
});
