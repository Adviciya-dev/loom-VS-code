import sanitizeHtml from 'sanitize-html';

/**
 * Task descriptions arrive as HTML authored in the Loom web editor. Only a small,
 * formatting-only subset is allowed through; scripts, styles, event handlers,
 * iframes, images and non-http(s) links are removed.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'a',
  'span',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

export function sanitizeDescriptionHtml(html: string | null | undefined): string {
  if (!html) {
    return '';
  }
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href', 'title', 'rel'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in ENTITIES) {
      return ENTITIES[lower];
    }
    if (lower.startsWith('#x')) {
      const code = parseInt(lower.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (lower.startsWith('#')) {
      const code = parseInt(lower.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/** Converts description HTML into a single line of plain text. */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) {
    return '';
  }
  // Keep block boundaries as spaces so "<p>a</p><p>b</p>" doesn't become "ab".
  const spaced = html.replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*\/?>/gi, ' ');
  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/** Plain-text preview for list rows, truncated on a word boundary to roughly `max` characters. */
export function descriptionPreview(html: string | null | undefined, max = 140): string {
  const text = htmlToPlainText(html);
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** Escapes text for safe interpolation into webview HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
