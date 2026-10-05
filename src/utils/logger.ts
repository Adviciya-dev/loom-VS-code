/**
 * Logging with mandatory redaction. Every message and argument passes through
 * `redact` before reaching a sink, so tokens, passwords and Authorization headers
 * can never end up in the output channel even if a caller passes them by mistake.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  appendLine(line: string): void;
}

export const REDACTED = '[REDACTED]';

/** Object keys whose values are always secret, compared case-insensitively with `-`/`_` removed. */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
  'session',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));
}

const STRING_PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Authorization: Bearer xxx / Basic xxx
  [/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)\s+[^\s"',}]+/gi, `$1$2 ${REDACTED}`],
  // Bare "Bearer xxx"
  [/\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, `$1 ${REDACTED}`],
  // JWTs anywhere in text
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],
  // "password": "..." / password=... / accessToken: '...' in JSON, query strings or prose
  [
    /(["']?(?:password|passwd|pwd|secret|access_?token|refresh_?token|id_?token|token|api_?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,}]+)/gi,
    (_m: string, prefix: string) => `${prefix}"${REDACTED}"`,
  ],
];

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of STRING_PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** Deep-redacts any value. Never mutates its input. */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen));
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const out: Record<string, string> = {};
    value.forEach((v, k) => {
      out[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, seen);
  }
  return out;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class Logger {
  private readonly warnedOnce = new Set<string>();

  constructor(
    private readonly sink: LogSink,
    private readonly minLevel: LogLevel = 'info',
  ) {}

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, args);
  }

  /** Logs a warning only the first time a given key is seen (e.g. unknown enum values). */
  warnOnce(key: string, message: string, ...args: unknown[]): void {
    if (this.warnedOnce.has(key)) {
      return;
    }
    this.warnedOnce.add(key);
    this.warn(message, ...args);
  }

  private log(level: LogLevel, message: string, args: unknown[]): void {
    const order: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) {
      return;
    }
    const parts = [redactString(message), ...args.map((a) => stringify(redact(a)))];
    this.sink.appendLine(`${new Date().toISOString()} [${level.toUpperCase()}] ${parts.join(' ')}`);
  }
}

/** A logger that discards everything; handy for tests and defaults. */
export const nullLogger = new Logger({ appendLine: () => undefined }, 'error');
