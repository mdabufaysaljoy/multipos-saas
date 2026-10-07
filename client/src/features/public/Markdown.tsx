import * as React from 'react';

/**
 * A small Markdown subset, rendered straight to React elements.
 *
 * It builds NO HTML STRING and uses no `dangerouslySetInnerHTML`, which is the
 * whole point. The alternative - render Markdown to HTML and sanitise it - is
 * only as safe as the sanitiser, and this text is written by a platform admin
 * into a database and then served to every anonymous visitor. An admin is
 * trusted, but a stored-XSS hole that only an admin can open is still a
 * stored-XSS hole, and the admin account is exactly what an attacker would be
 * trying to reach. Producing React nodes means there is no injection surface
 * to get wrong, and it costs no dependency.
 *
 * The supported subset is what a policy page actually needs:
 *
 *   # .. ###   headings
 *   - / * / 1. lists
 *   **bold**, *italic*, `code`, [text](https://link)
 *   blank line   paragraph break
 *
 * Anything else renders as the literal text it was written as, which is the
 * right failure: an unsupported construct looks wrong rather than disappearing.
 */

/** Only schemes that cannot execute. `javascript:` and `data:` never pass. */
const safeHref = (raw: string): string | null => {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  if (/^tel:/i.test(href)) return href;
  // A same-origin path, but not `//evil.com` which is protocol-relative.
  if (href.startsWith('/') && !href.startsWith('//')) return href;
  return null;
};

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

/** Bold, italic, code and links inside one line of text. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((piece, index) => {
    const key = `${keyPrefix}-${index}`;

    if (piece.startsWith('**') && piece.endsWith('**')) {
      return <strong key={key}>{piece.slice(2, -2)}</strong>;
    }
    if (piece.startsWith('*') && piece.endsWith('*') && piece.length > 2) {
      return <em key={key}>{piece.slice(1, -1)}</em>;
    }
    if (piece.startsWith('`') && piece.endsWith('`')) {
      return (
        <code key={key} className="rounded bg-slate-100 px-1 py-0.5 text-[0.9em]">
          {piece.slice(1, -1)}
        </code>
      );
    }

    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(piece);
    if (link) {
      const href = safeHref(link[2]);
      // A refused URL keeps its text and loses its link, so the page still
      // reads correctly instead of silently dropping a sentence.
      if (!href) return <span key={key}>{link[1]}</span>;
      const external = /^https?:\/\//i.test(href);
      return (
        <a
          key={key}
          href={href}
          className="font-medium text-indigo-600 underline underline-offset-2 hover:text-indigo-500"
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {link[1]}
        </a>
      );
    }

    return <React.Fragment key={key}>{piece}</React.Fragment>;
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = React.useMemo(() => {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const out: React.ReactNode[] = [];
    let paragraph: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      const text = paragraph.join(' ');
      out.push(
        <p key={`p-${out.length}`} className="mb-4 leading-7 text-slate-600">
          {inline(text, `p-${out.length}`)}
        </p>,
      );
      paragraph = [];
    };

    const flushList = () => {
      if (!list) return;
      const items = list.items.map((item, index) => (
        <li key={index} className="leading-7">
          {inline(item, `li-${out.length}-${index}`)}
        </li>
      ));
      out.push(
        list.ordered ? (
          <ol key={`l-${out.length}`} className="mb-4 list-decimal space-y-1 pl-6 text-slate-600">
            {items}
          </ol>
        ) : (
          <ul key={`l-${out.length}`} className="mb-4 list-disc space-y-1 pl-6 text-slate-600">
            {items}
          </ul>
        ),
      );
      list = null;
    };

    const flushAll = () => {
      flushParagraph();
      flushList();
    };

    for (const raw of lines) {
      const line = raw.trimEnd();

      if (line.trim() === '') {
        flushAll();
        continue;
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        const size =
          level === 1
            ? 'mt-10 mb-4 text-2xl font-bold'
            : level === 2
              ? 'mt-8 mb-3 text-xl font-bold'
              : 'mt-6 mb-2 text-lg font-semibold';
        const Tag = (`h${Math.min(level + 1, 6)}`) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        out.push(
          <Tag key={`h-${out.length}`} className={`${size} text-slate-900 first:mt-0`}>
            {inline(heading[2], `h-${out.length}`)}
          </Tag>,
        );
        continue;
      }

      const bullet = /^[-*]\s+(.*)$/.exec(line);
      const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flushParagraph();
        const ordered = Boolean(numbered);
        // A list that changes kind mid-way starts a new list rather than
        // mixing bullets and numbers under one marker.
        if (list && list.ordered !== ordered) flushList();
        if (!list) list = { ordered, items: [] };
        list.items.push((bullet ?? numbered)![1]);
        continue;
      }

      flushList();
      paragraph.push(line.trim());
    }

    flushAll();
    return out;
  }, [source]);

  return <div className={className}>{blocks}</div>;
}
