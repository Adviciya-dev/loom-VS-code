import { isKnownStatus, type KnownTaskStatus } from '../models/Task';

const STATUS_LABELS: Record<KnownTaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  to_be_tested: 'To Be Tested',
  reopen: 'Reopened',
  on_hold: 'On Hold',
  stage_deployement: 'Staging Deployment',
  live_build: 'Live Build',
  done: 'Done',
};

/** Called for values the extension doesn't recognise, so they can be logged once. */
export type UnknownValueReporter = (kind: string, value: string) => void;

let reportUnknown: UnknownValueReporter = () => undefined;

export function setUnknownValueReporter(reporter: UnknownValueReporter): void {
  reportUnknown = reporter;
}

/** "some_value" → "Some Value". Used as the generic label for unknown enum values. */
export function humanize(value: string): string {
  const words = value
    .trim()
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return 'Unknown';
  }
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export function formatStatus(status: string): string {
  if (isKnownStatus(status)) {
    return STATUS_LABELS[status];
  }
  reportUnknown('status', status);
  return humanize(status);
}

const PRIORITY_LABELS: Record<string, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  medium: 'Medium',
  low: 'Low',
};

export function formatPriority(priority: string): string {
  const label = PRIORITY_LABELS[priority.toLowerCase()];
  if (label) {
    return label;
  }
  reportUnknown('priority', priority);
  return humanize(priority);
}

export function formatApprovalStatus(status: string): string {
  return humanize(status);
}

const LEADING_JUNK = /^[\s\p{P}\p{S}]+/u;

/** Strips leading whitespace/punctuation for display. The raw title is never modified. */
export function cleanTitle(raw: string): string {
  const cleaned = raw.replace(LEADING_JUNK, '').trim();
  return cleaned || raw.trim() || '(untitled)';
}

const TEST_CASE_PATTERN = /Related TC:\s*([A-Z]+-\d+)/i;

export function extractTestCaseRef(title: string): string | null {
  const match = TEST_CASE_PATTERN.exec(title);
  return match ? match[1].toUpperCase() : null;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string | null {
  const date = parseDate(value);
  if (!date) {
    return null;
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string | null {
  const date = parseDate(value);
  if (!date) {
    return null;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelativeTime(value: string | null | undefined, now: number = Date.now()): string | null {
  const date = parseDate(value);
  if (!date) {
    return null;
  }
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (abs >= size) {
      return rtf.format(Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

/** True when the due date is before today (local time) and the task isn't done. */
export function isOverdue(dueDate: string | null, status: string, now: Date = new Date()): boolean {
  const date = parseDate(dueDate);
  if (!date || status === 'done' || status === 'live_build') {
    return false;
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date.getTime() < startOfToday.getTime();
}

export function formatMinutes(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) {
    return null;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) {
    return `${h}h ${m}m`;
  }
  return h ? `${h}h` : `${m}m`;
}
