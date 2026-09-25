import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Barcode, PackagePlus, Pencil, Pill, Plus, Trash2 } from 'lucide-react';
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
import { BarcodePrintDialog } from '@/features/barcode/BarcodePrintDialog';
import { pharmacyApi } from '@/api/pharmacy';
import { formatMoney } from '@/lib/money';
import { DOSAGE_FORM_LABELS, expiryTone, formatExpiry, todayInputValue } from '@/lib/pharmacy';
import { useAuth } from '@/hooks/useAuth';
import type { DosageForm, Medicine, MedicineInput } from '@/types/pharmacy';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** The medicine catalogue, shared by every branch. Stock shown is this branch's. */
export function MedicinesPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term);
  const [page, setPage] = React.useState(1);
  const [editing, setEditing] = React.useState<Medicine | 'new' | null>(null);
  const [receiving, setReceiving] = React.useState<Medicine | null>(null);
  const [viewing, setViewing] = React.useState<Medicine | null>(null);
  const [deleting, setDeleting] = React.useState<Medicine | null>(null);
  const [labelling, setLabelling] = React.useState<Medicine | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['pharmacy', 'medicines', search, page],
    queryFn: () => pharmacyApi.medicines({ page, limit: 25, ...(search ? { search } : {}) }),
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['pharmacy'] });

  const remove = useMutation({
    mutationFn: (id: string) => pharmacyApi.removeMedicine(id),
    onSuccess: () => {
      toast.success('Medicine removed', { description: 'Past sales keep their details.' });
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the medicine')),
  });

  const columns: Column<Medicine>[] = [
    {
      key: 'name',
      header: 'Medicine',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-medium">
            {row.name} <span className="text-muted-foreground">{row.strength}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {[row.genericName, DOSAGE_FORM_LABELS[row.dosageForm], row.manufacturer].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => <span className="tabular font-medium">{formatMoney(row.sellingPriceMinor, currency)}</span>,
    },
    {
      key: 'flags',
      header: '',
      mobile: 'meta',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.requiresPrescription && <Badge variant="warning">Rx</Badge>}
          {!row.isActive && <Badge variant="secondary">Not for sale</Badge>}
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'In stock',
      cell: (row) => {
        const stock = row.stock;
        const low = stock && row.reorderLevel > 0 && stock.sellable <= row.reorderLevel;
        return (
          <div>
            <p className={low ? 'tabular font-medium text-destructive' : 'tabular'}>{stock?.sellable ?? 0}</p>
            {stock?.nearestExpiry && <p className="text-xs text-muted-foreground">next expiry {formatExpiry(stock.nearestExpiry)}</p>}
            {(stock?.expired ?? 0) > 0 && <p className="text-xs text-destructive">{stock?.expired} expired</p>}
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
          </PermissionGate>
          {row.barcode && (
            <Button variant="ghost" size="icon-sm" onClick={() => setLabelling(row)} aria-label={`Print a label for ${row.name}`}>
              <Barcode />
            </Button>
          )}
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
        title="Medicines"
        description="Prices here are what sales are charged. Stock is received in batches with an expiry date."
        actions={
          <PermissionGate anyOf={['products.create']}>
            <Button onClick={() => setEditing('new')}>
              <Plus />
              Add medicine
            </Button>
          </PermissionGate>
        }
      />
      <LimitAlert resource="products" />

      <Card>
        <div className="border-b p-3">
          <SearchInput
            value={term}
            onChange={(value) => {
              setTerm(value);
              setPage(1);
            }}
            placeholder="Search by brand, generic, barcode…"
            className="w-full sm:max-w-sm"
          />
        </div>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          error={error ? errorMessage(error, 'Could not load medicines') : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          onRowClick={setViewing}
          emptyTitle="No medicines yet"
          emptyDescription="Add the medicines you sell, then receive stock into batches."
        />
      </Card>

      {editing !== null && (
        <MedicineDialog
          key={editing === 'new' ? 'new' : editing._id}
          medicine={editing === 'new' ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {receiving && (
        <ReceiveStockDialog
          key={receiving._id}
          medicine={receiving}
          currency={currency}
          onClose={() => setReceiving(null)}
          onSaved={() => {
            setReceiving(null);
            refresh();
          }}
        />
      )}
      <BatchesDialog medicine={viewing} currency={currency} onClose={() => setViewing(null)} />

      {/* The same label printer the other verticals use; the strength stands in for a variant. */}
      <BarcodePrintDialog
        label={
          labelling
            ? {
                barcode: labelling.barcode,
                productName: labelling.name,
                variantName: labelling.strength,
                sku: labelling.genericName,
                priceMinor: labelling.sellingPriceMinor,
              }
            : null
        }
        currency={currency}
        storeName={activeStore?.name}
        onClose={() => setLabelling(null)}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? 'medicine'}?`}
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

const EMPTY: MedicineInput = {
  name: '',
  genericName: '',
  strength: '',
  dosageForm: 'tablet',
  manufacturer: '',
  category: 'General',
  barcode: '',
  sellingPriceMinor: 0,
  requiresPrescription: false,
  reorderLevel: 0,
  isActive: true,
};

function MedicineDialog({
  medicine,
  currency,
  onClose,
  onSaved,
}: {
  medicine: Medicine | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = React.useState<MedicineInput>(() => (medicine ? { ...EMPTY, ...medicine } : EMPTY));
  const [price, setPrice] = React.useState<number | null>(medicine ? medicine.sellingPriceMinor : null);
  const set = <K extends keyof MedicineInput>(key: K, value: MedicineInput[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body: MedicineInput = {
        name: draft.name.trim(),
        genericName: draft.genericName.trim(),
        strength: draft.strength.trim(),
        dosageForm: draft.dosageForm,
        manufacturer: draft.manufacturer.trim(),
        category: draft.category.trim() || 'General',
        barcode: draft.barcode.trim(),
        sellingPriceMinor: price ?? 0,
        requiresPrescription: draft.requiresPrescription,
        reorderLevel: draft.reorderLevel,
        isActive: draft.isActive,
      };
      return medicine ? pharmacyApi.updateMedicine(medicine._id, body) : pharmacyApi.createMedicine(body);
    },
    onSuccess: () => {
      toast.success(medicine ? 'Medicine updated' : 'Medicine added');
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the medicine')),
  });

  const valid = draft.name.trim().length > 0 && price !== null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pill className="h-4 w-4" />
            {medicine ? 'Edit medicine' : 'New medicine'}
          </DialogTitle>
          <DialogDescription>A price change affects new sales only.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="med-name" label="Brand name" value={draft.name} max={120} onChange={(v) => set('name', v)} placeholder="Napa" />
          <Field id="med-generic" label="Generic name" value={draft.genericName} max={120} onChange={(v) => set('genericName', v)} placeholder="Paracetamol" />
          <Field id="med-strength" label="Strength" value={draft.strength} max={40} onChange={(v) => set('strength', v)} placeholder="500 mg" />
          <div className="space-y-1.5">
            <Label>Form</Label>
            <Select value={draft.dosageForm} onValueChange={(value) => set('dosageForm', value as DosageForm)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(DOSAGE_FORM_LABELS) as DosageForm[]).map((form) => (
                  <SelectItem key={form} value={form}>
                    {DOSAGE_FORM_LABELS[form]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Field id="med-maker" label="Manufacturer" value={draft.manufacturer} max={120} onChange={(v) => set('manufacturer', v)} />
          <Field id="med-category" label="Category" value={draft.category} max={60} onChange={(v) => set('category', v)} />
          <Field id="med-barcode" label="Barcode" value={draft.barcode} max={64} onChange={(v) => set('barcode', v)} placeholder="Optional" />
          <div className="space-y-1.5">
            <Label>Selling price (per unit)</Label>
            <MoneyInput value={price} onChange={setPrice} ariaLabel="Selling price" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="med-reorder">Reorder level</Label>
            <Input
              id="med-reorder"
              inputMode="numeric"
              value={String(draft.reorderLevel)}
              onChange={(event) => set('reorderLevel', Number(event.target.value.replace(/\D/g, '').slice(0, 7) || 0))}
            />
          </div>
        </div>

        <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span>
            Prescription only
            <span className="block text-xs text-muted-foreground">A sale must record the patient and prescriber.</span>
          </span>
          <Switch checked={draft.requiresPrescription} onCheckedChange={(value) => set('requiresPrescription', value)} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
          <span>
            For sale
            <span className="block text-xs text-muted-foreground">Turn off to stop selling without removing it.</span>
          </span>
          <Switch checked={draft.isActive} onCheckedChange={(value) => set('isActive', value)} />
        </label>
        <p className="text-xs text-muted-foreground">Prices are in {currency}.</p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {medicine ? 'Save changes' : 'Add medicine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
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

function ReceiveStockDialog({
  medicine,
  currency,
  onClose,
  onSaved,
}: {
  medicine: Medicine;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [batchNumber, setBatchNumber] = React.useState('');
  const [expiryDate, setExpiryDate] = React.useState('');
  const [quantity, setQuantity] = React.useState('');
  const [cost, setCost] = React.useState<number | null>(null);
  const [supplier, setSupplier] = React.useState('');

  const receive = useMutation({
    mutationFn: () =>
      pharmacyApi.receiveBatch(medicine._id, {
        batchNumber: batchNumber.trim(),
        expiryDate,
        quantity: Number(quantity),
        costPriceMinor: cost ?? 0,
        supplierName: supplier.trim(),
      }),
    onSuccess: (batch) => {
      toast.success(`Received into batch ${batch.batchNumber}`, { description: `${batch.quantityOnHand} now on hand in that batch.` });
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not receive the stock')),
  });

  const valid = /^[A-Za-z0-9._/-]{1,40}$/.test(batchNumber.trim()) && expiryDate >= todayInputValue() && Number(quantity) > 0 && cost !== null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Receive stock</DialogTitle>
          <DialogDescription>
            {medicine.name} {medicine.strength} into this branch. Receiving the same batch again adds to it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="batch-number" label="Batch number" value={batchNumber} max={40} onChange={setBatchNumber} placeholder="NP2409A" />
          <div className="space-y-1.5">
            <Label htmlFor="batch-expiry">Expiry date</Label>
            <Input id="batch-expiry" type="date" min={todayInputValue()} value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="batch-qty">Quantity (units)</Label>
            <Input id="batch-qty" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value.replace(/\D/g, '').slice(0, 7))} />
          </div>
          <div className="space-y-1.5">
            <Label>Cost per unit</Label>
            <MoneyInput value={cost} onChange={setCost} ariaLabel="Cost per unit" />
          </div>
          <div className="sm:col-span-2">
            <Field id="batch-supplier" label="Supplier" value={supplier} max={120} onChange={setSupplier} placeholder="Optional" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Amounts are in {currency}. Expired batches cannot be received.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={receive.isPending} onClick={() => receive.mutate()}>
            Receive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchesDialog({ medicine, currency, onClose }: { medicine: Medicine | null; currency: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['pharmacy', 'medicine', medicine?._id],
    queryFn: () => pharmacyApi.medicine(medicine!._id),
    enabled: Boolean(medicine),
  });
  const batches = (data?.batches ?? []).filter((batch) => batch.quantityOnHand > 0);

  return (
    <Dialog open={Boolean(medicine)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {medicine?.name} {medicine?.strength}
          </DialogTitle>
          <DialogDescription>Batches in this branch, sold earliest expiry first.</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <LoadingState label="Loading batches…" />
        ) : batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No stock in this branch.</p>
        ) : (
          <ul className="divide-y text-sm">
            {batches.map((batch) => {
              const tone = expiryTone(batch.expiryDate);
              return (
                <li key={batch._id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <p className="font-mono">{batch.batchNumber}</p>
                    <p className="text-xs text-muted-foreground">
                      exp {formatExpiry(batch.expiryDate)} · cost {formatMoney(batch.costPriceMinor, currency)}
                      {batch.supplierName ? ` · ${batch.supplierName}` : ''}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="tabular font-medium">{batch.quantityOnHand}</p>
                    <Badge variant={tone.variant}>{tone.label}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
