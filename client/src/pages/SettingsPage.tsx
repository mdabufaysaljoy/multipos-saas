import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/FieldError';
import { useValidatedForm } from '@/hooks/useValidatedForm';
import { optionalEmailField, optionalPhoneField, requiredText, wholeNumberField } from '@/lib/validation';
import { z } from 'zod';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ImageUpload } from '@/components/ImageUpload';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ThermalReceipt } from '@/features/receipt/ThermalReceipt';
import { LoyaltySettingsCard } from '@/features/loyalty/LoyaltySettingsCard';
import { isLoyaltyVertical } from '@/features/loyalty/useLoyaltyAccess';
import { LabelSettingsCard } from '@/features/barcode/LabelSettingsCard';
import { TenderSettingsCard } from '@/features/payments/TenderSettingsCard';
import { PrinterSettingsCard } from '@/features/printing/PrinterSettingsCard';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { authApi, storeApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import { DEFAULT_LABEL_SETTINGS, type ReceiptPayload, type StoreSettings } from '@/types/domain';
import { SUPPORTED_WIDTHS } from '@/features/receipt/ThermalReceipt';

/** The POS types whose goods carry a barcode, and so can have labels printed. */
const LABEL_VERTICALS = ['clothing', 'supershop', 'pharmacy'];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { can, refresh, session } = useAuth();
  const readOnly = !can('settings.edit');
  const [searchParams] = useSearchParams();

  const { data: store, isLoading } = useQuery({ queryKey: ['store', 'current'], queryFn: storeApi.current });
  const [draft, setDraft] = React.useState<StoreSettings | null>(null);

  // Settings previously saved unconditionally - there was no validation on this
  // screen at all, so a blank store name or a nonsense phone number reached the
  // API and only failed there.
  const settingsSchema = React.useMemo(
    () =>
      z.object({
        name: requiredText('Store name', 120),
        phone: optionalPhoneField,
        email: optionalEmailField,
        currency: z.string().trim().length(3, 'Use a 3-letter currency code'),
        lowStockThreshold: wholeNumberField({ min: 0, max: 100000, label: 'Low-stock threshold' }),
      }),
    [],
  );
  const validation = useValidatedForm(settingsSchema, {
    name: draft?.name ?? '',
    phone: draft?.phone ?? '',
    email: draft?.email ?? '',
    currency: draft?.currency ?? '',
    lowStockThreshold: draft?.lowStockThreshold ?? 0,
  });

  React.useEffect(() => {
    if (store) setDraft(structuredClone(store));
  }, [store]);

  const save = useMutation({
    mutationFn: () =>
      storeApi.updateCurrent({
        name: draft!.name,
        phone: draft!.phone,
        email: draft!.email,
        address: draft!.address,
        currency: draft!.currency,
        // These were previously omitted, so an uploaded logo lived only in
        // React state and vanished on reload. That was the root cause.
        logoUrl: draft!.logoUrl,
        receiptLogoUrl: draft!.receiptLogoUrl,
        invoicePrefix: draft!.invoicePrefix,
        returnPrefix: draft!.returnPrefix,
        lowStockThreshold: draft!.lowStockThreshold,
        paymentMethods: draft!.paymentMethods,
        receipt: draft!.receipt,
        tax: draft!.tax,
        labels: { ...DEFAULT_LABEL_SETTINGS, ...(draft!.labels ?? {}) },
      }),
    onSuccess: () => {
      toast.success('Settings saved');
      void queryClient.invalidateQueries({ queryKey: ['store'] });
      void refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save settings'),
  });

  if (isLoading || !draft) return <LoadingState label="Loading settings…" />;

  const patch = (values: Partial<StoreSettings>) => setDraft({ ...draft, ...values });

  // A synthetic sale so the receipt preview shows real layout, not lorem ipsum.
  const previewPayload: ReceiptPayload = {
    store: draft,
    sale: {
      _id: 'preview',
      saleNumber: `${draft.invoicePrefix}000123`,
      cashierId: '',
      cashierNameSnapshot: 'Sabbir Ahmed',
      customerId: null,
      customerSnapshot: { name: 'Rahim Uddin', phone: '01711000001', email: '' },
      items: [
        {
          _id: '1',
          productId: '',
          variantId: '',
          productNameSnapshot: 'Classic Cotton T-Shirt',
          variantNameSnapshot: 'Black / M',
          skuSnapshot: 'URBCLA-BLK-M',
          brandSnapshot: 'Urban Thread',
          categoryId: null,
          categoryNameSnapshot: 'T-Shirts',
          unitPriceMinor: 79000,
          listPriceMinor: 79000,
          costPriceMinorSnapshot: 42000,
          quantity: 2,
          lineDiscountMinor: 0,
          lineTotalMinor: 158000,
          returnedQuantity: 0,
        },
        {
          _id: '2',
          productId: '',
          variantId: '',
          productNameSnapshot: 'Straight Fit Denim Jeans',
          variantNameSnapshot: 'Indigo / 32',
          skuSnapshot: 'IROSTR-IND-32',
          brandSnapshot: 'Ironworks',
          categoryId: null,
          categoryNameSnapshot: 'Jeans',
          unitPriceMinor: 249000,
          listPriceMinor: 249000,
          costPriceMinorSnapshot: 148000,
          quantity: 1,
          lineDiscountMinor: 0,
          lineTotalMinor: 249000,
          returnedQuantity: 0,
        },
      ],
      subtotalMinor: 407000,
      discountMinor: 7000,
      discountType: 'fixed',
      discountValue: 7000,
      taxMinor: draft.tax.enabled && !draft.tax.inclusive ? Math.round((400000 * draft.tax.rateBasisPoints) / 10000) : 0,
      totalMinor: 400000 + (draft.tax.enabled && !draft.tax.inclusive ? Math.round((400000 * draft.tax.rateBasisPoints) / 10000) : 0),
      paidMinor: 500000,
      changeMinor: 100000,
      paymentMethod: 'cash',
      // Two tenders so the preview shows how a split payment prints.
      payments: [
        { method: 'cash', amountMinor: 300000, reference: '' },
        { method: 'bkash', amountMinor: 100000, reference: '' },
      ],
      paymentStatus: 'paid',
      status: 'completed',
      note: '',
      returnedTotalMinor: 0,
      fullyReturned: false,
      soldAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  };

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Settings"
        description="Store details, receipt layout and tax configuration."
        actions={
          <PermissionGate anyOf={['settings.edit']}>
            <Button
              onClick={() => (validation.valid ? save.mutate() : validation.touchAll())}
              loading={save.isPending}
            >
              <Save />
              Save changes
            </Button>
          </PermissionGate>
        }
      />
      <Tabs defaultValue={['loyalty', 'printer'].includes(searchParams.get('tab') ?? '') ? searchParams.get('tab')! : 'store'}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="store">Store</TabsTrigger>
          <TabsTrigger value="receipt">Receipt</TabsTrigger>
          <TabsTrigger value="tax">Tax &amp; payments</TabsTrigger>
          {/* Labels: wherever the goods carry a barcode. Printing itself is shared by every POS. */}
          {LABEL_VERTICALS.includes(session?.tenant?.vertical ?? 'clothing') && <TabsTrigger value="labels">Labels</TabsTrigger>}
          <TabsTrigger value="printer">Printer</TabsTrigger>
          {isLoyaltyVertical(session?.tenant?.vertical) && <TabsTrigger value="loyalty">Loyalty</TabsTrigger>}
          <TabsTrigger value="account">My account</TabsTrigger>
        </TabsList>

        <TabsContent value="store">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Store details</CardTitle>
              <CardDescription>These appear on every printed receipt.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Store name"
                value={draft.name}
                disabled={readOnly}
                error={validation.errorFor('name')}
                onBlur={() => validation.touch('name')}
                onChange={(v) => patch({ name: v })}
              />
              <Field
                label="Phone"
                value={draft.phone}
                disabled={readOnly}
                inputMode="tel"
                error={validation.errorFor('phone')}
                onBlur={() => validation.touch('phone')}
                onChange={(v) => patch({ phone: v })}
              />
              <Field
                label="Email"
                value={draft.email}
                disabled={readOnly}
                inputMode="email"
                error={validation.errorFor('email')}
                onBlur={() => validation.touch('email')}
                onChange={(v) => patch({ email: v })}
              />
              <Field
                label="Currency"
                value={draft.currency}
                disabled={readOnly}
                error={validation.errorFor('currency')}
                onBlur={() => validation.touch('currency')}
                onChange={(v) => patch({ currency: v.toUpperCase().slice(0, 3) })}
              />
              <div className="space-y-1.5 sm:col-span-2">
                <Label>Address</Label>
                <Textarea
                  rows={2}
                  disabled={readOnly}
                  value={draft.address}
                  onChange={(e) => patch({ address: e.target.value })}
                />
              </div>
              <Field
                label="Invoice prefix"
                value={draft.invoicePrefix}
                disabled={readOnly}
                onChange={(v) => patch({ invoicePrefix: v })}
                hint="Receipts read INV-000001"
              />
              <Field
                label="Return prefix"
                value={draft.returnPrefix}
                disabled={readOnly}
                onChange={(v) => patch({ returnPrefix: v })}
              />
              <div className="rounded-md border p-3 sm:col-span-2">
                <ImageUpload
                  label="Store logo"
                  hint="Optional. Shown in the POS sidebar. This is NOT the receipt logo."
                  value={draft.logoUrl}
                  disabled={readOnly}
                  onChange={(url) => patch({ logoUrl: url })}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Low stock threshold</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={String(draft.lowStockThreshold)}
                  onChange={(e) => {
                    if (!/^\d*$/.test(e.target.value)) return;
                    patch({ lowStockThreshold: e.target.value === '' ? 0 : Number(e.target.value) });
                  }}
                />
                <p className="text-xs text-muted-foreground">Default warning level for new variants</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="receipt">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Receipt layout</CardTitle>
                <CardDescription>Optimised for {draft.receipt.paperWidthMm}mm thermal paper.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Field
                  label="Header text"
                  value={draft.receipt.headerText}
                  disabled={readOnly}
                  onChange={(v) => patch({ receipt: { ...draft.receipt, headerText: v } })}
                  hint="Leave blank to use the store name"
                />
                <div className="space-y-1.5">
                  <Label>Return policy</Label>
                  <Textarea
                    rows={2}
                    disabled={readOnly}
                    value={draft.receipt.returnPolicy}
                    onChange={(e) => patch({ receipt: { ...draft.receipt, returnPolicy: e.target.value } })}
                  />
                </div>
                <Field
                  label="Footer text"
                  value={draft.receipt.footerText}
                  disabled={readOnly}
                  onChange={(v) => patch({ receipt: { ...draft.receipt, footerText: v } })}
                />

                <div className="rounded-md border p-3">
                  <ImageUpload
                    variant="logo"
                    label="Receipt logo"
                    hint="Optional, and separate from the store logo. Printed in black and white for thermal paper."
                    value={draft.receiptLogoUrl}
                    disabled={readOnly}
                    onChange={(url) => patch({ receiptLogoUrl: url })}
                  />
                </div>

                <Toggle
                  label="Show logo on receipts"
                  description={draft.receiptLogoUrl ? 'Prints the logo above the store name' : 'Upload a receipt logo first'}
                  checked={draft.receipt.showLogo && Boolean(draft.receiptLogoUrl)}
                  disabled={readOnly || !draft.receiptLogoUrl}
                  onChange={(checked) => patch({ receipt: { ...draft.receipt, showLogo: checked } })}
                />
                <Toggle
                  label="Show cashier name"
                  description="Helpful for accountability at the till"
                  checked={draft.receipt.showCashier}
                  disabled={readOnly}
                  onChange={(checked) => patch({ receipt: { ...draft.receipt, showCashier: checked } })}
                />

                <div className="space-y-1.5">
                  <Label>Paper width</Label>
                  <div className="flex flex-wrap gap-2">
                    {SUPPORTED_WIDTHS.map((width) => (
                      <Button
                        key={width}
                        type="button"
                        size="sm"
                        disabled={readOnly}
                        variant={draft.receipt.paperWidthMm === width ? 'default' : 'outline'}
                        onClick={() => patch({ receipt: { ...draft.receipt, paperWidthMm: width } })}
                      >
                        {width}mm
                      </Button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="h-fit">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Live preview</CardTitle>
                <CardDescription>Exactly what the printer will produce.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md bg-muted/50 p-3">
                  <ThermalReceipt payload={previewPayload} />
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="tax">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Tax</CardTitle>
                <CardDescription>Applied to the subtotal after any discount.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Toggle
                  label="Charge tax"
                  description="Turn on to add tax to every sale"
                  checked={draft.tax.enabled}
                  disabled={readOnly}
                  onChange={(checked) => patch({ tax: { ...draft.tax, enabled: checked } })}
                />
                <Field
                  label="Tax label"
                  value={draft.tax.label}
                  disabled={readOnly || !draft.tax.enabled}
                  onChange={(v) => patch({ tax: { ...draft.tax, label: v } })}
                />
                <div className="space-y-1.5">
                  <Label htmlFor="tax-rate">Rate (%)</Label>
                  <PercentField
                    id="tax-rate"
                    disabled={readOnly || !draft.tax.enabled}
                    basisPoints={draft.tax.rateBasisPoints}
                    onChange={(rateBasisPoints) => patch({ tax: { ...draft.tax, rateBasisPoints } })}
                  />
                </div>
                <Toggle
                  label="Prices include tax"
                  description="Tax is shown on the receipt but not added again"
                  checked={draft.tax.inclusive}
                  disabled={readOnly || !draft.tax.enabled}
                  onChange={(checked) => patch({ tax: { ...draft.tax, inclusive: checked } })}
                />
              </CardContent>
            </Card>

            <TenderSettingsCard
              enabled={draft.paymentMethods}
              readOnly={readOnly}
              onChange={(paymentMethods) => patch({ paymentMethods })}
            />
          </div>
        </TabsContent>

        <TabsContent value="labels">
          <LabelSettingsCard
            value={{ ...DEFAULT_LABEL_SETTINGS, ...(draft.labels ?? {}) }}
            storeName={draft.name}
            currency={draft.currency}
            readOnly={readOnly}
            vatEnabled={draft.tax.enabled}
            showLoyaltyCard={isLoyaltyVertical(session?.tenant?.vertical)}
            onChange={(labels) => patch({ labels })}
          />
        </TabsContent>

        {/* Per computer: saved in this browser, not in the store settings. */}
        <TabsContent value="printer">
          <PrinterSettingsCard />
        </TabsContent>

        <TabsContent value="loyalty">
          <LoyaltySettingsCard value={store?.loyalty} currency={draft.currency} readOnly={readOnly} />
        </TabsContent>

        <TabsContent value="account">
          <ChangePasswordCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * A percentage typed by a person, stored as basis points.
 *
 * The field keeps the TEXT, and only derives the number from it. That is the
 * whole fix: the old input rendered `String(rateBasisPoints / 100)`, so what
 * was on screen was recomputed from an integer on every keystroke and a
 * half-typed "7." could not survive a render. Typing 7.5 went
 * "7" -> "7." -> re-rendered as "7" -> "75", and a shop that wanted 7.5% got
 * 75%. Same for 5.6, and for every other rate with a decimal point.
 *
 * It stays `type="text"` with `inputMode="decimal"` deliberately. `type="number"`
 * would not fix it and would add problems of its own: browsers report an
 * in-progress "7." as an EMPTY value, so the dot is lost the same way, the
 * default `step=1` marks 7.5 invalid, and a scroll wheel over a focused field
 * silently changes a tax rate. `inputMode="decimal"` is what actually brings up
 * a keypad with a decimal point on the tablet a till runs on.
 *
 * The external value is still the source of truth: when it changes to something
 * the text does not already mean (loading, resetting, switching branch), the
 * text follows it.
 */
function PercentField({
  id,
  basisPoints,
  disabled,
  onChange,
}: {
  id: string;
  basisPoints: number;
  disabled?: boolean;
  onChange: (basisPoints: number) => void;
}) {
  const asText = (bps: number) => (bps ? String(bps / 100) : '');
  const [text, setText] = React.useState(() => asText(basisPoints));

  // Follow the stored value only when the two have genuinely diverged, so that
  // "7." - which means 700, exactly as "7" does - is left alone while it is
  // being typed.
  React.useEffect(() => {
    setText((current) => (toBasisPoints(current) === basisPoints ? current : asText(basisPoints)));
  }, [basisPoints]);

  return (
    <Input
      id={id}
      type="text"
      inputMode="decimal"
      disabled={disabled}
      value={text}
      onChange={(event) => {
        const raw = event.target.value;
        // Up to three digits and two decimals. A refused keystroke changes
        // nothing at all, rather than rewriting what is already there.
        if (raw !== '' && !/^\d{0,3}(\.\d{0,2})?$/.test(raw)) return;
        const bps = toBasisPoints(raw);
        if (bps > 10_000) return;
        setText(raw);
        if (bps !== basisPoints) onChange(bps);
      }}
      placeholder="7.5"
    />
  );
}

/** "7.5" -> 750. Rates are stored in basis points so they stay integers. */
function toBasisPoints(raw: string): number {
  if (raw.trim() === '') return 0;
  const percent = Number(raw);
  return Number.isFinite(percent) ? Math.round(percent * 100) : 0;
}

function Field({
  label,
  value,
  onChange,
  disabled,
  hint,
  error,
  onBlur,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  error?: string;
  onBlur?: () => void;
  inputMode?: 'text' | 'tel' | 'email' | 'numeric';
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldError message={error} />
      {!error && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <div>
        <Label className={className}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function ChangePasswordCard() {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');

  const change = useMutation({
    mutationFn: () => authApi.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success('Password changed', { description: 'Please sign in again.' });
      setCurrent('');
      setNext('');
      setConfirm('');
      // Every session was revoked server-side; reload to land on the login page.
      setTimeout(() => window.location.reload(), 1200);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not change the password'),
  });

  const invalid = current.length < 1 || next.length < 8 || next !== confirm;

  return (
    <Card className="max-w-md">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Change password</CardTitle>
        <CardDescription>Changing your password signs out every device.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="cur-pass">Current password</Label>
          <Input id="cur-pass" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="new-pass2">New password</Label>
          <Input id="new-pass2" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="conf-pass">Confirm new password</Label>
          <Input id="conf-pass" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {confirm && next !== confirm && <p className="text-xs text-destructive">Passwords do not match</p>}
        </div>
        <Button disabled={invalid} loading={change.isPending} onClick={() => change.mutate()}>
          <KeyRound />
          Change password
        </Button>
      </CardContent>
    </Card>
  );
}
