import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Pencil } from 'lucide-react';
import { supplierApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PermissionGate } from '@/components/PermissionGate';
import { PAYMENT_TERM_LABELS, SUPPLIER_TYPE_LABELS } from './supplierLabels';
import type { Supplier } from '@/types/domain';

/** Everything saved about one supplier. Banking only appears when the server sends it. */
export function SupplierDetailDialog({
  supplierId,
  onOpenChange,
  onEdit,
}: {
  supplierId: string | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (id: string) => void;
}) {
  const { data: supplier, isLoading } = useQuery({
    queryKey: ['suppliers', 'detail', supplierId],
    queryFn: () => supplierApi.get(supplierId as string),
    enabled: Boolean(supplierId),
  });

  return (
    <Dialog open={Boolean(supplierId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {supplier?.name ?? 'Supplier'}
            {supplier && <Badge variant={supplier.isActive ? 'success' : 'secondary'}>{supplier.isActive ? 'Active' : 'Inactive'}</Badge>}
          </DialogTitle>
          <DialogDescription>{supplier ? `${supplier.code} · ${SUPPLIER_TYPE_LABELS[supplier.type] ?? supplier.type}` : ''}</DialogDescription>
        </DialogHeader>

        {isLoading || !supplier ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-5 text-sm">
            <Section title="Contact person">
              <Row label="Name" value={supplier.contact?.name} />
              <Row label="Designation" value={supplier.contact?.designation} />
              <Row label="Phone" value={supplier.contact?.phone} />
              <Row label="Alternative phone" value={supplier.contact?.altPhone} />
              <Row label="Email" value={supplier.contact?.email} />
            </Section>

            <Section title="Business contact">
              <Row label="Phone" value={supplier.phone} />
              <Row label="Email" value={supplier.email} />
              <Row label="Website" value={supplier.website} />
            </Section>

            <Section title="Address">
              <Row label="Address" value={[supplier.address?.line1, supplier.address?.line2].filter(Boolean).join(', ')} />
              <Row label="Area" value={supplier.address?.area} />
              <Row label="City" value={supplier.address?.city} />
              <Row label="District" value={supplier.address?.district} />
              <Row label="Division" value={supplier.address?.division} />
              <Row label="Postal code" value={supplier.address?.postalCode} />
              <Row label="Country" value={supplier.address?.country} />
            </Section>

            <Section title="Business and tax">
              <Row label="Tax / VAT number" value={supplier.taxNumber} />
              <Row label="Trade licence" value={supplier.tradeLicense} />
              <Row
                label="Payment terms"
                value={[PAYMENT_TERM_LABELS[supplier.paymentTerms] ?? supplier.paymentTerms, supplier.paymentTermsNote].filter(Boolean).join(' — ')}
              />
            </Section>

            {supplier.banking && (
              <Section title="Banking">
                <Row label="Account name" value={supplier.banking.accountName} />
                <Row label="Account number" value={supplier.banking.accountNumber} />
                <Row label="Bank" value={supplier.banking.bankName} />
                <Row label="Branch" value={supplier.banking.branchName} />
              </Section>
            )}

            {supplier.notes && (
              <Section title="Notes">
                <p className="col-span-2 whitespace-pre-wrap text-muted-foreground">{supplier.notes}</p>
              </Section>
            )}

            <Section title="Record">
              <Row label="Added" value={format(new Date(supplier.createdAt), 'dd MMM yyyy, HH:mm')} />
              <Row label="Updated" value={format(new Date(supplier.updatedAt), 'dd MMM yyyy, HH:mm')} />
            </Section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {supplier && (
            <PermissionGate anyOf={['suppliers.edit']}>
              <Button onClick={() => onEdit(supplier._id)}>
                <Pencil />
                Edit
              </Button>
            </PermissionGate>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value?.trim() ? value : '—'}</dd>
    </>
  );
}

export type { Supplier };
