import type { LoomUser } from '../models/User';

/** Subset of `vscode.SecretStorage` used here, so this module can be tested without VS Code. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string | null;
  /** Profile from the login response; merged with `/auth/me`. Never contains the password. */
  loginUser: LoomUser | null;
}

const SESSION_KEY = 'loom.session.v1';

/**
 * Reads the `exp` claim from a JWT without verifying it. Verification is the
 * server's job; this is only used to decide when to renew.
 * Returns the expiry in epoch milliseconds, or null if absent/unparseable.
 */
export function decodeJwtExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload: unknown = JSON.parse(json);
    if (typeof payload === 'object' && payload !== null && 'exp' in payload) {
      const exp = (payload as { exp: unknown }).exp;
      if (typeof exp === 'number' && Number.isFinite(exp)) {
        return exp * 1000;
      }
    }
  } catch {
    // Not a decodable JWT.
  }
  return null;
}

/** Persists the session in SecretStorage (OS keychain). Nothing here is ever logged. */
export class TokenManager {
  constructor(private readonly secrets: SecretStore) {}

  async load(): Promise<StoredSession | null> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
        await this.clear();
        return null;
      }
      return {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
        loginUser: parsed.loginUser ?? null,
      };
    } catch {
      await this.clear();
      return null;
    }
  }

  async save(session: StoredSession): Promise<void> {
    await this.secrets.store(SESSION_KEY, JSON.stringify(session));
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SESSION_KEY);
  }
}
