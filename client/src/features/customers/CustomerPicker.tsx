import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, UserPlus, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { customerApi } from '@/api/endpoints';
import type { Customer } from '@/types/domain';

export interface SelectedCustomer {
  id?: string;
  name: string;
  phone: string;
  email?: string;
}

/** How a sale endpoint is told who the sale is for, in every vertical. */
export interface SaleCustomerFields {
  customerId?: string;
  customer?: { name: string; phone: string; email?: string };
}

/**
 * Turns the picked customer into the fields a sale endpoint expects: an id when
 * they are already on file, otherwise the details for the server to find by
 * phone or create. Nothing at all for a walk-in.
 */
export function saleCustomerFields(customer: SelectedCustomer | null): SaleCustomerFields {
  if (!customer) return {};
  if (customer.id) return { customerId: customer.id };
  return { customer: { name: customer.name, phone: customer.phone, email: customer.email || undefined } };
}

interface CustomerPickerProps {
  value: SelectedCustomer | null;
  onChange: (customer: SelectedCustomer | null) => void;
  canCreate: boolean;
}

/**
 * Attach a customer to a sale, in any POS vertical.
 *
 * Entirely optional - a walk-in sale needs no customer at all, and nothing here
 * can block checkout. A customer typed in here is not created straight away:
 * the details travel with the sale, and the server finds them by phone or
 * creates them in the same step that records the sale.
 */
export function CustomerPicker({ value, onChange, canCreate }: CustomerPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState('');
  const debounced = useDebounced(term, 250);
  const [draft, setDraft] = React.useState({ name: '', phone: '', email: '' });
  const [mode, setMode] = React.useState<'search' | 'create'>('search');

  const { data } = useQuery({
    queryKey: ['customers', 'picker', debounced],
    queryFn: () => customerApi.list({ search: debounced, limit: 8 }),
    enabled: open && mode === 'search',
  });

  const pick = (customer: Customer) => {
    onChange({ id: customer._id, name: customer.name, phone: customer.phone, email: customer.email });
    setOpen(false);
    setTerm('');
  };

  const createInline = () => {
    if (draft.name.trim().length < 1 || draft.phone.trim().length < 3) return;
    // Passed to the sale endpoint, which finds-or-creates in one step.
    onChange({ name: draft.name.trim(), phone: draft.phone.trim(), email: draft.email.trim() });
    setOpen(false);
    setDraft({ name: '', phone: '', email: '' });
    setMode('search');
  };

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
        <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{value.name}</p>
          <p className="truncate text-xs text-muted-foreground">{value.phone}</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => onChange(null)} aria-label="Remove customer">
          <X />
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button variant="outline" className="w-full justify-start" onClick={() => setOpen(true)}>
        <UserRound />
        Add customer <span className="ml-1 text-muted-foreground">(optional)</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === 'search' ? 'Find a customer' : 'New customer'}</DialogTitle>
            <DialogDescription>
              Customer details are optional. You can complete the sale without them.
            </DialogDescription>
          </DialogHeader>

          {mode === 'search' ? (
            <div className="space-y-3">
              <SearchInput value={term} onChange={setTerm} placeholder="Search by name or phone…" autoFocus />

              <div className="scrollbar-thin max-h-64 space-y-1 overflow-y-auto">
                {(data?.items ?? []).map((customer) => (
                  <button
                    key={customer._id}
                    type="button"
                    onClick={() => pick(customer)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{customer.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {customer.phone} · {customer.orderCount} order{customer.orderCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Check className="h-4 w-4 opacity-0" />
                  </button>
                ))}
                {(data?.items.length ?? 0) === 0 && (
                  <p className="px-3 py-6 text-center text-sm text-muted-foreground">No customers found</p>
                )}
              </div>

              {canCreate && (
                <Button variant="outline" className="w-full" onClick={() => setMode('create')}>
                  <UserPlus />
                  Add a new customer
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cust-name">Name</Label>
                <Input
                  id="cust-name"
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cust-phone">Phone</Label>
                <Input
                  id="cust-phone"
                  value={draft.phone}
                  onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cust-email">Email (optional)</Label>
                <Input
                  id="cust-email"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                />
              </div>
            </div>
          )}

          <DialogFooter>
            {mode === 'create' ? (
              <>
                <Button variant="outline" onClick={() => setMode('search')}>
                  Back
                </Button>
                <Button onClick={createInline} disabled={!draft.name.trim() || draft.phone.trim().length < 3}>
                  Use this customer
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
