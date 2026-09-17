import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ImageOff, Layers, PackageX, ScanBarcode } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { EmptyState, LoadingState } from '@/components/states';
import { productApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { groupVariantsByProduct, type PosProductGroup } from './groupVariants';

interface ProductSearchPanelProps {
  /** Receives a whole product group; the page decides whether to prompt. */
  onSelect: (group: PosProductGroup) => void;
  currency: string;
  onScanClick?: () => void;
}

export function ProductSearchPanel({ onSelect, currency, onScanClick }: ProductSearchPanelProps) {
  const [term, setTerm] = React.useState('');
  const debounced = useDebounced(term, 250);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // F2 focuses search from anywhere on the POS - the standard till shortcut.
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['pos-search', debounced],
    queryFn: () => productApi.posSearch({ q: debounced, limit: 40 }),
    staleTime: 10_000,
  });

  // Memoised: a fresh `[]` on every render would re-run the grouping below each time.
  const variants = React.useMemo(() => data ?? [], [data]);
  // ONE card per product, not one per variant.
  const groups = React.useMemo(() => groupVariantsByProduct(variants), [variants]);

  // A typed SKU/barcode that resolves to exactly one item is added immediately.
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    const needle = term.trim();
    if (!needle) return;

    const exact = variants.find((v) => v.barcode === needle || v.sku === needle.toUpperCase());
    const target = exact ?? (variants.length === 1 ? variants[0] : null);
    if (!target || target.stock <= 0) return;

    // Wrap the single variant in its own group so the page adds it directly.
    const group = groups.find((g) => g.productId === target.productId);
    if (!group) return;
    onSelect({ ...group, variants: [target] });
    setTerm('');
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
      <div className="border-b p-3">
        <div className="flex gap-2">
          <SearchInput
            inputRef={searchRef}
            value={term}
            onChange={setTerm}
            autoFocus
            className="flex-1"
            placeholder="Search by name, SKU or scan a barcode…  (F2)"
          />
          {onScanClick && (
            <Button type="button" variant="default" className="shrink-0" onClick={onScanClick}>
              <ScanBarcode />
              <span className="hidden sm:inline">Scan</span>
            </Button>
          )}
        </div>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScanBarcode className="h-3.5 w-3.5" />
          A barcode scanner works anywhere on this screen — no need to click first
        </p>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        {isLoading && <LoadingState label="Searching…" />}
        {isError && <EmptyState title="Could not load products" description="Check your connection and try again." />}

        {!isLoading && !isError && groups.length === 0 && (
          <EmptyState
            icon={<PackageX className="h-6 w-6" />}
            title={term ? 'No matching products' : 'No products yet'}
            description={term ? 'Try a different name, SKU or barcode.' : 'Add products to start selling.'}
          />
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
          {groups.map((group) => {
            const outOfStock = group.totalStock <= 0;
            const multiVariant = group.variants.length > 1;
            const priceLabel =
              group.minPriceMinor === group.maxPriceMinor
                ? formatMoney(group.minPriceMinor, currency)
                : `${formatMoney(group.minPriceMinor, currency)} – ${formatMoney(group.maxPriceMinor, currency)}`;

            return (
              <button
                key={group.productId}
                type="button"
                disabled={outOfStock}
                onClick={() => onSelect(group)}
                className={cn(
                  'group flex flex-col gap-2 rounded-lg border bg-card p-2.5 text-left transition-all',
                  outOfStock
                    ? 'cursor-not-allowed opacity-55'
                    : 'hover:border-primary hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring',
                )}
              >
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted">
                  {group.imageUrl ? (
                    <img src={group.imageUrl} alt={group.productName} className="h-full w-full object-cover" />
                  ) : (
                    <ImageOff className="h-6 w-6 text-muted-foreground/50" />
                  )}
                  {multiVariant && (
                    <Badge variant="secondary" className="absolute right-1 top-1 gap-1 px-1.5 py-0.5 text-[10px]">
                      <Layers className="h-2.5 w-2.5" />
                      {group.variants.length}
                    </Badge>
                  )}
                </div>

                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium leading-tight">{group.productName}</p>
                  {group.brand && <p className="truncate text-xs text-muted-foreground">{group.brand}</p>}
                </div>

                {/* Compact variant chips, e.g. S M L XL - so the cashier can see
                    at a glance what the product comes in without 12 cards. */}
                {group.chips.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {group.chips.slice(0, 5).map((chip) => (
                      <span
                        key={chip}
                        className="rounded border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
                      >
                        {chip}
                      </span>
                    ))}
                    {group.chips.length > 5 && (
                      <span className="px-1 text-[10px] text-muted-foreground">+{group.chips.length - 5}</span>
                    )}
                  </div>
                )}

                <div className="mt-auto flex items-center justify-between gap-1">
                  <span className="tabular truncate text-sm font-semibold">{priceLabel}</span>
                  {outOfStock ? (
                    <Badge variant="destructive">Out</Badge>
                  ) : (
                    <Badge variant="secondary">{group.totalStock}</Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
