import * as React from 'react';
import { Barcode, Loader2, Plus, Printer, Trash2, Wand2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MoneyInput } from '@/components/MoneyInput';
import { QuantityInput } from '@/components/QuantityInput';
import { productApi } from '@/api/endpoints';
import { ApiError } from '@/api/client';
import { toast } from 'sonner';

export interface OptionAxis {
  name: string;
  values: string[];
}

export interface VariantDraft {
  key: string;
  attributes: { name: string; value: string }[];
  name: string;
  sku: string;
  sellingPriceMinor: number | null;
  costPriceMinor: number | null;
  stock: number | null;
  lowStockThreshold: number | null;
  barcode: string;
  isActive: boolean;
}

interface VariantMatrixEditorProps {
  options: OptionAxis[];
  onOptionsChange: (options: OptionAxis[]) => void;
  variants: VariantDraft[];
  onVariantsChange: (variants: VariantDraft[]) => void;
  /** Existing products cannot regenerate the matrix - variants hold stock. */
  allowGenerate?: boolean;
  /** Opens the label print dialog for a variant that already has a barcode. */
  onPrintBarcode?: (variant: VariantDraft) => void;
}

const label = (attributes: { name: string; value: string }[]) =>
  attributes.length === 0 ? 'Default' : attributes.map((a) => a.value).join(' / ');

const keyFor = (attributes: { name: string; value: string }[]) =>
  attributes.map((a) => `${a.name}:${a.value}`).join('|') || 'default';

/** Cartesian product of the option axes. */
function buildCombinations(options: OptionAxis[]): { name: string; value: string }[][] {
  const usable = options.filter((option) => option.name.trim() && option.values.length > 0);
  if (usable.length === 0) return [[]];

  return usable.reduce<{ name: string; value: string }[][]>(
    (acc, option) =>
      acc.flatMap((combo) => option.values.map((value) => [...combo, { name: option.name.trim(), value }])),
    [[]],
  );
}

/**
 * The clothing-specific part of the product form: define the Color/Size axes,
 * then edit each generated combination as its own sellable variant with its own
 * SKU, price and stock.
 */
export function VariantMatrixEditor({
  options,
  onOptionsChange,
  variants,
  onVariantsChange,
  allowGenerate = true,
  onPrintBarcode,
}: VariantMatrixEditorProps) {
  const [newValue, setNewValue] = React.useState<Record<number, string>>({});
  const [generating, setGenerating] = React.useState<string | null>(null);

  /**
   * Asks the server for a fresh EAN-13. Generating server-side is what makes
   * uniqueness real - the database also holds a unique index as a backstop.
   */
  const generateBarcode = async (key: string) => {
    setGenerating(key);
    try {
      const { barcode } = await productApi.generateBarcode();
      updateVariant(key, { barcode });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not generate a barcode');
    } finally {
      setGenerating(null);
    }
  };

  const addAxis = () => onOptionsChange([...options, { name: '', values: [] }]);

  const updateAxis = (index: number, patch: Partial<OptionAxis>) =>
    onOptionsChange(options.map((option, i) => (i === index ? { ...option, ...patch } : option)));

  const removeAxis = (index: number) => onOptionsChange(options.filter((_, i) => i !== index));

  const addValue = (index: number) => {
    const value = (newValue[index] ?? '').trim();
    if (!value) return;
    const axis = options[index];
    if (axis.values.includes(value)) return;
    updateAxis(index, { values: [...axis.values, value] });
    setNewValue((prev) => ({ ...prev, [index]: '' }));
  };

  const removeValue = (index: number, value: string) =>
    updateAxis(index, { values: options[index].values.filter((v) => v !== value) });

  /** Rebuilds the matrix, preserving anything already typed for a combination. */
  const generate = () => {
    const combinations = buildCombinations(options);
    const existing = new Map(variants.map((variant) => [keyFor(variant.attributes), variant]));
    const template = variants[0];

    onVariantsChange(
      combinations.map((attributes) => {
        const key = keyFor(attributes);
        const previous = existing.get(key);
        if (previous) return previous;
        return {
          key,
          attributes,
          name: label(attributes),
          sku: '',
          // New rows inherit the first row's pricing, which is what a shop
          // almost always wants across sizes of one garment.
          sellingPriceMinor: template?.sellingPriceMinor ?? null,
          costPriceMinor: template?.costPriceMinor ?? null,
          stock: 0,
          lowStockThreshold: template?.lowStockThreshold ?? 0,
          barcode: '',
          isActive: true,
        };
      }),
    );
  };

  const updateVariant = (key: string, patch: Partial<VariantDraft>) =>
    onVariantsChange(variants.map((variant) => (variant.key === key ? { ...variant, ...patch } : variant)));

  const removeVariant = (key: string) => onVariantsChange(variants.filter((variant) => variant.key !== key));

  /** Copies row one's price down the column - a common bulk edit. */
  const applyPriceToAll = () => {
    const first = variants[0];
    if (!first) return;
    onVariantsChange(
      variants.map((variant) => ({
        ...variant,
        sellingPriceMinor: first.sellingPriceMinor,
        costPriceMinor: first.costPriceMinor,
      })),
    );
  };

  const combinationCount = buildCombinations(options).length;

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <Label>Options</Label>
            <p className="text-xs text-muted-foreground">
              Add axes such as Color and Size. Each combination becomes its own sellable variant.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addAxis} disabled={options.length >= 3}>
            <Plus />
            Add option
          </Button>
        </div>

        {options.map((option, index) => (
          <div key={index} className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={option.name}
                onChange={(event) => updateAxis(index, { name: event.target.value })}
                placeholder="Color"
                className="max-w-[180px]"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto text-muted-foreground hover:text-destructive"
                onClick={() => removeAxis(index)}
                aria-label="Remove option"
              >
                <Trash2 />
              </Button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {option.values.map((value) => (
                <Badge key={value} variant="secondary" className="gap-1 pr-1">
                  {value}
                  <button
                    type="button"
                    onClick={() => removeValue(index, value)}
                    className="rounded-full p-0.5 hover:bg-black/10"
                    aria-label={`Remove ${value}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                value={newValue[index] ?? ''}
                onChange={(event) => setNewValue((prev) => ({ ...prev, [index]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addValue(index);
                  }
                }}
                placeholder="Black, then press Enter"
                className="max-w-[220px]"
              />
              <Button type="button" variant="outline" size="sm" onClick={() => addValue(index)}>
                Add
              </Button>
            </div>
          </div>
        ))}

        {allowGenerate && (
          <Button type="button" variant="secondary" onClick={generate} className="w-full">
            <Wand2 />
            Generate {combinationCount} variant{combinationCount === 1 ? '' : 's'}
          </Button>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Variants ({variants.length})</Label>
          {variants.length > 1 && (
            <Button type="button" variant="ghost" size="sm" onClick={applyPriceToAll}>
              Copy first row’s prices to all
            </Button>
          )}
        </div>

        <div className="scrollbar-thin overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Variant</th>
                <th className="px-3 py-2 text-left font-semibold">SKU</th>
                <th className="px-3 py-2 text-left font-semibold">Barcode</th>
                <th className="px-3 py-2 text-left font-semibold">Sell price</th>
                <th className="px-3 py-2 text-left font-semibold">Cost</th>
                <th className="px-3 py-2 text-left font-semibold">Stock</th>
                <th className="px-3 py-2 text-left font-semibold">Low at</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {variants.map((variant) => (
                <tr key={variant.key} className="border-b last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{variant.name}</td>
                  <td className="px-3 py-2">
                    <Input
                      value={variant.sku}
                      onChange={(event) => updateVariant(variant.key, { sku: event.target.value.toUpperCase() })}
                      placeholder="auto"
                      className="h-8 w-32 font-mono text-xs"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <Input
                        value={variant.barcode}
                        onChange={(event) => updateVariant(variant.key, { barcode: event.target.value.trim() })}
                        placeholder="scan or generate"
                        // Marked so a hardware scanner can fill this field directly.
                        data-barcode-target="true"
                        className="h-8 w-36 font-mono text-xs"
                        aria-label={`Barcode for ${variant.name}`}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        title="Generate a unique barcode"
                        disabled={generating === variant.key}
                        onClick={() => void generateBarcode(variant.key)}
                      >
                        {generating === variant.key ? <Loader2 className="animate-spin" /> : <Barcode />}
                      </Button>
                      {onPrintBarcode && variant.barcode && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          title="Print labels"
                          onClick={() => onPrintBarcode(variant)}
                        >
                          <Printer />
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <MoneyInput
                      value={variant.sellingPriceMinor}
                      onChange={(value) => updateVariant(variant.key, { sellingPriceMinor: value })}
                      className="w-28"
                      ariaLabel={`Selling price for ${variant.name}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <MoneyInput
                      value={variant.costPriceMinor}
                      onChange={(value) => updateVariant(variant.key, { costPriceMinor: value })}
                      className="w-28"
                      ariaLabel={`Cost price for ${variant.name}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <QuantityInput
                      value={variant.stock}
                      onChange={(value) => updateVariant(variant.key, { stock: value })}
                      showSteppers={false}
                      ariaLabel={`Opening stock for ${variant.name}`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <QuantityInput
                      value={variant.lowStockThreshold}
                      onChange={(value) => updateVariant(variant.key, { lowStockThreshold: value })}
                      showSteppers={false}
                      ariaLabel={`Low stock threshold for ${variant.name}`}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {variants.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => removeVariant(variant.key)}
                        aria-label={`Remove ${variant.name}`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-muted-foreground">
          Leave a SKU blank to have one generated. Opening stock is recorded in the inventory ledger.
        </p>
      </section>
    </div>
  );
}

export { buildCombinations, keyFor, label as variantLabel };
