import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Armchair, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { restaurantApi } from '@/api/restaurant';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { DiningTable } from '@/types/restaurant';

/** The tables in the current branch, with what is open on each. */
export function TablesPage() {
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<DiningTable | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<DiningTable | null>(null);

  const { data: tables, isLoading } = useQuery({ queryKey: ['restaurant', 'tables'], queryFn: restaurantApi.tables });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['restaurant'] });

  const remove = useMutation({
    mutationFn: (id: string) => restaurantApi.removeTable(id),
    onSuccess: () => {
      toast.success('Table removed');
      setDeleting(null);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the table'),
  });

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <PageHeader
        title="Tables"
        description={`The floor plan for ${activeStore?.name ?? 'this branch'}.`}
        actions={
          <PermissionGate anyOf={['settings.edit']}>
            <Button onClick={() => setCreating(true)}>
              <Plus />
              Add table
            </Button>
          </PermissionGate>
        }
      />

      {isLoading && <LoadingState label="Loading tables…" />}
      {!isLoading && (tables?.length ?? 0) === 0 && (
        <EmptyState icon={<Armchair className="h-6 w-6" />} title="No tables yet" description="Add tables to take dine-in orders." />
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {(tables ?? []).map((table) => (
          <Card key={table._id} className={table.openOrderId ? 'border-warning/50 bg-warning/5' : undefined}>
            <CardContent className="space-y-2 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-lg font-semibold">{table.name}</p>
                  <p className="text-xs text-muted-foreground">{table.seats} seats</p>
                </div>
                {!table.isActive ? (
                  <Badge variant="secondary">Off</Badge>
                ) : table.openOrderId ? (
                  <Badge variant="warning">Occupied</Badge>
                ) : (
                  <Badge variant="success">Free</Badge>
                )}
              </div>
              {table.openOrderId && (
                <p className="text-xs">
                  <span className="font-mono">{table.openOrderNumber}</span> ·{' '}
                  <span className="tabular font-medium">{formatMoney(table.openOrderTotalMinor ?? 0, currency)}</span>
                </p>
              )}
              <PermissionGate anyOf={['settings.edit']}>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => setEditing(table)} aria-label={`Edit ${table.name}`}>
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={Boolean(table.openOrderId)}
                    onClick={() => setDeleting(table)}
                    aria-label={`Remove ${table.name}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </PermissionGate>
            </CardContent>
          </Card>
        ))}
      </div>

      <TableDialog
        open={creating || Boolean(editing)}
        table={editing}
        onOpenChange={(open) => {
          if (!open) {
            setCreating(false);
            setEditing(null);
          }
        }}
        onSaved={refresh}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name ?? 'table'}?`}
        description="Past orders on this table are kept."
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

function TableDialog({
  open,
  table,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  table: DiningTable | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState('');
  const [seats, setSeats] = React.useState('4');

  React.useEffect(() => {
    if (open) {
      setName(table?.name ?? '');
      setSeats(String(table?.seats ?? 4));
    }
  }, [open, table]);

  const seatCount = Number(seats);
  const valid = name.trim().length > 0 && Number.isInteger(seatCount) && seatCount >= 1 && seatCount <= 50;

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), seats: seatCount };
      return table ? restaurantApi.updateTable(table._id, body) : restaurantApi.createTable(body);
    },
    onSuccess: () => {
      toast.success(table ? 'Table updated' : 'Table added');
      onOpenChange(false);
      onSaved();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the table'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{table ? 'Edit table' : 'New table'}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label htmlFor="table-name">Name</Label>
            <Input id="table-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. T1" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="table-seats">Seats</Label>
            <Input id="table-seats" type="number" min={1} max={50} value={seats} onChange={(e) => setSeats(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>
            {table ? 'Save' : 'Add table'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
