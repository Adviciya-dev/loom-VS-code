import {
  AuthRequiredError,
  InvalidCredentialsError,
  LoginThrottledError,
  LoomApiError,
  NetworkError,
  UnauthorizedError,
} from '../api/ApiTypes';
import type { AuthApi } from '../api/AuthApi';
import type { TokenProvider } from '../api/LoomClient';
import type { LoomUser } from '../models/User';
import { Emitter } from '../utils/emitter';
import type { Logger } from '../utils/logger';
import { decodeJwtExpiry, type StoredSession, type TokenManager } from './TokenManager';

export type SignOutReason = 'logout' | 'expired' | 'rejected';

export type AuthEvent =
  | { type: 'signedIn'; loginUser: LoomUser | null }
  | { type: 'signedOut'; reason: SignOutReason }
  /** The token expires soon and can't be renewed automatically (no refresh endpoint). */
  | { type: 'expiringSoon'; expiresAt: number };

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuthManagerOptions {
  authApi: Pick<AuthApi, 'login' | 'refresh'>;
  tokens: TokenManager;
  logger: Logger;
  /** Path of the refresh endpoint, or '' when none is configured. Read on every renewal. */
  refreshPath: () => string;
  now?: () => number;
  scheduler?: Scheduler;
  renewalWindowMs?: number;
  loginThrottleMs?: number;
}

const MAX_TIMER_MS = 2_147_483_647;

/**
 * Owns the session: login, persistence, renewal and logout.
 *
 * - Tokens are renewed when they expire within 60s. With no refresh endpoint
 *   configured, the user is told to sign in again instead.
 * - Concurrent renewals share one in-flight request.
 * - The password is only passed through to `/auth/login`; it is never stored.
 */
export class AuthManager implements TokenProvider {
  private session: StoredSession | null = null;
  private renewal: Promise<string> | null = null;
  private loginInFlight: Promise<LoomUser | null> | null = null;
  private lastFailedLoginAt: number | null = null;
  private timers: unknown[] = [];

  private readonly emitter = new Emitter<AuthEvent>();
  readonly onDidChange = this.emitter.event;

  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly renewalWindowMs: number;
  private readonly loginThrottleMs: number;

  constructor(private readonly opts: AuthManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.scheduler = opts.scheduler ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.renewalWindowMs = opts.renewalWindowMs ?? 60_000;
    this.loginThrottleMs = opts.loginThrottleMs ?? 30_000;
  }

  get isAuthenticated(): boolean {
    return this.session !== null;
  }

  get loginUser(): LoomUser | null {
    return this.session?.loginUser ?? null;
  }

  get canRefresh(): boolean {
    return Boolean(this.opts.refreshPath().trim() && this.session?.refreshToken);
  }

  /** Restores a stored session on startup. Returns true if the user is signed in. */
  async initialize(): Promise<boolean> {
    const stored = await this.opts.tokens.load();
    if (!stored) {
      return false;
    }
    this.session = stored;
    const expiresAt = decodeJwtExpiry(stored.accessToken);
    if (expiresAt !== null && expiresAt <= this.now()) {
      if (!this.canRefresh) {
        this.opts.logger.info('Stored Loom session has expired');
        await this.clearSession('expired');
        return false;
      }
      try {
        await this.renew();
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return false;
        }
        // Offline: keep the session; requests will retry renewal.
        this.opts.logger.warn('Could not renew the stored session at startup', err);
      }
    }
    if (!this.session) {
      return false;
    }
    this.scheduleExpiryTimers();
    this.emitter.fire({ type: 'signedIn', loginUser: this.session.loginUser });
    return true;
  }

  /** Remaining throttle in whole seconds, or 0. */
  loginThrottleRemaining(): number {
    if (this.lastFailedLoginAt === null) {
      return 0;
    }
    const remaining = this.lastFailedLoginAt + this.loginThrottleMs - this.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  }

  async login(email: string, password: string): Promise<LoomUser | null> {
    const throttled = this.loginThrottleRemaining();
    if (throttled > 0) {
      throw new LoginThrottledError(throttled);
    }
    if (this.loginInFlight) {
      return this.loginInFlight;
    }
    const trimmedEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      throw new InvalidCredentialsError('Enter a valid email address.');
    }
    if (!password) {
      throw new InvalidCredentialsError('Enter your password.');
    }

    this.loginInFlight = this.doLogin(trimmedEmail, password);
    try {
      return await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async doLogin(email: string, password: string): Promise<LoomUser | null> {
    let result;
    try {
      result = await this.opts.authApi.login(email, password);
    } catch (err) {
      if (err instanceof UnauthorizedError || (err instanceof LoomApiError && [400, 403, 422].includes(err.status ?? 0))) {
        this.lastFailedLoginAt = this.now();
        this.opts.logger.info('Sign-in rejected by Loom');
        throw new InvalidCredentialsError(err.status === 401 || !err.message ? 'Invalid email or password.' : err.message);
      }
      throw err;
    }

    this.lastFailedLoginAt = null;
    this.clearTimers();
    this.session = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      loginUser: result.user,
    };
    await this.opts.tokens.save(this.session);
    this.scheduleExpiryTimers();
    this.opts.logger.info('Signed in to Loom');
    this.emitter.fire({ type: 'signedIn', loginUser: result.user });
    return result.user;
  }

  async getAccessToken(): Promise<string> {
    if (this.renewal) {
      return this.renewal;
    }
    const session = this.session;
    if (!session) {
      throw new AuthRequiredError();
    }
    const expiresAt = decodeJwtExpiry(session.accessToken);
    if (expiresAt === null || expiresAt - this.now() > this.renewalWindowMs) {
      return session.accessToken;
    }
    if (expiresAt <= this.now() && !this.canRefresh) {
      await this.clearSession('expired');
      throw new AuthRequiredError('Your Loom session has expired. Please sign in again.');
    }
    if (!this.canRefresh) {
      // Still valid for a few seconds; the expiringSoon prompt is already shown.
      return session.accessToken;
    }
    try {
      return await this.renew();
    } catch (err) {
      // A failed proactive renewal shouldn't block a token that is still valid.
      if (err instanceof NetworkError && this.session && expiresAt > this.now()) {
        return this.session.accessToken;
      }
      throw err;
    }
  }

  async handleUnauthorized(failedToken?: string): Promise<string> {
    if (this.renewal) {
      return this.renewal;
    }
    if (!this.session) {
      throw new AuthRequiredError();
    }
    // Another request already renewed the token: just retry with the new one.
    if (failedToken && this.session.accessToken !== failedToken) {
      return this.session.accessToken;
    }
    if (!this.canRefresh) {
      await this.clearSession('expired');
      throw new AuthRequiredError('Your Loom session has expired. Please sign in again.');
    }
    return this.renew();
  }

  async invalidateSession(reason: string): Promise<void> {
    this.opts.logger.info(`Loom session invalidated (${reason})`);
    await this.clearSession('rejected');
  }

  async logout(): Promise<void> {
    await this.clearSession('logout');
    this.opts.logger.info('Signed out of Loom');
  }

  dispose(): void {
    this.clearTimers();
    this.emitter.dispose();
  }

  /** Single-flight renewal using the configured refresh endpoint. */
  private renew(): Promise<string> {
    if (this.renewal) {
      return this.renewal;
    }
    this.renewal = this.doRenew().finally(() => {
      this.renewal = null;
    });
    return this.renewal;
  }

  private async doRenew(): Promise<string> {
    const session = this.session;
    const refreshPath = this.opts.refreshPath().trim();
    if (!session || !session.refreshToken || !refreshPath) {
      await this.clearSession('expired');
      throw new AuthRequiredError('Your Loom session has expired. Please sign in again.');
    }
    try {
      const result = await this.opts.authApi.refresh(refreshPath, session.refreshToken);
      if (this.session !== session) {
        // Logged out (or in as someone else) while renewing; discard.
        throw new AuthRequiredError();
      }
      this.session = {
        ...session,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken ?? session.refreshToken,
      };
      await this.opts.tokens.save(this.session);
      this.scheduleExpiryTimers();
      this.opts.logger.info('Loom session renewed');
      return this.session.accessToken;
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        throw err;
      }
      if (err instanceof NetworkError || (err instanceof LoomApiError && (err.status ?? 0) >= 500)) {
        throw err;
      }
      this.opts.logger.warn('Loom session renewal was rejected', err);
      await this.clearSession('expired');
      throw new AuthRequiredError('Your Loom session has expired. Please sign in again.');
    }
  }

  private scheduleExpiryTimers(): void {
    this.clearTimers();
    const session = this.session;
    if (!session) {
      return;
    }
    const expiresAt = decodeJwtExpiry(session.accessToken);
    if (expiresAt === null) {
      return;
    }
    const untilRenewal = Math.max(0, expiresAt - this.renewalWindowMs - this.now());
    const untilExpiry = Math.max(0, expiresAt - this.now());

    if (untilRenewal <= MAX_TIMER_MS) {
      this.timers.push(
        this.scheduler.setTimeout(() => {
          if (this.session !== session) {
            return;
          }
          if (this.canRefresh) {
            this.renew().catch((err) => this.opts.logger.warn('Scheduled renewal failed', err));
          } else {
            this.emitter.fire({ type: 'expiringSoon', expiresAt });
          }
        }, untilRenewal),
      );
    }
    if (untilExpiry <= MAX_TIMER_MS) {
      this.timers.push(
        this.scheduler.setTimeout(() => {
          if (this.session === session && !this.renewal) {
            void this.clearSession('expired');
          }
        }, untilExpiry),
      );
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) {
      this.scheduler.clearTimeout(t);
    }
    this.timers = [];
  }

  private async clearSession(reason: SignOutReason): Promise<void> {
    const hadSession = this.session !== null;
    this.session = null;
    this.clearTimers();
    await this.opts.tokens.clear();
    if (hadSession || reason === 'logout') {
      this.emitter.fire({ type: 'signedOut', reason });
    }
  }
}
