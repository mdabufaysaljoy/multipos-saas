import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { ApiError } from '@/api/client';
import { supershopApi } from '@/api/supershop';
import { formatQuantity, MAX_PIECES, parseKgToGrams } from '@/lib/supershop';
import type { ShopMovement, ShopProduct, ShopUnitType } from '@/types/supershop';

/**
 * Receiving and counting stock, shared by the two screens that do it: the
 * catalogue (Products & stock) and the Inventory screen. One copy, so a rule
 * about how stock moves cannot drift between them.
 */

export const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export const MOVEMENT_LABELS: Record<ShopMovement['type'], string> = {
  receive: 'Received',
  sale: 'Sold',
  void: 'Sale voided',
  adjust: 'Count corrected',
  write_off: 'Written off',
};

/** Parses a quantity for a unit type: whole pieces, or kilograms to grams. */
export const parseQuantity = (raw: string, unitType: ShopUnitType): number | null => {
  if (unitType === 'weight') return parseKgToGrams(raw);
  const pieces = Number(raw.trim());
  return /^\d{1,7}$/.test(raw.trim()) && pieces > 0 && pieces <= MAX_PIECES ? pieces : null;
};

export function TextField({
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

export function ReceiveDialog({ product, currency, onClose, onSaved }: { product: ShopProduct; currency: string; onClose: () => void; onSaved: () => void }) {
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

export function AdjustDialog({ product, onClose, onSaved }: { product: ShopProduct; onClose: () => void; onSaved: () => void }) {
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
