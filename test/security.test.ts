import { describe, expect, it } from 'vitest';
import { Logger, REDACTED, redact, redactString } from '../src/utils/logger';
import { descriptionPreview, escapeHtml, htmlToPlainText, sanitizeDescriptionHtml } from '../src/utils/sanitizer';
import { FAKE_PASSWORD, fakeJwt } from './helpers';

describe('Log redaction', () => {
  const jwt = fakeJwt(3600);

  it('redacts sensitive object keys at any depth', () => {
    const out = redact({
      email: 'dev@example.test',
      password: FAKE_PASSWORD,
      nested: { accessToken: jwt, refresh_token: 'fake-refresh', headers: { Authorization: `Bearer ${jwt}` } },
      list: [{ token: 'abc' }],
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_PASSWORD);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('fake-refresh');
    expect(text).toContain('dev@example.test');
    expect(out).toMatchObject({ password: REDACTED, nested: { accessToken: REDACTED, headers: { Authorization: REDACTED } } });
  });

  it('redacts secrets embedded in strings', () => {
    expect(redactString(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
    expect(redactString('header bearer abc.def-123')).toBe(`header bearer ${REDACTED}`);
    expect(redactString(`token is ${jwt} ok`)).toBe(`token is ${REDACTED} ok`);
    expect(redactString(`{"password":"${FAKE_PASSWORD}","email":"x@y.test"}`)).toBe(
      `{"password":"${REDACTED}","email":"x@y.test"}`,
    );
    expect(redactString('?refreshToken=abc123&page=2')).toBe(`?refreshToken="${REDACTED}"&page=2`);
    expect(redactString("accessToken: 'zzz'")).toBe(`accessToken: "${REDACTED}"`);
  });

  it('redacts Headers objects and errors', () => {
    const headers = new Headers({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });
    expect(redact(headers)).toEqual({ authorization: REDACTED, 'content-type': 'application/json' });
    expect(JSON.stringify(redact(new Error(`failed with ${jwt}`)))).not.toContain(jwt);
  });

  it('handles circular structures', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a.self = a;
    expect(redact(a)).toEqual({ name: 'x', self: '[Circular]' });
  });

  it('never lets secrets reach the logger sink', () => {
    const lines: string[] = [];
    const logger = new Logger({ appendLine: (l) => lines.push(l) }, 'debug');
    logger.info(`Signing in with password=${FAKE_PASSWORD}`, { authorization: `Bearer ${jwt}` });
    logger.error('Request failed', new Error(`Bearer ${jwt}`));
    const all = lines.join('\n');
    expect(all).not.toContain(FAKE_PASSWORD);
    expect(all).not.toContain(jwt);
  });

  it('logs warnOnce only once per key', () => {
    const lines: string[] = [];
    const logger = new Logger({ appendLine: (l) => lines.push(l) });
    logger.warnOnce('status:x', 'unknown x');
    logger.warnOnce('status:x', 'unknown x');
    expect(lines).toHaveLength(1);
  });
});

describe('HTML sanitization', () => {
  it('keeps simple formatting', () => {
    const html = '<p>Hello <strong>bold</strong><br><code>x()</code></p>';
    expect(sanitizeDescriptionHtml(html)).toBe('<p>Hello <strong>bold</strong><br /><code>x()</code></p>');
  });

  it('removes scripts, handlers, styles, iframes and images', () => {
    const out = sanitizeDescriptionHtml(
      '<p onclick="steal()">Hi</p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><img src=x onerror=alert(1)>',
    );
    expect(out).toBe('<p>Hi</p>');
  });

  it('only allows safe link schemes', () => {
    expect(sanitizeDescriptionHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitizeDescriptionHtml('<a href="https://ok.test">x</a>')).toBe('<a href="https://ok.test" rel="noopener noreferrer">x</a>');
  });

  it('handles empty input', () => {
    expect(sanitizeDescriptionHtml(null)).toBe('');
    expect(sanitizeDescriptionHtml('')).toBe('');
  });

  it('strips HTML to plain text with entity decoding', () => {
    expect(htmlToPlainText('<p>One</p><p>Two &amp; three</p><br>Four&nbsp;five')).toBe('One Two & three Four five');
    expect(htmlToPlainText('<script>evil()</script>Safe')).toBe('Safe');
  });

  it('truncates previews to about 140 characters on a word boundary', () => {
    const long = `<p>${'word '.repeat(60)}</p>`;
    const preview = descriptionPreview(long);
    expect(preview.length).toBeLessThanOrEqual(141);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toMatch(/wor…$/);
    expect(descriptionPreview('<p>short</p>')).toBe('short');
  });

  it('escapes text for webview interpolation', () => {
    expect(escapeHtml(`<img src="x" onerror='y'>&`)).toBe('&lt;img src=&quot;x&quot; onerror=&#39;y&#39;&gt;&amp;');
  });
});
