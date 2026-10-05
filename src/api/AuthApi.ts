import { z } from 'zod';
import { LoomUserSchema, normalizeUser } from '../models/User';
import type { LoginResult, RefreshResult } from './ApiTypes';
import type { HttpTransport } from './HttpTransport';

const LoginDataSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().nullish(),
    user: LoomUserSchema.nullish().catch(null),
  })
  .passthrough();

/**
 * The refresh endpoint is not confirmed yet. When one is configured it is
 * expected to return a fresh access token, optionally rotating the refresh token.
 */
const RefreshDataSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().nullish(),
  })
  .passthrough();

/** Unauthenticated auth endpoints. Kept apart from LoomClient so AuthManager has no cycle. */
export class AuthApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /auth/login */
  async login(email: string, password: string): Promise<LoginResult> {
    const data = await this.transport.request({
      method: 'POST',
      path: '/auth/login',
      body: { email, password },
      schema: LoginDataSchema,
    });
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      user: data.user ? normalizeUser(data.user) : null,
    };
  }

  /** POST <refreshPath> — only called when `loom.auth.refreshPath` is configured. */
  async refresh(refreshPath: string, refreshToken: string): Promise<RefreshResult> {
    const data = await this.transport.request({
      method: 'POST',
      path: refreshPath,
      body: { refreshToken },
      schema: RefreshDataSchema,
    });
    return { accessToken: data.accessToken, refreshToken: data.refreshToken ?? null };
  }
}
