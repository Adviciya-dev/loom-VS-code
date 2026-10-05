import { z } from 'zod';

/**
 * Loom user profile. Only `id` and `email` are relied upon; every other field is
 * optional because `/auth/me` and the login response may return different subsets.
 */
export const LoomUserSchema = z
  .object({
    id: z.union([z.string(), z.number()]).transform(String),
    email: z.string(),
    name: z.string().nullish(),
    fullName: z.string().nullish(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    role: z.string().nullish(),
    avatarUrl: z.string().nullish(),
    avatar: z.string().nullish(),
    githubUsername: z.string().nullish(),
  })
  .passthrough();

export type LoomUserRaw = z.infer<typeof LoomUserSchema>;

export interface LoomUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeUser(raw: LoomUserRaw): LoomUser {
  const composed = [raw.firstName, raw.lastName].map(nonEmpty).filter(Boolean).join(' ');
  return {
    id: raw.id,
    email: raw.email,
    name: nonEmpty(raw.name) ?? nonEmpty(raw.fullName) ?? nonEmpty(composed) ?? raw.email,
    role: nonEmpty(raw.role),
    avatarUrl: nonEmpty(raw.avatarUrl) ?? nonEmpty(raw.avatar),
    githubUsername: nonEmpty(raw.githubUsername),
  };
}

/**
 * `/auth/me` is the source of truth. Fields it leaves empty are filled from the
 * login response's user object when that has them.
 */
export function mergeUsers(me: LoomUser, fromLogin: LoomUser | null | undefined): LoomUser {
  if (!fromLogin || fromLogin.id !== me.id) {
    return me;
  }
  return {
    id: me.id,
    email: me.email,
    name: me.name !== me.email ? me.name : fromLogin.name,
    role: me.role ?? fromLogin.role,
    avatarUrl: me.avatarUrl ?? fromLogin.avatarUrl,
    githubUsername: me.githubUsername ?? fromLogin.githubUsername,
  };
}

export function initials(user: Pick<LoomUser, 'name' | 'email'>): string {
  const source = user.name && user.name !== user.email ? user.name : user.email.split('@')[0];
  const words = source.split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) {
    return '?';
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
