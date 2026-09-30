import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { restaurantApi } from '@/api/restaurant';

/**
 * The subsection field on a dish form: type a new name, or pick one this
 * SECTION already uses.
 *
 * It mirrors `CategoryInput` one level down, with the difference that makes the
 * hierarchy work - the list is narrowed to the chosen section, because a
 * subsection belongs to exactly one. A name that is not in the list yet joins
 * it when the dish is saved, so nobody has to visit a management screen first.
 *
 * Leaving it empty is normal: most dishes sit directly under their section.
 */
export function SubcategoryInput({
  id,
  category,
  value,
  onChange,
}: {
  id: string;
  /** The section whose subsections are offered. */
  category: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['restaurant', 'subcategories', 'options', category],
    queryFn: () => restaurantApi.subcategories(category ? { category } : undefined),
    enabled: Boolean(category),
  });
  const listId = `${id}-options`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Subsection</Label>
      <Input
        id={id}
        list={listId}
        value={value}
        maxLength={60}
        autoComplete="off"
        placeholder={category ? `Optional, within ${category}` : 'Choose a section first'}
        disabled={!category}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {(data ?? []).map((row) => (
          <option key={row.slug} value={row.name} />
        ))}
      </datalist>
    </div>
  );
}
