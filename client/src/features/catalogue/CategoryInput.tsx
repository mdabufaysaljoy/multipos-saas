import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { posCategoriesApi } from '@/api/posCategories';

/**
 * The category field on an item form: type a new name, or pick one the shop
 * already uses. A name that is not in the list yet joins it when the item is
 * saved, so a shop never has to visit the categories screen first; the server
 * refuses only names the owner deliberately hid.
 */
export function CategoryInput({
  id,
  label,
  value,
  onChange,
  api,
  queryKey,
  kind = 'categories',
  maxLength = 60,
  placeholder = 'General',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  api: ReturnType<typeof posCategoriesApi>;
  /** The vertical's cache key, e.g. 'supershop'. */
  queryKey: string;
  /**
   * Which name list this is, for the cache key and the placeholder. Defaults to
   * categories, so every existing caller behaves exactly as before; Super Shop's
   * brand field passes 'brands'.
   */
  kind?: 'categories' | 'brands';
  maxLength?: number;
  placeholder?: string;
}) {
  const { data } = useQuery({ queryKey: [queryKey, kind, 'options'], queryFn: () => api.list() });
  const listId = `${id}-options`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} list={listId} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <datalist id={listId}>
        {(data ?? []).map((row) => (
          <option key={row.slug} value={row.name} />
        ))}
      </datalist>
    </div>
  );
}
