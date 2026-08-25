import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ImageUpload } from '@/components/ImageUpload';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { categoryApi, productApi } from '@/api/endpoints';
import { VariantMatrixEditor, keyFor, variantLabel, type OptionAxis, type VariantDraft } from './VariantMatrixEditor';
import { BarcodePrintDialog } from '@/features/barcode/BarcodePrintDialog';
import type { BarcodeLabelData } from '@/features/barcode/BarcodeLabel';
import { useAuth } from '@/hooks/useAuth';

interface ProductFormDialogProps {
  open: boolean;
  productId: string | null;
  onOpenChange: (open: boolean) => void;
}

interface Details {
  name: string;
  sku: string;
  categoryId: string;
  brand: string;
  description: string;
  /** Optional product photo. null renders a placeholder everywhere. */
  imageUrl: string | null;
  isActive: boolean;
}

const EMPTY_DETAILS: Details = {
  name: '',
  sku: '',
  categoryId: 'none',
  brand: '',
  description: '',
  imageUrl: null,
  isActive: true,
};

const blankVariant = (): VariantDraft => ({
  key: 'default',
  attributes: [],
  name: 'Default',
  sku: '',
  sellingPriceMinor: null,
  costPriceMinor: 0,
  stock: 0,
  lowStockThreshold: 0,
  barcode: '',
  isActive: true,
});

export function ProductFormDialog({ open, productId, onOpenChange }: ProductFormDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(productId);

  const [details, setDetails] = React.useState<Details>(EMPTY_DETAILS);
  const [printLabel, setPrintLabel] = React.useState<BarcodeLabelData | null>(null);
  const { activeStore } = useAuth();
  const [options, setOptions] = React.useState<OptionAxis[]>([]);
  const [variants, setVariants] = React.useState<VariantDraft[]>([blankVariant()]);
  const [tab, setTab] = React.useState('details');
  const [errors, setErrors] = React.useState<string[]>([]);

  const { data: categories } = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => categoryApi.list({ limit: 100 }),
    enabled: open,
  });

  const { data: existing, isLoading } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => productApi.get(productId!),
    enabled: open && Boolean(productId),
  });

  // Load an existing product into the form, or reset for a new one.
  React.useEffect(() => {
    if (!open) return;
    setErrors([]);
    setTab('details');

    if (existing && productId) {
      setDetails({
        name: existing.name,
        sku: existing.sku,
        categoryId: existing.categoryId ?? 'none',
        brand: existing.brand,
        description: existing.description,
        imageUrl: existing.images?.find((i) => i.isPrimary)?.url ?? existing.images?.[0]?.url ?? null,
        isActive: existing.isActive,
      });
      setOptions(existing.options.map((option) => ({ name: option.name, values: [...option.values] })));
      setVariants(
        existing.variants.map((variant) => ({
          key: variant._id,
          attributes: variant.attributes,
          name: variant.name,
          sku: variant.sku,
          sellingPriceMinor: variant.sellingPriceMinor,
          costPriceMinor: variant.costPriceMinor,
          stock: variant.stock,
          lowStockThreshold: variant.lowStockThreshold,
          barcode: variant.barcode ?? '',
          isActive: variant.isActive,
        })),
      );
    } else if (!productId) {
      setDetails(EMPTY_DETAILS);
      setOptions([]);
      setVariants([blankVariant()]);
    }
  }, [open, existing, productId]);

  const validate = (): string[] => {
    const found: string[] = [];
    if (details.name.trim().length < 1) found.push('Product name is required');
    if (variants.length === 0) found.push('Add at least one variant');

    variants.forEach((variant) => {
      // A price of null (cleared field) or 0 is refused here AND by the server.
      if (variant.sellingPriceMinor === null || variant.sellingPriceMinor <= 0) {
        found.push(`"${variant.name}" needs a selling price greater than zero`);
      }
      if (variant.stock === null) {
        found.push(`"${variant.name}" needs an opening stock (use 0 for none)`);
      }
    });

    const skus = variants.map((v) => v.sku.trim().toUpperCase()).filter(Boolean);
    const duplicates = skus.filter((sku, index) => skus.indexOf(sku) !== index);
    if (duplicates.length > 0) found.push(`Duplicate SKU: ${[...new Set(duplicates)].join(', ')}`);

    return found;
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: details.name.trim(),
        ...(details.sku.trim() ? { sku: details.sku.trim().toUpperCase() } : {}),
        categoryId: details.categoryId === 'none' ? null : details.categoryId,
        brand: details.brand.trim(),
        description: details.description.trim(),
        // Optional: an empty list is perfectly valid.
        images: details.imageUrl ? [{ url: details.imageUrl, key: null, isPrimary: true }] : [],
        isActive: details.isActive,
        options: options
          .filter((option) => option.name.trim() && option.values.length > 0)
          .map((option) => ({ name: option.name.trim(), values: option.values })),
      };

      if (isEdit && productId) {
        await productApi.update(productId, payload);
        // Variant details are patched individually; stock is deliberately not
        // editable here so every stock change goes through the ledger.
        for (const variant of variants) {
          const original = existing?.variants.find((v) => v._id === variant.key);
          if (!original) {
            await productApi.addVariant(productId, {
              attributes: variant.attributes,
              name: variant.name,
              ...(variant.sku.trim() ? { sku: variant.sku.trim().toUpperCase() } : {}),
              sellingPriceMinor: variant.sellingPriceMinor,
              costPriceMinor: variant.costPriceMinor ?? 0,
              stock: variant.stock ?? 0,
              lowStockThreshold: variant.lowStockThreshold ?? 0,
              barcode: variant.barcode || null,
              isActive: variant.isActive,
            });
            continue;
          }
          await productApi.updateVariant(productId, variant.key, {
            attributes: variant.attributes,
            name: variant.name,
            ...(variant.sku.trim() ? { sku: variant.sku.trim().toUpperCase() } : {}),
            sellingPriceMinor: variant.sellingPriceMinor,
            costPriceMinor: variant.costPriceMinor ?? 0,
            lowStockThreshold: variant.lowStockThreshold ?? 0,
            barcode: variant.barcode || null,
            isActive: variant.isActive,
          });
        }
        return;
      }

      await productApi.create({
        ...payload,
        variants: variants.map((variant) => ({
          attributes: variant.attributes,
          name: variant.name,
          ...(variant.sku.trim() ? { sku: variant.sku.trim().toUpperCase() } : {}),
          sellingPriceMinor: variant.sellingPriceMinor,
          costPriceMinor: variant.costPriceMinor ?? 0,
          stock: variant.stock ?? 0,
          lowStockThreshold: variant.lowStockThreshold ?? 0,
          barcode: variant.barcode || null,
          isActive: variant.isActive,
        })),
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Product updated' : 'Product created');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      void queryClient.invalidateQueries({ queryKey: ['product', productId] });
      void queryClient.invalidateQueries({ queryKey: ['pos-search'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => {
      const message = error instanceof ApiError ? error.message : 'Could not save the product';
      setErrors([message]);
      toast.error(message);
    },
  });

  const handleSubmit = () => {
    const found = validate();
    setErrors(found);
    if (found.length > 0) {
      toast.error('Please fix the highlighted issues');
      setTab('variants');
      return;
    }
    save.mutate();
  };

  // Keep the single default variant's label in step when options are removed.
  React.useEffect(() => {
    if (options.length === 0 && variants.length === 1 && variants[0].attributes.length > 0) {
      setVariants([{ ...variants[0], attributes: [], name: 'Default', key: keyFor([]) }]);
    }
  }, [options.length, variants]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit product' : 'New product'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Changes apply from now on. Past sales keep the name and price they were sold at.'
              : 'Define the garment, then generate a variant for each colour and size.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <LoadingState label="Loading product…" />
        ) : (
          <div className="scrollbar-thin -mx-1 max-h-[62vh] overflow-y-auto px-1">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="variants">Variants ({variants.length})</TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="p-name">Product name</Label>
                    <Input
                      id="p-name"
                      autoFocus
                      value={details.name}
                      onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
                      placeholder="Classic Cotton T-Shirt"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="p-sku">Base SKU</Label>
                    <Input
                      id="p-sku"
                      value={details.sku}
                      onChange={(e) => setDetails((d) => ({ ...d, sku: e.target.value.toUpperCase() }))}
                      placeholder="Leave blank to generate"
                      className="font-mono"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="p-brand">Brand</Label>
                    <Input
                      id="p-brand"
                      value={details.brand}
                      onChange={(e) => setDetails((d) => ({ ...d, brand: e.target.value }))}
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="p-cat">Category</Label>
                    <Select
                      value={details.categoryId}
                      onValueChange={(value) => setDetails((d) => ({ ...d, categoryId: value }))}
                    >
                      <SelectTrigger id="p-cat">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No category</SelectItem>
                        {(categories?.items ?? []).map((category) => (
                          <SelectItem key={category._id} value={category._id}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="rounded-md border p-3 sm:col-span-2">
                    <ImageUpload
                      label="Product image"
                      hint="Optional. Shown on POS product cards; a placeholder is used when empty."
                      value={details.imageUrl}
                      onChange={(url) => setDetails((d) => ({ ...d, imageUrl: url }))}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-md border p-3">
                    <div>
                      <Label htmlFor="p-active">Active</Label>
                      <p className="text-xs text-muted-foreground">Inactive products cannot be sold</p>
                    </div>
                    <Switch
                      id="p-active"
                      checked={details.isActive}
                      onCheckedChange={(checked) => setDetails((d) => ({ ...d, isActive: checked }))}
                    />
                  </div>

                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="p-desc">Description</Label>
                    <Textarea
                      id="p-desc"
                      rows={3}
                      value={details.description}
                      onChange={(e) => setDetails((d) => ({ ...d, description: e.target.value }))}
                    />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="variants">
                <VariantMatrixEditor
                  onPrintBarcode={(variant) =>
                    setPrintLabel({
                      barcode: variant.barcode,
                      productName: details.name || 'Product',
                      variantName: variant.name,
                      sku: variant.sku,
                      priceMinor: variant.sellingPriceMinor ?? 0,
                    })
                  }
                  options={options}
                  onOptionsChange={setOptions}
                  variants={variants}
                  onVariantsChange={setVariants}
                  allowGenerate
                />
                {isEdit && (
                  <p className="mt-3 rounded-md bg-muted p-3 text-xs text-muted-foreground">
                    Stock is not editable here. Use <strong>Inventory → Adjust</strong> so every change is recorded in
                    the ledger with a reason.
                  </p>
                )}
              </TabsContent>
            </Tabs>

            {errors.length > 0 && (
              <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                <p className="font-semibold">Please fix the following:</p>
                <ul className="mt-1 list-inside list-disc">
                  {errors.map((message, index) => (
                    <li key={index}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={save.isPending}>
            {isEdit ? 'Save changes' : 'Create product'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <BarcodePrintDialog
        label={printLabel}
        currency={activeStore?.currency ?? 'BDT'}
        storeName={activeStore?.name}
        onClose={() => setPrintLabel(null)}
      />

    </Dialog>
  );
}

export { variantLabel };
