import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImagePlus, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { MoneyInput } from '@/components/MoneyInput';
import { QuantityInput } from '@/components/QuantityInput';
import { ApiError } from '@/api/client';
import {
  HARDWARE_CATEGORIES,
  hardwareAdminApi,
  type HardwareCategory,
  type HardwareItem,
  type HardwareItemInput,
  type HardwarePackage,
  type HardwarePackageInput,
  type HardwareStatus,
} from '@/api/hardware';
import { formatPlanPrice } from '@/lib/money';

/**
 * The hardware catalogue behind the public /hardware page: the devices the
 * platform sells and the packages built from them.
 *
 * A package holds references to its devices, never copies of their prices, so
 * correcting a scanner's price here corrects every package that contains it
 * and the two can never disagree on the website. The server validates every
 * field again and audits every change.
 */

const QUERY_KEY = ['platform', 'hardware'];
const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const CATEGORY_LABELS: Record<HardwareCategory, string> = {
  computer: 'Computer',
  scanner: 'Scanner',
  cash_drawer: 'Cash drawer',
  receipt_printer: 'Receipt printer',
  label_printer: 'Label printer',
  printer_combo: 'Receipt + label printer',
  accessory: 'Accessory',
};

/** Bullet lists are edited one per line; blanks are dropped on save. */
const linesToList = (value: string) =>
  value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export function HardwareTab() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: QUERY_KEY, queryFn: hardwareAdminApi.catalogue });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const currency = data?.currency ?? 'BDT';
  const items = data?.items ?? [];
  const packages = data?.packages ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        What the public hardware page offers. Only active rows are published; deactivating a device also removes it from
        the packages that contain it.
      </p>

      <Tabs defaultValue="packages">
        <TabsList className="mb-3">
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
        </TabsList>

        <TabsContent value="packages">
          <PackagesPanel
            packages={packages}
            items={items}
            currency={currency}
            loading={isLoading}
            error={error ? errorMessage(error, 'Could not load the hardware catalogue') : null}
            onRetry={() => void refetch()}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="devices">
          <ItemsPanel
            items={items}
            currency={currency}
            loading={isLoading}
            error={error ? errorMessage(error, 'Could not load the hardware catalogue') : null}
            onRetry={() => void refetch()}
            onChanged={refresh}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// --------------------------------------------------------------- devices ----

function ItemsPanel({
  items,
  currency,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  items: HardwareItem[];
  currency: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState<HardwareItem | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<HardwareItem | null>(null);

  const remove = useMutation({
    mutationFn: (item: HardwareItem) => hardwareAdminApi.deleteItem(item.slug),
    onSuccess: (item) => {
      toast.success(`${item.name} removed`);
      setDeleting(null);
      onChanged();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the device')),
  });

  const columns: Column<HardwareItem>[] = [
    {
      key: 'name',
      header: 'Device',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.slug}</p>
        </div>
      ),
    },
    { key: 'category', header: 'Kind', mobile: 'meta', cell: (row) => CATEGORY_LABELS[row.category] ?? row.category },
    { key: 'price', header: 'Price', cell: (row) => <span className="tabular">{formatPlanPrice(row.priceMinor, currency)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>{row.status === 'active' ? 'Published' : 'Hidden'}</Badge>,
    },
    { key: 'sortOrder', header: 'Order', mobile: 'hide', cell: (row) => <span className="tabular">{row.sortOrder}</span> },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      cell: (row) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            <Pencil />
            Edit
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDeleting(row)}>
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing('new')}>
          <Plus />
          New device
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(row) => row.slug}
        loading={loading}
        error={error}
        onRetry={onRetry}
        emptyTitle="No devices yet"
        emptyDescription="Add the hardware you sell; packages are built from it."
      />

      {editing !== null && (
        <ItemEditorDialog
          key={editing === 'new' ? 'new' : editing.slug}
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Remove ${deleting?.name ?? 'this device'}?`}
        description="It disappears from the website for good. To stop selling it but keep it on record, set its status to hidden instead. A device that is part of a package cannot be removed."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
    </div>
  );
}

interface ItemForm {
  slug: string;
  name: string;
  category: HardwareCategory;
  summary: string;
  specs: string;
  priceMinor: number | null;
  imageUrl: string;
  status: HardwareStatus;
  sortOrder: string;
}

const itemFormFrom = (item: HardwareItem | null): ItemForm => ({
  slug: item?.slug ?? '',
  name: item?.name ?? '',
  category: item?.category ?? 'accessory',
  summary: item?.summary ?? '',
  specs: (item?.specs ?? []).join('\n'),
  priceMinor: item?.priceMinor ?? null,
  imageUrl: item?.imageUrl ?? '',
  status: item?.status ?? 'active',
  sortOrder: String(item?.sortOrder ?? 100),
});

/** The first problem with the form, in words, or null. The server validates again. */
function itemProblem(form: ItemForm, isNew: boolean): string | null {
  if (isNew && !/^[a-z0-9][a-z0-9-]{1,47}$/.test(form.slug)) return 'Slug: 2–48 lowercase letters, digits or hyphens.';
  if (form.name.trim().length < 2) return 'Name: at least 2 characters.';
  if (form.priceMinor === null) return 'Enter a price.';
  if (!/^\d{1,4}$/.test(form.sortOrder) || Number(form.sortOrder) > 1000) return 'Order: a whole number from 0 to 1000.';
  if (linesToList(form.specs).length > 8) return 'At most 8 spec lines.';
  return null;
}

function ItemEditorDialog({ item, onClose, onSaved }: { item: HardwareItem | null; onClose: () => void; onSaved: () => void }) {
  const isNew = item === null;
  const [form, setForm] = React.useState<ItemForm>(() => itemFormFrom(item));
  const set = <K extends keyof ItemForm>(key: K, value: ItemForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const problem = itemProblem(form, isNew);

  const save = useMutation({
    mutationFn: () => {
      const body: HardwareItemInput = {
        name: form.name.trim(),
        category: form.category,
        summary: form.summary.trim(),
        specs: linesToList(form.specs),
        priceMinor: form.priceMinor!,
        imageUrl: form.imageUrl.trim(),
        status: form.status,
        sortOrder: Number(form.sortOrder),
      };
      return isNew ? hardwareAdminApi.createItem({ ...body, slug: form.slug }) : hardwareAdminApi.updateItem(item.slug, body);
    },
    onSuccess: (saved) => {
      toast.success(isNew ? `${saved.name} added` : `${saved.name} saved`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the device')),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New device' : `Edit ${item.name}`}</DialogTitle>
          <DialogDescription>Prices are what visitors see on the hardware page, hardware only.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!problem && !save.isPending) save.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hw-item-name">Name</Label>
              <Input
                id="hw-item-name"
                value={form.name}
                maxLength={80}
                onChange={(event) => {
                  const name = event.target.value;
                  setForm((current) => ({ ...current, name, slug: isNew && !current.slug ? '' : current.slug }));
                }}
                onBlur={() => {
                  if (isNew && !form.slug && form.name.trim()) set('slug', slugify(form.name));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-item-slug">Slug</Label>
              <Input
                id="hw-item-slug"
                className="font-mono"
                value={form.slug}
                disabled={!isNew}
                maxLength={48}
                placeholder="barcode-scanner"
                onChange={(event) => set('slug', event.target.value.toLowerCase())}
              />
              {!isNew && <p className="text-xs text-muted-foreground">A device's slug never changes; packages refer to it.</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Kind</Label>
              <Select value={form.category} onValueChange={(value) => set('category', value as HardwareCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HARDWARE_CATEGORIES.map((category) => (
                    <SelectItem key={category} value={category}>
                      {CATEGORY_LABELS[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Price</Label>
              <MoneyInput value={form.priceMinor} onChange={(value) => set('priceMinor', value)} ariaLabel="Device price" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="hw-item-summary">One-line summary</Label>
              <Input
                id="hw-item-summary"
                value={form.summary}
                maxLength={160}
                placeholder="80mm thermal receipt printer"
                onChange={(event) => set('summary', event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="hw-item-specs">Specs</Label>
              <Textarea
                id="hw-item-specs"
                rows={4}
                value={form.specs}
                placeholder={'One per line\nUSB connectivity\nAuto cutter'}
                onChange={(event) => set('specs', event.target.value)}
              />
              <p className="text-xs text-muted-foreground">One per line, up to 8.</p>
            </div>
            <div className="sm:col-span-2">
              <ImageField value={form.imageUrl} onChange={(url) => set('imageUrl', url)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-item-order">Order</Label>
              <Input
                id="hw-item-order"
                className="tabular"
                value={form.sortOrder}
                inputMode="numeric"
                onChange={(event) => set('sortOrder', event.target.value.replace(/\D/g, ''))}
              />
              <p className="text-xs text-muted-foreground">Lowest first on the website.</p>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="hw-item-status">Published</Label>
                <p className="text-xs text-muted-foreground">Hidden devices leave the website and its packages.</p>
              </div>
              <Switch
                id="hw-item-status"
                checked={form.status === 'active'}
                onCheckedChange={(checked) => set('status', checked ? 'active' : 'inactive')}
              />
            </div>
          </div>

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null} loading={save.isPending}>
              {isNew ? 'Add device' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// -------------------------------------------------------------- packages ----

function PackagesPanel({
  packages,
  items,
  currency,
  loading,
  error,
  onRetry,
  onChanged,
}: {
  packages: HardwarePackage[];
  items: HardwareItem[];
  currency: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = React.useState<HardwarePackage | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<HardwarePackage | null>(null);

  const remove = useMutation({
    mutationFn: (pkg: HardwarePackage) => hardwareAdminApi.deletePackage(pkg.slug),
    onSuccess: (pkg) => {
      toast.success(`${pkg.name} removed`);
      setDeleting(null);
      onChanged();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the package')),
  });

  const columns: Column<HardwarePackage>[] = [
    {
      key: 'name',
      header: 'Package',
      mobile: 'title',
      cell: (row) => (
        <div>
          <p className="font-medium">
            {row.name} {row.featured && <Badge variant="secondary">Popular</Badge>}
          </p>
          <p className="font-mono text-xs text-muted-foreground">{row.slug}</p>
        </div>
      ),
    },
    {
      key: 'contents',
      header: 'Contents',
      mobile: 'meta',
      cell: (row) => (
        <div className="text-sm">
          <span>{row.lines.map((line) => `${line.item.name}${line.quantity > 1 ? ` ×${line.quantity}` : ''}`).join(', ') || '—'}</span>
          {row.missingItems.length > 0 && (
            <p className="text-xs text-destructive">Missing device(s): {row.missingItems.join(', ')}</p>
          )}
        </div>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      cell: (row) => (
        <div className="tabular">
          <p>{formatPlanPrice(row.priceMinor, currency)}</p>
          {row.savingsMinor > 0 && <p className="text-xs text-muted-foreground">saves {formatPlanPrice(row.savingsMinor, currency)}</p>}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.status === 'active' ? 'success' : 'secondary'}>{row.status === 'active' ? 'Published' : 'Hidden'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      mobile: 'actions',
      cell: (row) => (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(row)}>
            <Pencil />
            Edit
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDeleting(row)}>
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing('new')} disabled={items.length === 0}>
          <Plus />
          New package
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={packages}
        rowKey={(row) => row.slug}
        loading={loading}
        error={error}
        onRetry={onRetry}
        emptyTitle="No packages yet"
        emptyDescription="Add the devices first, then bundle them into a counter package."
      />

      {editing !== null && (
        <PackageEditorDialog
          key={editing === 'new' ? 'new' : editing.slug}
          pkg={editing === 'new' ? null : editing}
          items={items}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Remove ${deleting?.name ?? 'this package'}?`}
        description="It disappears from the website for good. To stop offering it but keep it on record, set its status to hidden instead. The devices in it are not affected."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting);
        }}
      />
    </div>
  );
}

interface PackageForm {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  lines: Record<string, number>;
  priceMinor: number | null;
  imageUrl: string;
  highlights: string;
  bestFor: string;
  featured: boolean;
  status: HardwareStatus;
  sortOrder: string;
}

const packageFormFrom = (pkg: HardwarePackage | null): PackageForm => ({
  slug: pkg?.slug ?? '',
  name: pkg?.name ?? '',
  tagline: pkg?.tagline ?? '',
  description: pkg?.description ?? '',
  lines: Object.fromEntries((pkg?.lines ?? []).map((line) => [line.itemSlug, line.quantity])),
  priceMinor: pkg?.priceMinor ?? null,
  imageUrl: pkg?.imageUrl ?? '',
  highlights: (pkg?.highlights ?? []).join('\n'),
  bestFor: (pkg?.bestFor ?? []).join('\n'),
  featured: pkg?.featured ?? false,
  status: pkg?.status ?? 'active',
  sortOrder: String(pkg?.sortOrder ?? 100),
});

function packageProblem(form: PackageForm, isNew: boolean): string | null {
  if (isNew && !/^[a-z0-9][a-z0-9-]{1,47}$/.test(form.slug)) return 'Slug: 2–48 lowercase letters, digits or hyphens.';
  if (form.name.trim().length < 2) return 'Name: at least 2 characters.';
  if (Object.keys(form.lines).length === 0) return 'Choose at least one device.';
  if (Object.keys(form.lines).length > 12) return 'At most 12 devices in a package.';
  if (form.priceMinor === null) return 'Enter a package price.';
  if (!/^\d{1,4}$/.test(form.sortOrder) || Number(form.sortOrder) > 1000) return 'Order: a whole number from 0 to 1000.';
  if (linesToList(form.highlights).length > 6) return 'At most 6 highlights.';
  if (linesToList(form.bestFor).length > 10) return 'At most 10 trades.';
  return null;
}

function PackageEditorDialog({
  pkg,
  items,
  currency,
  onClose,
  onSaved,
}: {
  pkg: HardwarePackage | null;
  items: HardwareItem[];
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = pkg === null;
  const [form, setForm] = React.useState<PackageForm>(() => packageFormFrom(pkg));
  const set = <K extends keyof PackageForm>(key: K, value: PackageForm[K]) => setForm((current) => ({ ...current, [key]: value }));
  const problem = packageProblem(form, isNew);

  const toggleLine = (slug: string, on: boolean) =>
    setForm((current) => {
      const lines = { ...current.lines };
      if (on) lines[slug] = lines[slug] ?? 1;
      else delete lines[slug];
      return { ...current, lines };
    });

  // What the chosen devices cost bought separately — the number the package
  // price is judged against, shown live so a bundle is never priced blind.
  const partsTotalMinor = items.reduce(
    (total, item) => total + (form.lines[item.slug] ? item.priceMinor * form.lines[item.slug] : 0),
    0,
  );

  const save = useMutation({
    mutationFn: () => {
      const body: HardwarePackageInput = {
        name: form.name.trim(),
        tagline: form.tagline.trim(),
        description: form.description.trim(),
        items: Object.entries(form.lines).map(([itemSlug, quantity]) => ({ itemSlug, quantity })),
        priceMinor: form.priceMinor!,
        imageUrl: form.imageUrl.trim(),
        highlights: linesToList(form.highlights),
        bestFor: linesToList(form.bestFor),
        featured: form.featured,
        status: form.status,
        sortOrder: Number(form.sortOrder),
      };
      return isNew ? hardwareAdminApi.createPackage({ ...body, slug: form.slug }) : hardwareAdminApi.updatePackage(pkg.slug, body);
    },
    onSuccess: (saved) => {
      toast.success(isNew ? `${saved.name} created` : `${saved.name} saved`);
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not save the package')),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'New package' : `Edit ${pkg.name}`}</DialogTitle>
          <DialogDescription>A package quotes its own price; the devices in it keep theirs.</DialogDescription>
        </DialogHeader>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!problem && !save.isPending) save.mutate();
          }}
        >
          <section className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="hw-pkg-name">Name</Label>
              <Input
                id="hw-pkg-name"
                value={form.name}
                maxLength={80}
                onChange={(event) => set('name', event.target.value)}
                onBlur={() => {
                  if (isNew && !form.slug && form.name.trim()) set('slug', slugify(form.name));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-pkg-slug">Slug</Label>
              <Input
                id="hw-pkg-slug"
                className="font-mono"
                value={form.slug}
                disabled={!isNew}
                maxLength={48}
                placeholder="complete-retail-counter"
                onChange={(event) => set('slug', event.target.value.toLowerCase())}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="hw-pkg-tagline">Tagline</Label>
              <Input
                id="hw-pkg-tagline"
                value={form.tagline}
                maxLength={120}
                placeholder="Everything a counter needs"
                onChange={(event) => set('tagline', event.target.value)}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="hw-pkg-description">Description</Label>
              <Textarea
                id="hw-pkg-description"
                rows={3}
                maxLength={600}
                value={form.description}
                onChange={(event) => set('description', event.target.value)}
              />
            </div>
          </section>

          <section className="space-y-2">
            <Label>Devices in this package</Label>
            <div className="divide-y rounded-md border">
              {items.map((item) => {
                const quantity = form.lines[item.slug];
                const chosen = quantity !== undefined;
                return (
                  <div key={item.slug} className="flex items-center gap-3 p-3">
                    <Switch
                      checked={chosen}
                      onCheckedChange={(checked) => toggleLine(item.slug, checked)}
                      aria-label={`Include ${item.name}`}
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">
                        {item.name}
                        {item.status !== 'active' && <span className="ms-2 text-xs text-muted-foreground">(hidden)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {CATEGORY_LABELS[item.category]} · {formatPlanPrice(item.priceMinor, currency)}
                      </p>
                    </div>
                    {chosen && (
                      <QuantityInput
                        value={quantity}
                        onChange={(value) =>
                          setForm((current) => ({ ...current, lines: { ...current.lines, [item.slug]: value ?? 1 } }))
                        }
                        min={1}
                        max={99}
                        className="w-20"
                        ariaLabel={`${item.name} quantity`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Bought separately: <span className="tabular">{formatPlanPrice(partsTotalMinor, currency)}</span>
            </p>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Package price</Label>
              <MoneyInput value={form.priceMinor} onChange={(value) => set('priceMinor', value)} ariaLabel="Package price" />
              {form.priceMinor !== null && form.priceMinor > partsTotalMinor && (
                <p className="text-xs text-amber-600">This package costs more than its devices do separately.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-pkg-order">Order</Label>
              <Input
                id="hw-pkg-order"
                className="tabular"
                value={form.sortOrder}
                inputMode="numeric"
                onChange={(event) => set('sortOrder', event.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-pkg-highlights">Highlights</Label>
              <Textarea
                id="hw-pkg-highlights"
                rows={3}
                value={form.highlights}
                placeholder={'One per line\nFast billing\nBarcode support'}
                onChange={(event) => set('highlights', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hw-pkg-bestfor">Suits these trades</Label>
              <Textarea
                id="hw-pkg-bestfor"
                rows={3}
                value={form.bestFor}
                placeholder={'One per line\nClothing shop\nPharmacy'}
                onChange={(event) => set('bestFor', event.target.value)}
              />
            </div>
            <div className="sm:col-span-2">
              <ImageField value={form.imageUrl} onChange={(url) => set('imageUrl', url)} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="hw-pkg-featured">Popular</Label>
                <p className="text-xs text-muted-foreground">Marked as popular on the website.</p>
              </div>
              <Switch id="hw-pkg-featured" checked={form.featured} onCheckedChange={(checked) => set('featured', checked)} />
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="hw-pkg-status">Published</Label>
                <p className="text-xs text-muted-foreground">Hidden packages leave the website.</p>
              </div>
              <Switch
                id="hw-pkg-status"
                checked={form.status === 'active'}
                onCheckedChange={(checked) => set('status', checked ? 'active' : 'inactive')}
              />
            </div>
          </section>

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={problem !== null} loading={save.isPending}>
              {isNew ? 'Create package' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------------------------------------------------------

/**
 * Catalogue art: an address, or a file uploaded here.
 *
 * It shares the platform branding uploader rather than the tenant one, which
 * is mounted behind a workspace a platform admin does not have. Pasting an
 * address stays available, because some art is already hosted elsewhere.
 */
function ImageField({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      onChange(await hardwareAdminApi.uploadImage(file));
      toast.success('Image uploaded');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not upload the image'));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="hw-image">Image</Label>
      <div className="flex items-center gap-2">
        {value ? (
          <img src={value} alt="" className="h-14 w-14 rounded border object-contain" />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded border bg-muted">
            <ImagePlus className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
        <Input
          id="hw-image"
          value={value}
          maxLength={600}
          placeholder="https://… or /uploads/…"
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button type="button" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}>
          {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
          Upload
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Optional. A card without one draws a placeholder instead.</p>
    </div>
  );
}
