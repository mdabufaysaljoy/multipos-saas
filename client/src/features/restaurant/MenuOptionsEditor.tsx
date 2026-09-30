import * as React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MoneyInput } from '@/components/MoneyInput';

/**
 * Editing the two kinds of option a dish can carry.
 *
 * They are separate components on purpose, because they answer different
 * questions and a kitchen that blurs them ends up with "Large" as an extra:
 *
 *   a VARIANT answers "which version?" - one is chosen, and its price REPLACES
 *   the dish's own price;
 *   an ADD-ON answers "what extra?" - several may be chosen, and each price is
 *   ADDED to the line.
 *
 * Both work on drafts: a row with no `_id` is new, and the server assigns one
 * when the dish is saved.
 */

export interface VariantDraft {
  _id?: string;
  name: string;
  priceMinor: number | null;
  sku: string;
  isAvailable: boolean;
}

export interface AddOnDraft {
  _id?: string;
  name: string;
  priceMinor: number | null;
  isAvailable: boolean;
}

export interface AddOnGroupDraft {
  _id?: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: AddOnDraft[];
}

export const emptyVariant = (): VariantDraft => ({ name: '', priceMinor: null, sku: '', isAvailable: true });
export const emptyAddOn = (): AddOnDraft => ({ name: '', priceMinor: null, isAvailable: true });
export const emptyAddOnGroup = (): AddOnGroupDraft => ({ name: '', minSelect: 0, maxSelect: 1, options: [emptyAddOn()] });

/** A row is worth sending only once it has a name and a price. */
export const isCompleteVariant = (variant: VariantDraft) => variant.name.trim().length > 0 && variant.priceMinor !== null;
export const isCompleteAddOn = (option: AddOnDraft) => option.name.trim().length > 0 && option.priceMinor !== null;

const Section = ({ title, hint, children, onAdd, addLabel }: {
  title: string;
  hint: string;
  children: React.ReactNode;
  onAdd: () => void;
  addLabel: string;
}) => (
  <div className="space-y-2 rounded-md border p-3">
    <div className="flex items-start justify-between gap-2">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onAdd}>
        <Plus />
        {addLabel}
      </Button>
    </div>
    {children}
  </div>
);

export function VariantsEditor({
  variants,
  onChange,
  currency,
}: {
  variants: VariantDraft[];
  onChange: (variants: VariantDraft[]) => void;
  currency: string;
}) {
  const set = (index: number, patch: Partial<VariantDraft>) =>
    onChange(variants.map((variant, i) => (i === index ? { ...variant, ...patch } : variant)));

  return (
    <Section
      title="Sizes and sets"
      hint={
        variants.length === 0
          ? `One price for the dish. Add sizes if it is sold as 8/10/12 inch, Quarter/Half/Full, and so on.`
          : `The dish is sold at these prices instead of its own. Prices are in ${currency}.`
      }
      onAdd={() => onChange([...variants, emptyVariant()])}
      addLabel="Add size"
    >
      {variants.length > 0 && (
        <ul className="space-y-2">
          {variants.map((variant, index) => (
            <li key={variant._id ?? `new-${index}`} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_7rem_7rem_auto]">
              <Input
                value={variant.name}
                maxLength={60}
                placeholder="8 inch"
                aria-label={`Size ${index + 1} name`}
                onChange={(e) => set(index, { name: e.target.value })}
              />
              <MoneyInput
                value={variant.priceMinor}
                onChange={(priceMinor) => set(index, { priceMinor })}
                ariaLabel={`Size ${index + 1} price`}
              />
              <Input
                value={variant.sku}
                maxLength={40}
                placeholder="Code"
                aria-label={`Size ${index + 1} code`}
                onChange={(e) => set(index, { sku: e.target.value })}
              />
              <div className="flex items-center gap-1">
                <Switch
                  checked={variant.isAvailable}
                  onCheckedChange={(isAvailable) => set(index, { isAvailable })}
                  aria-label={`Size ${index + 1} available`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove size ${index + 1}`}
                  onClick={() => onChange(variants.filter((_, i) => i !== index))}
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function AddOnGroupsEditor({
  groups,
  onChange,
  currency,
}: {
  groups: AddOnGroupDraft[];
  onChange: (groups: AddOnGroupDraft[]) => void;
  currency: string;
}) {
  const setGroup = (index: number, patch: Partial<AddOnGroupDraft>) =>
    onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));

  const setOption = (groupIndex: number, optionIndex: number, patch: Partial<AddOnDraft>) =>
    setGroup(groupIndex, {
      options: groups[groupIndex].options.map((option, i) => (i === optionIndex ? { ...option, ...patch } : option)),
    });

  const clampNumber = (value: string, min: number, max: number) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return min;
    return Math.min(max, Math.max(min, parsed));
  };

  return (
    <Section
      title="Extras"
      hint={
        groups.length === 0
          ? 'Optional things a guest can add: extra cheese, extra sauce. Their price is added to the line.'
          : `Each extra taken is added to the line. Prices are in ${currency}.`
      }
      onAdd={() => onChange([...groups, emptyAddOnGroup()])}
      addLabel="Add group"
    >
      {groups.length > 0 && (
        <ul className="space-y-3">
          {groups.map((group, groupIndex) => (
            <li key={group._id ?? `new-${groupIndex}`} className="space-y-2 rounded-md bg-muted/40 p-2">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label className="text-xs">Group</Label>
                  <Input
                    value={group.name}
                    maxLength={60}
                    placeholder="Extras"
                    aria-label={`Group ${groupIndex + 1} name`}
                    onChange={(e) => setGroup(groupIndex, { name: e.target.value })}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <Label className="text-xs">Min</Label>
                  <Input
                    value={String(group.minSelect)}
                    inputMode="numeric"
                    aria-label={`Group ${groupIndex + 1} minimum`}
                    onChange={(e) => setGroup(groupIndex, { minSelect: clampNumber(e.target.value, 0, 20) })}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <Label className="text-xs">Max</Label>
                  <Input
                    value={String(group.maxSelect)}
                    inputMode="numeric"
                    aria-label={`Group ${groupIndex + 1} maximum`}
                    onChange={(e) => setGroup(groupIndex, { maxSelect: clampNumber(e.target.value, 1, 20) })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove group ${groupIndex + 1}`}
                  onClick={() => onChange(groups.filter((_, i) => i !== groupIndex))}
                >
                  <Trash2 />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {group.minSelect > 0 ? `The guest must choose ${group.minSelect}` : 'Choosing is optional'}
                {`, up to ${group.maxSelect}.`}
              </p>

              <ul className="space-y-1.5">
                {group.options.map((option, optionIndex) => (
                  <li key={option._id ?? `new-${optionIndex}`} className="grid grid-cols-[1fr_7rem_auto] gap-2">
                    <Input
                      value={option.name}
                      maxLength={60}
                      placeholder="Extra cheese"
                      aria-label={`Group ${groupIndex + 1} extra ${optionIndex + 1} name`}
                      onChange={(e) => setOption(groupIndex, optionIndex, { name: e.target.value })}
                    />
                    <MoneyInput
                      value={option.priceMinor}
                      onChange={(priceMinor) => setOption(groupIndex, optionIndex, { priceMinor })}
                      ariaLabel={`Group ${groupIndex + 1} extra ${optionIndex + 1} price`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove group ${groupIndex + 1} extra ${optionIndex + 1}`}
                      onClick={() => setGroup(groupIndex, { options: group.options.filter((_, i) => i !== optionIndex) })}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setGroup(groupIndex, { options: [...group.options, emptyAddOn()] })}
              >
                <Plus />
                Add extra
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
