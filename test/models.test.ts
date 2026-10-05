import { describe, expect, it, vi } from 'vitest';
import { TaskSchema, parentTaskKey, taskKey } from '../src/models/Task';
import { initials, mergeUsers, normalizeUser } from '../src/models/User';
import { filterTasks, groupByParent, groupByProject, groupByStatus, EMPTY_FILTERS } from '../src/services/taskQueries';
import {
  cleanTitle,
  extractTestCaseRef,
  formatPriority,
  formatStatus,
  humanize,
  setUnknownValueReporter,
} from '../src/utils/formatters';
import { rawTask } from './helpers';

describe('Task parsing', () => {
  it('parses a complete task', () => {
    const task = TaskSchema.parse(rawTask());
    expect(task.id).toBe('task-1');
    expect(task.subtaskCount).toBe(3);
    expect(taskKey(task)).toBe('THE-129');
  });

  it('fills safe defaults for missing or malformed optional fields', () => {
    const task = TaskSchema.parse({ id: 42, title: 'Minimal', taskNumber: 'oops', assigneeIds: null, isBlocked: 'yes' });
    expect(task.id).toBe('42');
    expect(task.taskNumber).toBe(0);
    expect(task.assigneeIds).toEqual([]);
    expect(task.isBlocked).toBe(false);
    expect(task.status).toBe('todo');
    expect(task.customFields).toEqual({});
  });

  it('keeps unknown enum values instead of crashing', () => {
    const task = TaskSchema.parse(rawTask({ status: 'qa_signoff', priority: 'critical', type: 'epic' }));
    expect(task.status).toBe('qa_signoff');
    expect(task.priority).toBe('critical');
  });

  it('requires an id', () => {
    expect(TaskSchema.safeParse({ title: 'x' }).success).toBe(false);
  });

  it('builds the parent key from the shared project prefix', () => {
    const task = TaskSchema.parse(rawTask({ parentTaskId: 'p1', parentTaskNumber: 100 }));
    expect(parentTaskKey(task)).toBe('THE-100');
  });
});

describe('Status formatting', () => {
  it('labels every documented status', () => {
    expect(formatStatus('todo')).toBe('To Do');
    expect(formatStatus('in_progress')).toBe('In Progress');
    expect(formatStatus('in_review')).toBe('In Review');
    expect(formatStatus('to_be_tested')).toBe('To Be Tested');
    expect(formatStatus('reopen')).toBe('Reopened');
    expect(formatStatus('on_hold')).toBe('On Hold');
    expect(formatStatus('stage_deployement')).toBe('Staging Deployment');
    expect(formatStatus('live_build')).toBe('Live Build');
    expect(formatStatus('done')).toBe('Done');
  });

  it('gives unknown statuses a generic label and reports them', () => {
    const reporter = vi.fn();
    setUnknownValueReporter(reporter);
    expect(formatStatus('waiting_for_client')).toBe('Waiting For Client');
    expect(reporter).toHaveBeenCalledWith('status', 'waiting_for_client');
    setUnknownValueReporter(() => undefined);
  });

  it('formats priorities and handles empty values', () => {
    expect(formatPriority('high')).toBe('High');
    expect(formatPriority('normal')).toBe('Normal');
    expect(humanize('')).toBe('Unknown');
  });
});

describe('Title cleanup', () => {
  it('trims leading punctuation and whitespace for display', () => {
    expect(cleanTitle('  - Fix bug')).toBe('Fix bug');
    expect(cleanTitle(':: [WIP] thing')).toBe('WIP] thing');
    expect(cleanTitle('...Hello')).toBe('Hello');
    expect(cleanTitle('Normal title')).toBe('Normal title');
  });

  it('does not produce an empty title', () => {
    expect(cleanTitle('---')).toBe('---');
    expect(cleanTitle('   ')).toBe('(untitled)');
  });

  it('leaves the raw title untouched', () => {
    const task = TaskSchema.parse(rawTask({ title: ' - Raw' }));
    cleanTitle(task.title);
    expect(task.title).toBe(' - Raw');
  });
});

describe('Test-case extraction', () => {
  it('extracts the reference case-insensitively', () => {
    expect(extractTestCaseRef('Login fails. Related TC: QA-42')).toBe('QA-42');
    expect(extractTestCaseRef('related tc:tc-7 something')).toBe('TC-7');
    expect(extractTestCaseRef('Related TC:   ABC-1001')).toBe('ABC-1001');
  });

  it('returns null when absent or malformed', () => {
    expect(extractTestCaseRef('No reference here')).toBeNull();
    expect(extractTestCaseRef('Related TC: 123')).toBeNull();
  });
});

describe('Users', () => {
  it('normalises names from alternative fields', () => {
    expect(normalizeUser({ id: '1', email: 'a@b.test', firstName: 'Ada', lastName: 'L' }).name).toBe('Ada L');
    expect(normalizeUser({ id: '1', email: 'a@b.test' }).name).toBe('a@b.test');
  });

  it('prefers /auth/me but fills gaps from the login response', () => {
    const me = normalizeUser({ id: 'u1', email: 'a@b.test', name: 'Ada', role: null });
    const login = normalizeUser({ id: 'u1', email: 'a@b.test', name: 'Old', role: 'admin', githubUsername: 'ada' });
    expect(mergeUsers(me, login)).toMatchObject({ name: 'Ada', role: 'admin', githubUsername: 'ada' });
    const other = normalizeUser({ id: 'u2', email: 'x@y.test', role: 'admin' });
    expect(mergeUsers(me, other).role).toBeNull();
  });

  it('computes initials', () => {
    expect(initials({ name: 'Ada Lovelace', email: 'a@b.test' })).toBe('AL');
    expect(initials({ name: 'a@b.test', email: 'a@b.test' })).toBe('A');
    expect(initials({ name: 'john.smith@x.test', email: 'john.smith@x.test' })).toBe('JS');
  });
});

describe('Filtering and grouping', () => {
  const tasks = [
    TaskSchema.parse(rawTask({ id: '1', status: 'done', projectName: 'Beta', projectId: 'b' })),
    TaskSchema.parse(rawTask({ id: '2', title: 'Payment page Related TC: QA-9', projectName: 'Alpha', projectId: 'a', parentTaskId: 'p', parentTaskNumber: 5, parentTitle: 'Epic' })),
    TaskSchema.parse(rawTask({ id: '3', status: 'mystery', priority: 'normal', projectName: 'Alpha', projectId: 'a' })),
  ];

  it('filters by search, status and priority on the client', () => {
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, search: 'qa-9' }).map((t) => t.id)).toEqual(['2']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, search: 'the-129 alpha' }).map((t) => t.id)).toEqual(['2', '3']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, statuses: ['done'] }).map((t) => t.id)).toEqual(['1']);
    expect(filterTasks(tasks, { ...EMPTY_FILTERS, priorities: ['normal'] }).map((t) => t.id)).toEqual(['3']);
  });

  it('groups by project, parent and status', () => {
    expect(groupByProject(tasks).map((g) => [g.label, g.tasks.length])).toEqual([
      ['Alpha', 2],
      ['Beta', 1],
    ]);
    expect(groupByParent(tasks).map((g) => g.label)).toEqual(['THE-5 Epic', 'No parent task']);
    const byStatus = groupByStatus(tasks);
    expect(byStatus.find((g) => g.key === 'done')?.tasks).toHaveLength(1);
    expect(byStatus.at(-1)?.key).toBe('mystery');
  });
});
