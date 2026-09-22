import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, Tags } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CategoryOption {
  _id: string;
  name: string;
  productCount?: number;
}

interface CategorySelectProps {
  categories: CategoryOption[];
  /** '' means All. */
  value: string;
  onChange: (categoryId: string) => void;
  className?: string;
}

/**
 * A searchable category dropdown for the POS grid.
 *
 * Type to narrow the list, arrow keys to move, Enter to choose, Esc to close.
 * Key presses stay inside the dropdown: the POS panel treats Enter as "add the
 * typed code to the cart", so a category search must never reach it.
 */
export function CategorySelect({ categories, value, onChange, className }: CategorySelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const listRef = React.useRef<HTMLUListElement>(null);

  const options = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle ? categories.filter((category) => category.name.toLowerCase().includes(needle)) : categories;
    // "All" is always the first choice unless the search rules it out.
    return !needle || 'all'.includes(needle) ? [{ _id: '', name: 'All categories' }, ...matching] : matching;
  }, [categories, query]);

  const selected = categories.find((category) => category._id === value) ?? null;

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
  }, [open]);

  React.useEffect(() => setHighlight(0), [query]);

  // Keep the highlighted option in view while arrowing through a long list.
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  const choose = (categoryId: string) => {
    onChange(categoryId);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = options[highlight];
      if (option) choose(option._id);
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        type="button"
        aria-label="Filter by category"
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background',
          value && 'border-primary text-primary',
          className,
        )}
      >
        <Tags className="h-4 w-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate text-left">{selected ? selected.name : 'All categories'}</span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          onKeyDown={onKeyDown}
          className={cn(
            'z-50 w-[var(--radix-popover-trigger-width)] min-w-[16rem] max-w-[calc(100vw-1.5rem)] rounded-md border bg-popover text-popover-foreground shadow-md',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 opacity-50" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search categories…"
              aria-label="Search categories"
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <ul ref={listRef} role="listbox" aria-label="Categories" className="scrollbar-thin max-h-72 overflow-y-auto p-1">
            {options.length === 0 && <li className="px-2 py-6 text-center text-sm text-muted-foreground">No category matches “{query}”</li>}
            {options.map((option, index) => {
              const active = option._id === value;
              return (
                <li
                  key={option._id || 'all'}
                  role="option"
                  aria-selected={active}
                  data-index={index}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => choose(option._id)}
                  className={cn(
                    'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
                    index === highlight && 'bg-accent',
                  )}
                >
                  <Check className={cn('h-4 w-4 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                  <span className="min-w-0 flex-1 truncate">{option.name}</span>
                  {'productCount' in option && option.productCount !== undefined && (
                    <span className="shrink-0 text-xs text-muted-foreground">{option.productCount}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
