import * as React from 'react';
import { Bold, Italic, Link2, List, Heading1, Heading2, Eye, Code } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { sanitizeEmailHtml, wasSanitized } from '@/lib/sanitizeHtml';
import { cn } from '@/lib/utils';

interface HtmlEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
}

/**
 * A small HTML editor for marketing email.
 *
 * Deliberately a textarea with snippet buttons rather than a rich-text engine:
 * marketing email needs simple, predictable markup that survives every mail
 * client, and a WYSIWYG would add a large dependency to produce worse HTML.
 * The preview is sanitised with the same function used before sending, so what
 * the author sees is exactly what goes out.
 */
export function HtmlEditor({ value, onChange, disabled }: HtmlEditorProps) {
  const [tab, setTab] = React.useState<'edit' | 'preview'>('edit');
  const ref = React.useRef<HTMLTextAreaElement>(null);

  /** Wraps the selection, or inserts a placeholder when nothing is selected. */
  const wrap = (before: string, after: string, placeholder: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
    onChange(next);

    // Restore a sensible selection so the author can keep typing.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  const dirty = wasSanitized(value);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/40 p-1">
        <ToolButton icon={<Heading1 className="h-4 w-4" />} label="Heading" onClick={() => wrap('<h1>', '</h1>', 'Heading')} disabled={disabled} />
        <ToolButton icon={<Heading2 className="h-4 w-4" />} label="Subheading" onClick={() => wrap('<h2>', '</h2>', 'Subheading')} disabled={disabled} />
        <ToolButton icon={<Bold className="h-4 w-4" />} label="Bold" onClick={() => wrap('<strong>', '</strong>', 'bold text')} disabled={disabled} />
        <ToolButton icon={<Italic className="h-4 w-4" />} label="Italic" onClick={() => wrap('<em>', '</em>', 'italic text')} disabled={disabled} />
        <ToolButton icon={<Link2 className="h-4 w-4" />} label="Link" onClick={() => wrap('<a href="https://">', '</a>', 'link text')} disabled={disabled} />
        <ToolButton icon={<List className="h-4 w-4" />} label="List" onClick={() => wrap('<ul>\n  <li>', '</li>\n</ul>', 'item')} disabled={disabled} />
        <ToolButton icon={<Code className="h-4 w-4" />} label="Paragraph" onClick={() => wrap('<p>', '</p>', 'Your text here')} disabled={disabled} />

        <div className="ml-auto flex gap-1">
          <Button type="button" variant={tab === 'edit' ? 'secondary' : 'ghost'} size="sm" className="h-7" onClick={() => setTab('edit')}>
            Edit
          </Button>
          <Button type="button" variant={tab === 'preview' ? 'secondary' : 'ghost'} size="sm" className="h-7" onClick={() => setTab('preview')}>
            <Eye className="h-3.5 w-3.5" />
            Preview
          </Button>
        </div>
      </div>

      {tab === 'edit' ? (
        <Textarea
          ref={ref}
          rows={12}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs"
          placeholder={'<h1>New collection</h1>\n<p>Visit us this weekend for <strong>20% off</strong>.</p>'}
        />
      ) : (
        <div
          className={cn(
            'email-preview min-h-[16rem] rounded-md border bg-white p-4 text-black',
            !value.trim() && 'flex items-center justify-center text-sm text-muted-foreground',
          )}
        >
          {value.trim() ? (
            // Sanitised with the SAME function used before sending.
            <div dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(value) }} />
          ) : (
            'Nothing to preview yet'
          )}
        </div>
      )}

      {dirty && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2 text-xs text-warning">
          Some markup will be removed before sending. Scripts, event handlers and unsupported tags are stripped for
          safety — the preview shows exactly what recipients will get.
        </p>
      )}
    </div>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" title={label} aria-label={label} onClick={onClick} disabled={disabled}>
      {icon}
    </Button>
  );
}
