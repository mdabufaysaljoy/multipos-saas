import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { CategoryInput } from '@/features/catalogue/CategoryInput';
import { parseQuantity } from '@/features/supershop/stockDialogs';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { shopCategoriesApi } from '@/api/posCategories';
import { shopBrandsApi } from '@/api/shopBrands';
import { parseVatPercent } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';
import type { ShopProduct, ShopUnitType } from '@/types/supershop';

/**
 * Creating a product from the till, when a scanned barcode is not in the
 * catalogue.
 *
 * It goes through the ordinary product endpoint - the same validation, the same
 * uniqueness rules, the same plan limit, the same permission - so a product made
 * here is in every way a product made on the Products screen. Nothing about the
 * quick path is a shortcut past a business rule; it is a shorter FORM.
 *
 * The scanned barcode is prefilled and never rewritten behind the cashier's
 * back. They can correct a misread, but nothing here normalises or alters it.
 */
export function QuickCreateDialog({
  barcode,
  currency,
  onClose,
  onCreated,
}: {
  /** Exactly what the scanner read. */
  barcode: string;
  currency: string;
  onClose: () => void;
  /** The new product, ready to drop straight into the basket. */
  onCreated: (product: ShopProduct) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [code, setCode] = React.useState(barcode);
  const [name, setName] = React.useState('');
  const [unitType, setUnitType] = React.useState<ShopUnitType>('each');
  const [price, setPrice] = React.useState<number | null>(null);
  const [category, setCategory] = React.useState('');
  const [brand, setBrand] = React.useState('');
  const [vat, setVat] = React.useState('');
  const [opening, setOpening] = React.useState('');
  const [cost, setCost] = React.useState<number | null>(null);

  // Receiving stock is a different permission from creating a product, so the
  // opening-stock half of the form only appears when the till holds it.
  const canReceive = can('inventory.adjust');
  const vatBps = vat.trim() === '' ? 0 : parseVatPercent(vat);
  const openingQuantity = opening.trim() === '' ? null : parseQuantity(opening, unitType);

  const create = useMutation({
    mutationFn: async () => {
      const product = await supershopApi.createProduct({
        name: name.trim(),
        barcode: code.trim(),
        unitType,
        priceMinor: price ?? 0,
        // The same defaults the server would apply, sent explicitly so the
        // quick form and the full form create identical products.
        category: category.trim() || 'General',
        brand: brand.trim(),
        vatRateBps: vatBps ?? 0,
        reorderLevel: 0,
        isActive: true,
      });
      // Optional, and deliberately a second step through the ordinary stock
      // endpoint: a product exists whether or not the delivery is recorded.
      if (canReceive && openingQuantity && cost !== null) {
        try {
          const stock = await supershopApi.receiveStock(product._id, { quantity: openingQuantity, costPriceMinor: cost });
          return { ...product, stock };
        } catch (error) {
          toast.warning(`${product.name} was created, but its opening stock was not recorded`, {
            description: error instanceof ApiError ? error.message : undefined,
          });
        }
      }
      return product;
    },
    onSuccess: (product) => {
      toast.success(`${product.name} added to the catalogue`);
      void queryClient.invalidateQueries({ queryKey: ['supershop'] });
      onCreated(product as ShopProduct);
      onClose();
    },
    onError: (err) => {
      if (!(err instanceof ApiError)) {
        toast.error('Could not create the product');
        return;
      }
      const [, detail] = Object.entries(err.fieldErrors)[0] ?? [];
      toast.error(detail ?? err.message);
    },
  });

  const invalid =
    code.trim().length === 0 ||
    name.trim().length === 0 ||
    price === null ||
    price <= 0 ||
    vatBps === null ||
    (opening.trim() !== '' && openingQuantity === null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-4 w-4" /> New product
          </DialogTitle>
          <DialogDescription>
            Nothing in this shop has that barcode yet. Add it here and it goes straight into the basket.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="qc-barcode">Barcode</Label>
            <Input id="qc-barcode" value={code} maxLength={64} onChange={(event) => setCode(event.target.value)} />
            <p className="text-xs text-muted-foreground">Scanned as {barcode}. Change it only if the scanner misread.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="qc-name">Name</Label>
            <Input id="qc-name" autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Miniket rice" />
          </div>

          <div className="space-y-1.5">
            <Label>Sold</Label>
            <Select value={unitType} onValueChange={(value) => setUnitType(value as ShopUnitType)}>
              <SelectTrigger aria-label="Sold by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="each">By the piece (pcs)</SelectItem>
                <SelectItem value="weight">By weight (kg)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Fixed once created.</p>
          </div>

          <div className="space-y-1.5">
            <Label>Price {unitType === 'weight' ? 'per kg' : 'per piece'} (incl. VAT)</Label>
            <MoneyInput value={price} onChange={setPrice} ariaLabel="Price" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="qc-vat">VAT rate (%)</Label>
            <Input id="qc-vat" value={vat} maxLength={6} onChange={(event) => setVat(event.target.value)} placeholder="0" />
            {vat.trim() !== '' && vatBps === null && <p className="text-xs text-destructive">Enter a rate like 0, 5 or 15</p>}
          </div>

          <CategoryInput id="qc-category" label="Department" value={category} onChange={setCategory} api={shopCategoriesApi} queryKey="supershop" />
          <CategoryInput
            id="qc-brand"
            label="Brand"
            value={brand}
            onChange={setBrand}
            api={shopBrandsApi}
            queryKey="supershop"
            kind="brands"
            maxLength={80}
            placeholder="Optional"
          />

          {canReceive && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="qc-opening">Opening stock {unitType === 'weight' ? '(kg)' : '(pcs)'}</Label>
                <Input id="qc-opening" value={opening} maxLength={10} onChange={(event) => setOpening(event.target.value)} placeholder="Optional" />
                {opening.trim() !== '' && openingQuantity === null && (
                  <p className="text-xs text-destructive">{unitType === 'weight' ? 'Enter a weight like 25 or 12.5' : 'Enter a whole number of pieces'}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Cost {unitType === 'weight' ? 'per kg' : 'per piece'}</Label>
                <MoneyInput value={cost} onChange={setCost} ariaLabel="Cost" />
                {openingQuantity !== null && cost === null && <p className="text-xs text-destructive">Opening stock needs a cost price</p>}
              </div>
            </>
          )}
        </div>

        <p className="text-xs text-muted-foreground">Amounts are in {currency}.</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={invalid || (openingQuantity !== null && cost === null) || create.isPending}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create and add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
