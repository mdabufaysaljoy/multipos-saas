import DOMPurify from 'isomorphic-dompurify';

/**
 * Cleans marketing HTML on the SERVER.
 *
 * The browser sanitises too, but that is a courtesy to the author - it stops
 * them previewing something the recipient will not get. It is not a control:
 * a campaign can be posted straight to the API with no browser involved. This
 * is the copy that decides what actually leaves the building.
 *
 * The allow-list mirrors `client/src/lib/sanitizeHtml.ts`; keep them in step so
 * the preview matches what is sent.
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

export function sanitizeEmailHtml(dirty: string): string {
  return DOMPurify.sanitize(dirty, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // Blocks javascript:, data: and every other non-navigational scheme.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'formaction'],
    KEEP_CONTENT: true,
  });
}

/**
 * A readable plain-text fallback for mail clients that refuse HTML.
 *
 * Derived from the sanitised HTML rather than the raw input, so it can never
 * carry markup the HTML part had stripped.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h1|h2|h3|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}
