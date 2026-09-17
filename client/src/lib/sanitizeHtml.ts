import DOMPurify from 'isomorphic-dompurify';

/**
 * Tags and attributes permitted in marketing email bodies.
 *
 * Deliberately narrow: enough for formatted marketing copy, nothing that can
 * execute. `script`, every `on*` handler and `javascript:` URLs are stripped by
 * DOMPurify because they are simply not on this list.
 */
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'p', 'br', 'hr',
  'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'a', 'span', 'div',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'img', 'blockquote',
];

const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'src', 'alt', 'width', 'height', 'style', 'align'];

/**
 * Cleans user-authored HTML before it is previewed or sent.
 *
 * Run on BOTH the preview and the outgoing payload: a preview that renders
 * something the recipient will not receive is misleading, and sanitising only
 * at send time would leave the editor itself as an XSS surface.
 */
export function sanitizeEmailHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Blocks javascript:, data: and other non-navigational schemes in href/src.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction'],
    KEEP_CONTENT: true,
  });
}

/** True when sanitising would change the input - used to warn the author. */
export function wasSanitized(dirty: string): boolean {
  if (!dirty.trim()) return false;
  return sanitizeEmailHtml(dirty).replace(/\s+/g, '') !== dirty.replace(/\s+/g, '');
}

/** Rough plain-text fallback for mail clients that refuse HTML. */
export function htmlToPlainText(html: string): string {
  return sanitizeEmailHtml(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|h3|li|tr|div)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
