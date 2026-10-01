import * as React from 'react';
import { Check, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** The dropdown row that turns the picker into a text box. */
const CREATE = '__create__';
/** The dropdown row that clears an optional field. */
const NONE = '__none__';

/**
 * Pick a name from a list, or type a new one.
 *
 * The Restaurant menu is managed out of a couple of short lists - sections and
 * extras - and a kitchen filling in a dish should be choosing from them, not
 * retyping and misspelling them. So this is a real dropdown, with one extra row
 * at the bottom that swaps it for a text box when what they want is not there
 * yet.
 *
 * Nothing is created here. The name goes back to the form, and the server adds
 * it to the list when the dish is saved - the convention the whole catalogue
 * already follows, so a shop never has to visit a management screen first.
 */
export function NamePicker({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder = 'Choose…',
  emptyLabel = 'None',
  optional = false,
  createLabel = 'New…',
  hint,
}: {
  id: string;
  label: string;
  value: string;
  /** The names already in the list. */
  options: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** What the "no value" row says, when the field is optional. */
  emptyLabel?: string;
  optional?: boolean;
  createLabel?: string;
  hint?: string;
}) {
  // A value that is not in the list yet - typed a moment ago, or a name from
  // before it was hidden - still has to show, so the field keeps it.
  const known = React.useMemo(() => (value && !options.includes(value) ? [value, ...options] : options), [options, value]);
  const [typing, setTyping] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => {
    if (disabled) setTyping(false);
  }, [disabled]);

  const commit = () => {
    const next = draft.trim();
    if (next) onChange(next);
    setDraft('');
    setTyping(false);
  };

  if (typing) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex gap-1.5">
          <Input
            id={id}
            autoFocus
            value={draft}
            maxLength={60}
            placeholder={createLabel}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft('');
                setTyping(false);
              }
            }}
          />
          <Button type="button" variant="outline" size="icon" aria-label={`Use this ${label.toLowerCase()}`} onClick={commit}>
            <Check />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancel"
            onClick={() => {
              setDraft('');
              setTyping(false);
            }}
          >
            <X />
          </Button>
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || (optional ? NONE : '')}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === CREATE) {
            setTyping(true);
            return;
          }
          onChange(next === NONE ? '' : next);
        }}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {optional && <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
          {known.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
          <SelectItem value={CREATE}>
            <span className="flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              {createLabel}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
