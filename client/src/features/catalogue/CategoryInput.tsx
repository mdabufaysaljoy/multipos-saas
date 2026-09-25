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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  api: ReturnType<typeof posCategoriesApi>;
  /** The vertical's cache key, e.g. 'supershop'. */
  queryKey: string;
}) {
  const { data } = useQuery({ queryKey: [queryKey, 'categories', 'options'], queryFn: () => api.list() });
  const listId = `${id}-options`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} list={listId} value={value} maxLength={60} onChange={(event) => onChange(event.target.value)} placeholder="General" />
      <datalist id={listId}>
        {(data ?? []).map((row) => (
          <option key={row.slug} value={row.name} />
        ))}
      </datalist>
    </div>
  );
}
