import * as React from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ImageOff, Layers, PackageX, ScanBarcode } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { EmptyState, LoadingState } from '@/components/states';
import { categoryApi, productApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CategorySelect } from './CategorySelect';
import { ScannerStatus } from './ScannerStatus';
import { useScannerPresence } from './useScannerPresence';
import { isLoyaltyCardCode } from '@/features/loyalty/loyaltyMath';
import { groupVariantsByProduct, type PosProductGroup } from './groupVariants';

interface ProductSearchPanelProps {
  /** Receives a whole product group; the page decides whether to prompt. */
  onSelect: (group: PosProductGroup) => void;
  currency: string;
  onScanClick?: () => void;
  /** UX only: the server checks the permission again when the sale is created. */
  canSellOutOfStock?: boolean;
  /**
   * A loyalty card scanned or typed into the search box. Returns true when it
   * was a member card, so the code is not also looked up as a product.
   */
  onCardCode?: (code: string) => Promise<boolean>;
}

export function ProductSearchPanel({ onSelect, currency, onScanClick, canSellOutOfStock = false, onCardCode }: ProductSearchPanelProps) {
  const [term, setTerm] = React.useState('');
  const debounced = useDebounced(term, 250);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const scanner = useScannerPresence();

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

  const [categoryId, setCategoryId] = React.useState<string>('');
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

  // Categories come from the store's own catalogue - nothing is hard-coded.
  // Only categories that hold products are offered as filters.
  const { data: categoryPage } = useQuery({
    // Under 'pos-search' so saving a product refreshes which categories hold products.
    queryKey: ['pos-search', 'categories'],
    queryFn: () => categoryApi.list({ limit: 100 }),
    staleTime: 60_000,
  });
  const categories = React.useMemo(
    () => (categoryPage?.items ?? []).filter((category) => (category.productCount ?? 0) > 0),
    [categoryPage],
  );
  // A category that disappears (deleted, emptied) quietly falls back to All.
  React.useEffect(() => {
    if (categoryId && categoryPage && !categories.some((category) => category._id === categoryId)) setCategoryId('');
  }, [categories, categoryId, categoryPage]);

  // Paged by product. The key holds search AND category, so changing either
  // starts again from page 1 - pages from different filters never mix. It sits
  // under 'pos-search', which every screen that changes stock already refreshes.
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['pos-search', 'catalog', debounced, categoryId],
    queryFn: ({ pageParam }) =>
      productApi.posCatalog({ q: debounced, page: pageParam, limit: 24, ...(categoryId ? { categoryId } : {}) }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 10_000,
  });

  // A new filter shows its first page from the top, not wherever the old list was scrolled.
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [debounced, categoryId]);

  // Infinite scroll: the next page loads as the end of the grid comes into view.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { root: scrollRef.current, rootMargin: '300px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Memoised: a fresh `[]` on every render would re-run the grouping below each time.
  const variants = React.useMemo(() => (data?.pages ?? []).flatMap((page) => page.items), [data]);
  const activeCategory = categories.find((category) => category._id === categoryId) ?? null;
  // ONE card per product, not one per variant.
  const groups = React.useMemo(() => groupVariantsByProduct(variants), [variants]);

  // A typed SKU/barcode that resolves to exactly one item is added immediately.
  const handleKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter') return;
    const needle = term.trim();
    if (!needle) return;
    if (onCardCode && isLoyaltyCardCode(needle)) {
      event.preventDefault();
      if (await onCardCode(needle)) {
        setTerm('');
        return;
      }
    }

    let pool = variants;
    let exact = pool.find((v) => v.barcode === needle || v.sku === needle.toUpperCase());
    // A code is looked up across the whole store, whatever category is selected
    // or however far the grid has loaded - the same lookup the scanner uses.
    if (!exact) {
      try {
        pool = await productApi.posSearch({ q: needle, limit: 5 });
        exact = pool.find((v) => v.barcode === needle || v.sku === needle.toUpperCase());
      } catch {
        return;
      }
    }
    const target = exact ?? (variants.length === 1 ? variants[0] : null);
    if (!target || (target.stock <= 0 && !canSellOutOfStock)) return;

    // Wrap the single variant in its own group so the page adds it directly.
    const group = groupVariantsByProduct(pool).find((g) => g.productId === target.productId);
    if (!group) return;
    onSelect({ ...group, variants: [target] });
    setTerm('');
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={(event) => void handleKeyDown(event)}>
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
        <ScannerStatus scanner={scanner} hint="scan anywhere on this screen" />
      </div>

      {categories.length > 0 && (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} className="sm:max-w-xs" />
          {categoryId && (
            <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={() => setCategoryId('')}>
              Clear
            </Button>
          )}
        </div>
      )}

      <div ref={scrollRef} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {isLoading && <LoadingState label="Searching…" />}
        {isError && <EmptyState title="Could not load products" description="Check your connection and try again." />}

        {!isLoading && !isError && groups.length === 0 && (
          <EmptyState
            icon={<PackageX className="h-6 w-6" />}
            title={
              term
                ? activeCategory
                  ? `No matching products in ${activeCategory.name}`
                  : 'No matching products'
                : activeCategory
                  ? 'No products found in this category.'
                  : 'No products yet'
            }
            description={
              term ? 'Try a different name, SKU or barcode.' : activeCategory ? 'Choose another category, or All.' : 'Add products to start selling.'
            }
          />
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4">
          {groups.map((group) => {
            const outOfStock = group.totalStock <= 0;
            const blocked = outOfStock && !canSellOutOfStock;
            const multiVariant = group.variants.length > 1;
            const priceLabel =
              group.minPriceMinor === group.maxPriceMinor
                ? formatMoney(group.minPriceMinor, currency)
                : `${formatMoney(group.minPriceMinor, currency)} – ${formatMoney(group.maxPriceMinor, currency)}`;

            return (
              <button
                key={group.productId}
                type="button"
                disabled={blocked}
                onClick={() => onSelect(group)}
                className={cn(
                  'group flex flex-col gap-2 rounded-lg border bg-card p-2.5 text-left transition-all',
                  blocked
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
                  {outOfStock && canSellOutOfStock ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="text-[10px] font-semibold text-warning">Sell anyway</span>
                      <Badge variant="destructive">Out</Badge>
                    </span>
                  ) : outOfStock ? (
                    <Badge variant="destructive">Out</Badge>
                  ) : (
                    <Badge variant="secondary">{group.totalStock}</Badge>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Loads the next page when scrolled into view; the button is a fallback. */}
        <div ref={sentinelRef} className="h-px" aria-hidden />
        {hasNextPage && (
          <div className="flex justify-center py-3">
            <Button type="button" variant="outline" size="sm" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
              Load more products
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
