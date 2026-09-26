import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Every option means "do not filter by this". */
export const ANY = 'all';

/**
 * The department and brand dropdowns above the Super Shop till's item list.
 *
 * Dropdowns rather than the chip row the other verticals use: a supershop has
 * far more departments than a restaurant has menu sections, and brands are open
 * free text, so a row of chips would scroll off the side of a tablet. The chip
 * component (`features/catalogue/CategoryFilter`) is shared with Pharmacy and
 * Restaurant and is left exactly as it is.
 *
 * Both values are names, not ids, because that is how a `ShopProduct` stores its
 * department and brand - and both are sent to the server, so a filter applies to
 * the whole catalogue and not just the page already loaded.
 */
export function PosFilters({
  categories,
  brands,
  category,
  brand,
  onCategory,
  onBrand,
}: {
  categories: string[];
  brands: string[];
  category: string;
  brand: string;
  onCategory: (value: string) => void;
  onBrand: (value: string) => void;
}) {
  if (categories.length === 0 && brands.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {categories.length > 0 && (
        <Select value={category} onValueChange={onCategory}>
          <SelectTrigger className="h-8 min-w-0 flex-1 basis-40" aria-label="Filter by department">
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All departments</SelectItem>
            {categories.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {brands.length > 0 && (
        <Select value={brand} onValueChange={onBrand}>
          <SelectTrigger className="h-8 min-w-0 flex-1 basis-40" aria-label="Filter by brand">
            <SelectValue placeholder="All brands" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All brands</SelectItem>
            {brands.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
