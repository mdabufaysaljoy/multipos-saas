import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { PackagePlus, Pencil, Plus, ShoppingBasket, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { PageHeader } from '@/components/PageHeader';
import { LimitAlert } from '@/components/LimitAlert';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { LoadingState } from '@/components/states';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatMoney } from '@/lib/money';
import { formatQuantity, formatVatRate, gramsToKgText, parseKgToGrams, parseVatPercent, vatPercentText } from '@/lib/supershop';
import { useAuth } from '@/hooks/useAuth';
import type { ShopMovement, ShopProduct, ShopUnitType } from '@/types/supershop';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const MOVEMENT_LABELS: Record<ShopMovement['type'], string> = {
  receive: 'Received',
  sale: 'Sold',
  void: 'Sale voided',
  adjust: 'Count corrected',
  write_off: 'Written off',
};

/** Parses a quantity for a unit type: whole pieces, or kilograms to grams. */
const parseQuantity = (raw: string, unitType: ShopUnitType): number | null => {
  if (unitType === 'weight') return parseKgToGrams(raw);
  return /^\d{1,7}$/.test(raw.trim()) && Number(raw) > 0 ? Number(raw) : null;
};

/** The supershop catalogue with this branch's stock: add, price, receive and count. */
export function ShopProductsPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [category, setCategory] = React.useState('all');
  const [lowOnly, setLowOnly] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<ShopProduct | 'new' | null>(null);
  const [receiving, setReceiving] = React.useState<ShopProduct | null>(null);
  const [adjusting, setAdjusting] = React.useState<ShopProduct | null>(null);
  const [viewing, setViewing] = React.useState<ShopProduct | null>(null);
  const [deleting, setDeleting] = React.useState<ShopProduct | null>(null);

  const { data: categories } = useQuery({ queryKey: ['supershop', 'categories'], queryFn: supershopApi.categories });
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['supershop', 'products', search, category, lowOnly, page],
    queryFn: () =>
      supershopApi.products({
        page,
        limit: 25,
        ...(search ? { search } : {}),
        ...(category !== 'all' ? { category } : {}),
        ...(lowOnly ? { lowStockOnly: 'true' } : {}),
      }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['supershop'] });

  const remove = useMutation({
    mutationFn: (id: string) => supershopApi.removeProduct(id),
    onSuccess: () => {
      toast.success('Product removed', { description: 'Past sales keep their details.' });
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the product')),
  });

  const columns: Column<ShopProduct>[] = [
    {
      key: 'name',
      header: 'Product',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">
            {[row.brand, row.category, row.barcode && `#${row.barcode}`].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => (
        <div>
          <p className="tabular font-medium">
            {formatMoney(row.priceMinor, currency)}
            {row.unitType === 'weight' ? '/kg' : ''}
          </p>
          {row.vatRateBps > 0 && <p className="text-xs text-muted-foreground">incl. {formatVatRate(row.vatRateBps)} VAT</p>}
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'In stock',
      cell: (row) => {
        const onHand = row.stock?.quantityOnHand ?? 0;
        const low = row.reorderLevel > 0 && onHand <= row.reorderLevel;
        return (
          <div className="flex flex-wrap items-center gap-1">
            <span className={low ? 'tabular font-medium text-destructive' : 'tabular'}>{formatQuantity(onHand, row.unitType)}</span>
            {!row.isActive && <Badge variant="secondary">Not for sale</Badge>}
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <PermissionGate anyOf={['inventory.adjust']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setReceiving(row)} aria-label={`Receive stock of ${row.name}`}>
              <PackagePlus />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setAdjusting(row)} aria-label={`Adjust stock of ${row.name}`}>
              <SlidersHorizontal />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['products.edit']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setEditing(row)} aria-label={`Edit ${row.name}`}>
              <Pencil />
            </Button>
          </PermissionGate>
          <PermissionGate anyOf={['products.delete']}>
            <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(row)} aria-label={`Remove ${row.name}`}>
              <Trash2 />
            </Button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Products"
        description="Prices include VAT. Weighed goods are priced per kilogram."
        actions={
          <PermissionGate anyOf={['products.create']}>
            <Button onClick={() => setEditing('new')}>
              <Plus />
              Add product
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="products" />

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <SearchInput
            value={term}
            onChange={(value) => {
              setTerm(value);
              setPage(1);
            }}
            placeholder="Name, brand or barcode…"
            className="w-full sm:max-w-xs"
          />
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44" aria-label="Department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {(categories ?? []).map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={lowOnly}
              onCheckedChange={(value) => {
                setLowOnly(value);
                setPage(1);
              }}
            />
            Low stock only
          </label>
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error ? errorMessage(error, 'Could not load products') : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={setViewing}
          emptyTitle={lowOnly ? 'Nothing is low on stock' : 'No products yet'}
          emptyDescription={lowOnly ? undefined : 'Add what you sell, then receive stock.'}
        />
      </Card>

      {editing !== null && (
        <ProductDialog
          key={editing === 'new' ? 'new' : editing._id}
          product={editing === 'new' ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {receiving && (
        <ReceiveDialog
          key={receiving._id}
          product={receiving}
          currency={currency}
          onClose={() => setReceiving(null)}
          onSaved={() => {
            setReceiving(null);
            refresh();
          }}
        />
      )}
      {adjusting && (
        <AdjustDialog
          key={adjusting._id}
          product={adjusting}
          onClose={() => setAdjusting(null)}
          onSaved={() => {
            setAdjusting(null);
            refresh();
          }}
        />
      )}
      <ProductHistoryDialog product={viewing} currency={currency} onClose={() => setViewing(null)} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? 'product'}?`}
        description="Only possible when no branch holds stock of it. Past sales keep their details."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}

function ProductDialog({
  product,
  currency,
  onClose,
  onSaved,
}: {
  product: ShopProduct | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(product?.name ?? '');
  const [brand, setBrand] = React.useState(product?.brand ?? '');
  const [category, setCategory] = React.useState(product?.category ?? 'General');
  const [barcode, setBarcode] = React.useState(product?.barcode ?? '');
  const [unitType, setUnitType] = React.useState<ShopUnitType>(product?.unitType ?? 'each');
  const [price, setPrice] = React.useState<number | null>(product ? product.priceMinor : null);
  const [vat, setVat] = React.useState(product ? vatPercentText(product.vatRateBps) : '0');
  const [reorder, setReorder] = React.useState(
    product ? (product.unitType === 'weight' ? gramsToKgText(product.reorderLevel) : String(product.reorderLevel)) : '0',
  );
  const [isActive, setIsActive] = React.useState(product?.isActive ?? true);

  const vatBps = parseVatPercent(vat);
  const reorderLevel = reorder.trim() === '0' || reorder.trim() === '' ? 0 : parseQuantity(reorder, unitType);

  const save = useMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        brand: brand.trim(),
        category: category.trim() || 'General',
        barcode: barcode.trim(),
        priceMinor: price ?? 0,
        vatRateBps: vatBps ?? 0,
        reorderLevel: reorderLevel ?? 0,
        isActive,
      };
      return product ? supershopApi.updateProduct(product._id, common) : supershopApi.createProduct({ ...common, unitType });
    },
    onSuccess: () => {
      toast.success(product ? 'Product updated' : 'Product added');
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the product')),
  });

  const valid = name.trim().length > 0 && price !== null && vatBps !== null && reorderLevel !== null && /^[A-Za-z0-9-]*$/.test(barcode.trim());

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBasket className="h-4 w-4" />
            {product ? 'Edit product' : 'New product'}
          </DialogTitle>
          <DialogDescription>A price change affects new sales only.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="shop-name" label="Name" value={name} max={120} onChange={setName} placeholder="Miniket rice" />
          <TextField id="shop-brand" label="Brand" value={brand} max={80} onChange={setBrand} placeholder="Optional" />
          <TextField id="shop-category" label="Department" value={category} max={60} onChange={setCategory} />
          <TextField id="shop-barcode" label="Barcode" value={barcode} max={64} onChange={setBarcode} placeholder="Scan or type" />
          <div className="space-y-1.5">
            <Label>Sold</Label>
            <Select value={unitType} onValueChange={(value) => setUnitType(value as ShopUnitType)} disabled={Boolean(product)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="each">By the piece</SelectItem>
                <SelectItem value="weight">By weight (per kg)</SelectItem>
              </SelectContent>
            </Select>
            {product && <p className="text-xs text-muted-foreground">Fixed once created: stock and sales are counted in it.</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Price {unitType === 'weight' ? 'per kg' : 'per piece'} (incl. VAT)</Label>
            <MoneyInput value={price} onChange={setPrice} ariaLabel="Price" />
          </div>
          <TextField id="shop-vat" label="VAT rate (%)" value={vat} max={6} onChange={setVat} />
          <TextField id="shop-reorder" label={`Reorder level${unitType === 'weight' ? ' (kg)' : ''}`} value={reorder} max={10} onChange={setReorder} />
        </div>
        <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span>
            For sale
            <span className="block text-xs text-muted-foreground">Turn off to stop selling without removing it.</span>
          </span>
          <Switch checked={isActive} onCheckedChange={setIsActive} />
        </label>
        {vatBps === null && <p className="text-sm text-destructive">VAT: a percentage from 0 to 100.</p>}
        <p className="text-xs text-muted-foreground">Prices are in {currency}.</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {product ? 'Save changes' : 'Add product'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  id,
  label,
  value,
  max,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} maxLength={max} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function ReceiveDialog({ product, currency, onClose, onSaved }: { product: ShopProduct; currency: string; onClose: () => void; onSaved: () => void }) {
  const [quantity, setQuantity] = React.useState('');
  const [cost, setCost] = React.useState<number | null>(null);
  const [supplier, setSupplier] = React.useState('');
  const parsed = parseQuantity(quantity, product.unitType);

  const receive = useMutation({
    mutationFn: () => supershopApi.receiveStock(product._id, { quantity: parsed!, costPriceMinor: cost ?? 0, supplierName: supplier.trim() }),
    onSuccess: (stock) => {
      toast.success(`${product.name}: ${formatQuantity(stock.quantityOnHand, product.unitType)} now in stock`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not receive the stock')),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receive stock</DialogTitle>
          <DialogDescription>
            {product.name} into this branch. The average cost is updated automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="receive-qty" label={product.unitType === 'weight' ? 'Weight (kg)' : 'Pieces'} value={quantity} max={10} onChange={setQuantity} />
          <div className="space-y-1.5">
            <Label>Cost {product.unitType === 'weight' ? 'per kg' : 'per piece'}</Label>
            <MoneyInput value={cost} onChange={setCost} ariaLabel="Cost" />
          </div>
          <div className="sm:col-span-2">
            <TextField id="receive-supplier" label="Supplier" value={supplier} max={120} onChange={setSupplier} placeholder="Optional" />
          </div>
        </div>
        {quantity !== '' && parsed === null && (
          <p className="text-sm text-destructive">{product.unitType === 'weight' ? 'Enter a weight like 25 or 12.5' : 'Enter a whole number of pieces'}</p>
        )}
        <p className="text-xs text-muted-foreground">Amounts are in {currency}.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={parsed === null || cost === null} loading={receive.isPending} onClick={() => receive.mutate()}>
            Receive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ product, onClose, onSaved }: { product: ShopProduct; onClose: () => void; onSaved: () => void }) {
  const onHand = product.stock?.quantityOnHand ?? 0;
  const [type, setType] = React.useState<'write_off' | 'adjust'>('adjust');
  const [amount, setAmount] = React.useState('');
  const [reason, setReason] = React.useState('');

  // A write-off names how much to remove; a correction names the counted total.
  const parsed = amount.trim() === '0' ? 0 : parseQuantity(amount, product.unitType);
  const delta = parsed === null ? 0 : type === 'write_off' ? -parsed : parsed - onHand;

  const save = useMutation({
    mutationFn: () => supershopApi.adjustStock(product._id, { type, quantityDelta: delta, reason: reason.trim() }),
    onSuccess: (result) => {
      toast.success(`${product.name}: ${formatQuantity(result.stock.quantityOnHand, product.unitType)} now in stock`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not adjust the stock')),
  });

  const valid = parsed !== null && delta !== 0 && reason.trim().length >= 3 && onHand + delta >= 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adjust {product.name}</DialogTitle>
          <DialogDescription>
            {formatQuantity(onHand, product.unitType)} in stock. Every adjustment is recorded with your name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value as typeof type);
              setAmount('');
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="adjust">Correct the count</SelectItem>
              <SelectItem value="write_off">Write off (damaged, expired, lost)</SelectItem>
            </SelectContent>
          </Select>
          <TextField
            id="adjust-amount"
            label={`${type === 'write_off' ? 'Amount to remove' : 'Amount actually counted'}${product.unitType === 'weight' ? ' (kg)' : ''}`}
            value={amount}
            max={10}
            onChange={setAmount}
          />
          {parsed !== null && delta !== 0 && (
            <p className="text-xs text-muted-foreground">
              Change: {delta > 0 ? '+' : '-'}
              {formatQuantity(Math.abs(delta), product.unitType)}
            </p>
          )}
          <TextField id="adjust-reason" label="Reason" value={reason} max={200} onChange={setReason} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={type === 'write_off' ? 'destructive' : 'default'} disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {type === 'write_off' ? 'Write off' : 'Save count'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProductHistoryDialog({ product, currency, onClose }: { product: ShopProduct | null; currency: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['supershop', 'product', product?._id],
    queryFn: () => supershopApi.product(product!._id),
    enabled: Boolean(product),
  });
  const current = data?.product;

  return (
    <Dialog open={Boolean(product)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{product?.name}</DialogTitle>
          <DialogDescription>
            {current
              ? `${formatQuantity(current.stock?.quantityOnHand ?? 0, current.unitType)} in stock · average cost ${formatMoney(current.stock?.costPriceMinor ?? 0, currency)}${current.unitType === 'weight' ? '/kg' : ''}`
              : ' '}
          </DialogDescription>
        </DialogHeader>
        {isLoading || !data ? (
          <LoadingState label="Loading history…" />
        ) : data.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stock changes in this branch yet.</p>
        ) : (
          <ul className="divide-y text-sm">
            {data.movements.map((movement) => (
              <li key={movement._id} className="flex items-start justify-between gap-3 py-2">
                <div>
                  <p className="font-medium">{MOVEMENT_LABELS[movement.type]}</p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(movement.createdAt), 'd MMM, HH:mm')} · {movement.createdByNameSnapshot}
                    {movement.referenceNumber ? ` · ${movement.referenceNumber}` : ''}
                    {movement.reason ? ` · ${movement.reason}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={movement.quantity < 0 ? 'tabular text-destructive' : 'tabular text-success'}>
                    {movement.quantity > 0 ? '+' : '-'}
                    {formatQuantity(Math.abs(movement.quantity), movement.unitType)}
                  </p>
                  <p className="text-xs text-muted-foreground">left {formatQuantity(movement.balanceAfter, movement.unitType)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
