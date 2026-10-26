import type { ZodType, ZodTypeDef } from 'zod';
import type { Logger } from '../utils/logger';
import {
  ApiEnvelopeSchema,
  InvalidResponseError,
  LoomApiError,
  NetworkError,
  UnauthorizedError,
} from './ApiTypes';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpTransportOptions {
  baseUrl: () => string;
  logger: Logger;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Extra attempts for network errors and 5xx responses. */
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  accessToken?: string;
  /** Validates the envelope's `data`. */
  schema: ZodType<T, ZodTypeDef, unknown>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Raw HTTP to the Loom API: timeout, retries, envelope verification and data
 * validation. It knows nothing about sessions — a 401 is surfaced as
 * `UnauthorizedError` for the caller's auth flow to handle.
 */
export class HttpTransport {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 400;
    this.sleep = options.sleep ?? defaultSleep;
  }

  buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
    const base = this.options.baseUrl().replace(/\/+$/, '');
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  async request<T>(opts: RequestOptions<T>): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    let attempt = 0;
    for (;;) {
      try {
        return await this.attempt(url, opts);
      } catch (err) {
        // Only GET is retried: replaying a POST/PATCH could create duplicate tasks or comments.
        const retryable =
          opts.method === 'GET' && (err instanceof NetworkError || (err instanceof LoomApiError && (err.status ?? 0) >= 500));
        if (!retryable || attempt >= this.maxRetries) {
          throw err;
        }
        attempt++;
        this.options.logger.warn(`${opts.method} ${opts.path} failed (${(err as Error).message}); retry ${attempt}/${this.maxRetries}`);
        await this.sleep(this.retryDelayMs * attempt);
      }
    }
  }

  private async attempt<T>(url: string, opts: RequestOptions<T>): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.accessToken) {
      headers.Authorization = `Bearer ${opts.accessToken}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new NetworkError(`Request timed out after ${this.timeoutMs / 1000}s`, true);
      }
      throw new NetworkError(`Could not reach Loom: ${(err as Error)?.message ?? 'network error'}`);
    } finally {
      clearTimeout(timer);
    }

    // Path only — never the headers.
    this.options.logger.debug(`${opts.method} ${opts.path} → ${response.status} (${Date.now() - started}ms)`);

    let json: unknown;
    try {
      const text = await response.text();
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    const envelope = ApiEnvelopeSchema.safeParse(json);
    const serverMessage = envelope.success ? envelope.data.message?.trim() || null : null;

    if (response.status === 401) {
      throw new UnauthorizedError(serverMessage ?? 'Unauthorized');
    }
    if (!response.ok) {
      throw new LoomApiError(serverMessage ?? `Loom returned HTTP ${response.status}`, response.status);
    }
    if (!envelope.success) {
      throw new InvalidResponseError('Loom returned a response in an unexpected format.', response.status);
    }
    // HTTP 2xx is not enough: the envelope must say success.
    if (envelope.data.success !== true) {
      throw new LoomApiError(serverMessage ?? 'Loom reported the request as unsuccessful.', response.status);
    }

    const data = opts.schema.safeParse(envelope.data.data);
    if (!data.success) {
      const paths = data.error.issues.map((i) => i.path.join('.') || '(root)').slice(0, 5);
      this.options.logger.warn(`${opts.method} ${opts.path}: response data failed validation at ${paths.join(', ')}`);
      throw new InvalidResponseError('Loom returned data in an unexpected format.', response.status);
    }
    return data.data;
  }
}
