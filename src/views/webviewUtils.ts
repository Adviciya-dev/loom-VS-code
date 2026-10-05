import { randomBytes } from 'node:crypto';

export function createNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Strict CSP: no remote content, scripts only with the nonce. */
export function contentSecurityPolicy(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource}`,
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}
