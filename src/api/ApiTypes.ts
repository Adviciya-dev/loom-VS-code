import { z } from 'zod';
import type { Task } from '../models/Task';
import type { LoomUser } from '../models/User';

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message: string;
  meta: {
    timestamp: string;
  };
}

export const ApiEnvelopeSchema = z.object({
  success: z.boolean(),
  data: z.unknown(),
  message: z.string().nullish(),
  meta: z.object({ timestamp: z.string().nullish() }).passthrough().nullish(),
});

// --- Errors ----------------------------------------------------------------

export class LoomApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'LoomApiError';
  }
}

/** HTTP 401 from the API. Only the client's auth flow should handle this. */
export class UnauthorizedError extends LoomApiError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
    this.name = 'UnauthorizedError';
  }
}

/** Connection failures and timeouts. */
export class NetworkError extends LoomApiError {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message, null);
    this.name = 'NetworkError';
  }
}

/** The response wasn't a valid Loom envelope, or its data didn't match the expected shape. */
export class InvalidResponseError extends LoomApiError {
  constructor(message: string, status: number | null = null) {
    super(message, status);
    this.name = 'InvalidResponseError';
  }
}

/** There is no usable session; the user must sign in. */
export class AuthRequiredError extends Error {
  constructor(message = 'Please sign in to Loom.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor(message = 'Invalid email or password.') {
    super(message);
    this.name = 'InvalidCredentialsError';
  }
}

export class LoginThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many sign-in attempts. Try again in ${retryAfterSeconds}s.`);
    this.name = 'LoginThrottledError';
  }
}

/** A write operation whose Loom endpoint hasn't been documented yet. */
export class NotSupportedError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} isn't available yet: the Loom API endpoint for it hasn't been documented.`);
    this.name = 'NotSupportedError';
  }
}

// --- Auth ------------------------------------------------------------------

export interface LoginResult {
  accessToken: string;
  refreshToken: string | null;
  user: LoomUser | null;
}

export interface RefreshResult {
  accessToken: string;
  /** Present when the server rotates refresh tokens. */
  refreshToken: string | null;
}

// --- Tasks -----------------------------------------------------------------

export type SortOrder = 'asc' | 'desc';

export interface TaskPageParams {
  page: number;
  pageSize: number;
  assigneeId?: string;
  sort?: string;
  order?: SortOrder;
}

export interface TaskPage {
  tasks: Task[];
  page: number;
  pageSize: number;
  /** Total as reported by the API; null when the API didn't report one. Never recalculated. */
  total: number | null;
  /** Page count as reported by the API; null when not reported. */
  totalPages: number | null;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  /** Any count map the API returned alongside the page (e.g. per-status counts), verbatim. */
  counts: Record<string, number> | null;
  /** Items that failed validation and were left out. */
  skipped: number;
}

export interface AllTasksResult {
  tasks: Task[];
  /** Total from the first page's response, as returned. */
  total: number | null;
  /** True when the page limit was reached before the last page. */
  truncated: boolean;
  pagesFetched: number;
  skipped: number;
}
