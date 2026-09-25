import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The department chips above a till's item list. One component for every POS
 * type: the names come from that vertical's `/categories`, so a category the
 * owner hid is not offered here either.
 */
export function CategoryFilter({
  categories,
  value,
  onChange,
  className,
}: {
  categories: string[];
  /** 'all' or a category name. */
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  if (categories.length === 0) return null;
  return (
    <div className={cn('scrollbar-thin flex gap-1.5 overflow-x-auto pb-0.5', className)}>
      {['all', ...categories].map((name) => (
        <Button
          key={name}
          type="button"
          size="sm"
          variant={value === name ? 'default' : 'outline'}
          className="shrink-0"
          onClick={() => onChange(name)}
        >
          {name === 'all' ? 'All' : name}
        </Button>
      ))}
    </div>
  );
}
