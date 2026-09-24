import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { supplierApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import { PAYMENT_TERM_LABELS, SUPPLIER_TYPE_LABELS } from './supplierLabels';
import { PAYMENT_TERMS, SUPPLIER_TYPES } from '@/types/domain';

/**
 * Add or edit a supplier.
 *
 * Only the name is required - a merchant must be able to save "ABC Garments,
 * details to follow". The server validates everything again and is the one that
 * assigns the supplier code.
 */

const optional = (max: number) => z.string().trim().max(max).optional();
const phone = z
  .string()
  .trim()
  .max(32)
  .refine((value) => !value || /^[+()\d][\d\s\-().]{3,}$/.test(value), 'Enter a valid phone number')
  .optional();
const email = z
  .string()
  .trim()
  .max(200)
  .refine((value) => !value || z.string().email().safeParse(value).success, 'Enter a valid email address')
  .optional();

const schema = z.object({
  name: z.string().trim().min(1, 'Supplier name is required').max(160),
  type: z.enum(SUPPLIER_TYPES),
  isActive: z.enum(['active', 'inactive']),
  contactName: optional(160),
  contactDesignation: optional(120),
  contactPhone: phone,
  contactAltPhone: phone,
  contactEmail: email,
  phone,
  email,
  website: z
    .string()
    .trim()
    .max(300)
    .refine((value) => !value || /^([a-z][a-z0-9+.-]*:\/\/)?[^\s./]+\.[^\s]{2,}$/i.test(value), 'Enter a valid website address')
    .optional(),
  line1: optional(200),
  line2: optional(200),
  area: optional(120),
  city: optional(120),
  district: optional(120),
  division: optional(120),
  postalCode: z
    .string()
    .trim()
    .max(16)
    .refine((value) => !value || /^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$/.test(value), 'Enter a valid postal code')
    .optional(),
  country: optional(80),
  taxNumber: optional(64),
  tradeLicense: optional(64),
  accountName: optional(160),
  accountNumber: z
    .string()
    .trim()
    .max(64)
    .refine((value) => !value || /^[A-Za-z0-9 -]{4,64}$/.test(value), 'Enter a valid account number')
    .optional(),
  bankName: optional(160),
  branchName: optional(160),
  paymentTerms: z.enum(PAYMENT_TERMS),
  paymentTermsNote: optional(120),
  notes: z.string().trim().max(2000).optional(),
});

type FormValues = z.infer<typeof schema>;

const EMPTY: FormValues = {
  name: '',
  type: 'other',
  isActive: 'active',
  contactName: '',
  contactDesignation: '',
  contactPhone: '',
  contactAltPhone: '',
  contactEmail: '',
  phone: '',
  email: '',
  website: '',
  line1: '',
  line2: '',
  area: '',
  city: '',
  district: '',
  division: '',
  postalCode: '',
  country: '',
  taxNumber: '',
  tradeLicense: '',
  accountName: '',
  accountNumber: '',
  bankName: '',
  branchName: '',
  paymentTerms: 'cash',
  paymentTermsNote: '',
  notes: '',
};

const toPayload = (values: FormValues) => ({
  name: values.name,
  type: values.type,
  isActive: values.isActive === 'active',
  contact: {
    name: values.contactName ?? '',
    designation: values.contactDesignation ?? '',
    phone: values.contactPhone ?? '',
    altPhone: values.contactAltPhone ?? '',
    email: values.contactEmail ?? '',
  },
  phone: values.phone ?? '',
  email: values.email ?? '',
  website: values.website ?? '',
  address: {
    line1: values.line1 ?? '',
    line2: values.line2 ?? '',
    area: values.area ?? '',
    city: values.city ?? '',
    district: values.district ?? '',
    division: values.division ?? '',
    postalCode: values.postalCode ?? '',
    country: values.country ?? '',
  },
  taxNumber: values.taxNumber ?? '',
  tradeLicense: values.tradeLicense ?? '',
  banking: {
    accountName: values.accountName ?? '',
    accountNumber: values.accountNumber ?? '',
    bankName: values.bankName ?? '',
    branchName: values.branchName ?? '',
  },
  paymentTerms: values.paymentTerms,
  paymentTermsNote: values.paymentTermsNote ?? '',
  notes: values.notes ?? '',
});

interface SupplierFormDialogProps {
  open: boolean;
  supplierId: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function SupplierFormDialog({ open, supplierId, onOpenChange, onSaved }: SupplierFormDialogProps) {
  const { can, isAdmin } = useAuth();
  const canSeeBanking = isAdmin || can('suppliers.edit');

  const { data: supplier, isLoading } = useQuery({
    queryKey: ['suppliers', 'detail', supplierId],
    queryFn: () => supplierApi.get(supplierId as string),
    enabled: open && Boolean(supplierId),
  });

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: EMPTY });

  React.useEffect(() => {
    if (!open) return;
    if (!supplierId) {
      form.reset(EMPTY);
      return;
    }
    if (!supplier) return;
    form.reset({
      name: supplier.name,
      type: supplier.type,
      isActive: supplier.isActive ? 'active' : 'inactive',
      contactName: supplier.contact?.name ?? '',
      contactDesignation: supplier.contact?.designation ?? '',
      contactPhone: supplier.contact?.phone ?? '',
      contactAltPhone: supplier.contact?.altPhone ?? '',
      contactEmail: supplier.contact?.email ?? '',
      phone: supplier.phone ?? '',
      email: supplier.email ?? '',
      website: supplier.website ?? '',
      line1: supplier.address?.line1 ?? '',
      line2: supplier.address?.line2 ?? '',
      area: supplier.address?.area ?? '',
      city: supplier.address?.city ?? '',
      district: supplier.address?.district ?? '',
      division: supplier.address?.division ?? '',
      postalCode: supplier.address?.postalCode ?? '',
      country: supplier.address?.country ?? '',
      taxNumber: supplier.taxNumber ?? '',
      tradeLicense: supplier.tradeLicense ?? '',
      accountName: supplier.banking?.accountName ?? '',
      accountNumber: supplier.banking?.accountNumber ?? '',
      bankName: supplier.banking?.bankName ?? '',
      branchName: supplier.banking?.branchName ?? '',
      paymentTerms: supplier.paymentTerms,
      paymentTermsNote: supplier.paymentTermsNote ?? '',
      notes: supplier.notes ?? '',
    });
  }, [open, supplierId, supplier, form]);

  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const payload = toPayload(values);
      // Banking is left untouched by anyone who is not shown it.
      if (!canSeeBanking) delete (payload as { banking?: unknown }).banking;
      return supplierId ? supplierApi.update(supplierId, payload) : supplierApi.create(payload);
    },
    onSuccess: (supplier) => {
      toast.success(supplierId ? 'Supplier updated' : 'Supplier added', { description: `${supplier.code} · ${supplier.name}` });
      onOpenChange(false);
      onSaved();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save the supplier'),
  });

  const error = (field: keyof FormValues) => form.formState.errors[field]?.message;
  const field = (id: string, label: string, name: keyof FormValues, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} {...form.register(name)} />
      {error(name) && <p className="text-xs text-destructive">{error(name)}</p>}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{supplierId ? 'Edit supplier' : 'Add supplier'}</DialogTitle>
          <DialogDescription>
            Only the name is required — save what you know now and fill in the rest later. The supplier code is assigned automatically.
          </DialogDescription>
        </DialogHeader>

        {supplierId && isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <form onSubmit={form.handleSubmit((values) => save.mutate(values))} className="space-y-5" noValidate>
            <section className="space-y-3">
              <h3 className="text-sm font-medium">Basic information</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('s-name', 'Supplier / company name', 'name', { autoFocus: true })}
                <div className="space-y-1.5">
                  <Label htmlFor="s-type">Type</Label>
                  <Select value={form.watch('type')} onValueChange={(value) => form.setValue('type', value as FormValues['type'])}>
                    <SelectTrigger id="s-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="s-status">Status</Label>
                  <Select value={form.watch('isActive')} onValueChange={(value) => form.setValue('isActive', value as FormValues['isActive'])}>
                    <SelectTrigger id="s-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="inactive">Inactive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Contact person</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('s-contact-name', 'Name', 'contactName')}
                {field('s-contact-designation', 'Designation', 'contactDesignation', { placeholder: 'Sales representative' })}
                {field('s-contact-phone', 'Phone', 'contactPhone')}
                {field('s-contact-alt', 'Alternative phone', 'contactAltPhone')}
                {field('s-contact-email', 'Email', 'contactEmail', { type: 'email' })}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Business contact</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('s-phone', 'Business phone', 'phone')}
                {field('s-email', 'Business email', 'email', { type: 'email' })}
                {field('s-website', 'Website', 'website', { placeholder: 'example.com' })}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Address</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('s-line1', 'Address line 1', 'line1', { placeholder: 'House 12, Road 5' })}
                {field('s-line2', 'Address line 2', 'line2')}
                {field('s-area', 'Area', 'area', { placeholder: 'New Market' })}
                {field('s-city', 'City', 'city', { placeholder: 'Dhaka' })}
                {field('s-district', 'District', 'district')}
                {field('s-division', 'Division', 'division')}
                {field('s-postal', 'Postal code', 'postalCode', { placeholder: '1205' })}
                {field('s-country', 'Country', 'country', { placeholder: 'Bangladesh' })}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Business and tax</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                {field('s-tax', 'Tax / VAT registration number', 'taxNumber')}
                {field('s-license', 'Trade licence number', 'tradeLicense')}
              </div>
            </section>

            {canSeeBanking && (
              <section className="space-y-3">
                <h3 className="text-sm font-medium">
                  Banking <span className="font-normal text-muted-foreground">— only staff who may edit suppliers can see this</span>
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  {field('s-acc-name', 'Account name', 'accountName')}
                  {field('s-acc-number', 'Account number', 'accountNumber')}
                  {field('s-bank', 'Bank name', 'bankName')}
                  {field('s-branch', 'Branch', 'branchName')}
                </div>
              </section>
            )}

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Payment terms</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="s-terms">Terms</Label>
                  <Select value={form.watch('paymentTerms')} onValueChange={(value) => form.setValue('paymentTerms', value as FormValues['paymentTerms'])}>
                    <SelectTrigger id="s-terms">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(PAYMENT_TERM_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {field('s-terms-note', 'Note', 'paymentTermsNote', { placeholder: 'Half on order, half on delivery' })}
              </div>
              <p className="text-xs text-muted-foreground">Informational for now — nothing is calculated from it.</p>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-medium">Notes</h3>
              <Textarea rows={3} placeholder="Usually supplies premium denim. Contact before placing large orders." {...form.register('notes')} />
            </section>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending}>
                {supplierId ? 'Save changes' : 'Add supplier'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
