import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ArrowLeft, Plus, Tags, UserCog, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState, LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { MoneyInput } from '@/components/MoneyInput';
import { QuantityInput } from '@/components/QuantityInput';
import { ApiError } from '@/api/client';
import { platformApi, roleApi, type UntypedAdminPayload } from '@/api/endpoints';
import { WalletAdjustDialog } from '@/features/platform/WalletAdjustDialog';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Category, Product, Role, StaffMember } from '@/types/domain';

/**
 * Platform-admin management of ONE workspace.
 *
 * Every call goes through /platform/workspaces/:tenantId/*, so the target
 * tenant is explicit in the URL and can never be inferred. The backend
 * re-checks the platform-admin role on each request.
 */
export function WorkspacePage() {
  const { tenantId = '' } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const api = React.useMemo(() => platformApi.ws(tenantId), [tenantId]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['ws', tenantId, 'overview'],
    queryFn: api.overview,
    enabled: Boolean(tenantId),
  });

  if (isLoading) return <LoadingState label="Loading workspace…" />;
  if (isError || !data) {
    return <div className="p-6"><EmptyState title="Could not load this workspace" /></div>;
  }

  const currency = 'BDT';

  return (
    <div className="min-h-full bg-muted/30">
      <div className="space-y-5 p-4 lg:p-6">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate('/platform')}>
          <ArrowLeft />
          Back to platform
        </Button>

        <PageHeader
          title={data.tenant.name}
          description={`${data.owner?.name ?? 'No owner'} · ${data.owner?.email ?? '—'}`}
          actions={
            <div className="flex items-center gap-2">
              <Badge variant={data.tenant.status === 'active' ? 'success' : 'destructive'}>{data.tenant.status}</Badge>
              {data.subscription && <Badge variant="secondary">{data.subscription.plan.name}</Badge>}
            </div>
          }
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Branches" value={`${data.counts.activeBranches}/${data.counts.branches}`} />
          <Stat label="Staff" value={String(data.counts.staff)} />
          <Stat label="Products" value={String(data.counts.products)} />
          <Stat label="Wallet" value={formatMoney(data.wallet.balanceMinor, currency)} />
          <Stat label="Orders" value={String(data.counts.orders)} />
          <Stat label="Gross sales" value={formatMoney(data.performance.grossSalesMinor, currency)} />
          <Stat label="Gross profit" value={formatMoney(data.performance.grossProfitMinor, currency)} tone="success" />
          <Stat
            label="Renews"
            value={data.subscription ? format(new Date(data.subscription.currentPeriodEnd), 'd MMM yyyy') : '—'}
          />
        </div>

        <Tabs defaultValue="branches">
          <TabsList className="h-auto flex-wrap justify-start gap-1">
            <TabsTrigger value="branches">Branches</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="staff">Staff</TabsTrigger>
            <TabsTrigger value="roles">Roles</TabsTrigger>
            <TabsTrigger value="wallet">Wallet</TabsTrigger>
            <TabsTrigger value="sales">Sales</TabsTrigger>
          </TabsList>

          <TabsContent value="branches"><BranchesTab api={api} tenantId={tenantId} currency={currency} /></TabsContent>
          <TabsContent value="products"><ProductsTab api={api} tenantId={tenantId} currency={currency} /></TabsContent>
          <TabsContent value="categories"><CategoriesTab api={api} tenantId={tenantId} /></TabsContent>
          <TabsContent value="staff"><StaffTab api={api} tenantId={tenantId} /></TabsContent>
          <TabsContent value="roles"><RolesTab api={api} tenantId={tenantId} /></TabsContent>
          <TabsContent value="wallet"><WalletTab tenantId={tenantId} tenantName={data.tenant.name} currency={currency} /></TabsContent>
          <TabsContent value="sales"><SalesTab api={api} tenantId={tenantId} currency={currency} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

type WsApi = ReturnType<typeof platformApi.ws>;

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={cn('tabular mt-1 text-xl font-semibold', tone === 'success' && 'text-success')}>{value}</p>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ branches

function BranchesTab({ api, tenantId, currency }: { api: WsApi; tenantId: string; currency: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', code: '', phone: '', address: '', override: false });

  const { data, isLoading } = useQuery({ queryKey: ['ws', tenantId, 'stores'], queryFn: api.stores });

  const create = useMutation({
    mutationFn: () => api.createStore({ ...form, currency }),
    onSuccess: () => {
      toast.success('Branch created');
      setOpen(false);
      setForm({ name: '', code: '', phone: '', address: '', override: false });
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the branch'),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.updateStore(id, { isActive }),
    onSuccess: () => {
      toast.success('Branch updated');
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the branch'),
  });

  const columns: Column<UntypedAdminPayload>[] = [
    {
      key: 'name',
      header: 'Branch',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
        </div>
      ),
    },
    { key: 'phone', header: 'Phone', cell: (row) => <span className="text-sm">{row.phone || '—'}</span> },
    { key: 'address', header: 'Address', cell: (row) => <span className="text-sm text-muted-foreground">{row.address || '—'}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex gap-1">
          {row.isDefault && <Badge variant="secondary">Main</Badge>}
          <Badge variant={row.isActive ? 'success' : 'destructive'}>{row.isActive ? 'Active' : 'Inactive'}</Badge>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) =>
        row.isDefault ? null : (
          <Button
            variant="outline"
            size="sm"
            loading={toggle.isPending}
            onClick={() => toggle.mutate({ id: row._id, isActive: !row.isActive })}
          >
            {row.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus />
          New branch
        </Button>
      </div>

      <Card>
        <DataTable columns={columns} rows={data ?? []} rowKey={(row) => row._id} loading={isLoading} emptyTitle="No branches" />
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
            <DialogDescription>Created inside this customer's workspace.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Address</Label>
              <Textarea rows={2} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            </div>

            <label className="flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 p-3">
              <span className="text-sm">
                <span className="font-medium">Override the plan limit</span>
                <span className="block text-xs text-muted-foreground">
                  Only for paid setup work. The action is recorded in the audit log.
                </span>
              </span>
              <Switch checked={form.override} onCheckedChange={(v) => setForm((f) => ({ ...f, override: v }))} />
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={form.name.trim().length < 2} loading={create.isPending} onClick={() => create.mutate()}>
              Create branch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------ products

function ProductsTab({ api, tenantId, currency }: { api: WsApi; tenantId: string; currency: string }) {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [open, setOpen] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['ws', tenantId, 'products', page, search],
    queryFn: () => api.products({ page, limit: 20, search, includeInactive: true }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteProduct(id),
    onSuccess: () => {
      toast.success('Product deactivated');
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId, 'products'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the product'),
  });

  const columns: Column<Product>[] = [
    {
      key: 'name',
      header: 'Product',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="font-mono text-xs text-muted-foreground">{row.sku}</p>
        </div>
      ),
    },
    { key: 'category', header: 'Category', cell: (row) => <span className="text-sm">{row.categoryNameSnapshot || '—'}</span> },
    { key: 'variants', header: 'Variants', cell: (row) => <span className="tabular">{row.variantCount ?? row.variants?.length ?? 0}</span> },
    { key: 'stock', header: 'Stock', cell: (row) => <span className="tabular">{row.totalStock ?? 0}</span> },
    {
      key: 'price',
      header: 'Price',
      cell: (row) => <span className="tabular">{formatMoney(row.minPriceMinor ?? 0, currency)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.isActive ? 'success' : 'secondary'}>{row.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove.mutate(row._id)}>
          Deactivate
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={term} onChange={setTerm} placeholder="Search products…" className="max-w-sm" />
        <Button className="ml-auto" onClick={() => setOpen(true)}>
          <Plus />
          New product
        </Button>
      </div>

      <Card>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row._id}
          loading={isLoading}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No products in this workspace"
          emptyDescription="Create the customer's catalogue as part of setup."
        />
      </Card>

      <WorkspaceProductDialog api={api} tenantId={tenantId} open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Minimal product creator for setup work; the tenant form remains the full one. */
function WorkspaceProductDialog({
  api,
  tenantId,
  open,
  onOpenChange,
}: {
  api: WsApi;
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [categoryId, setCategoryId] = React.useState('none');
  const [brand, setBrand] = React.useState('');
  const [price, setPrice] = React.useState<number | null>(null);
  const [cost, setCost] = React.useState<number | null>(null);
  const [stock, setStock] = React.useState<number | null>(0);
  const [barcode, setBarcode] = React.useState('');

  const { data: categories } = useQuery({
    queryKey: ['ws', tenantId, 'categories', 'all'],
    queryFn: () => api.categories({ limit: 100 }),
    enabled: open,
  });

  React.useEffect(() => {
    if (!open) return;
    setName(''); setCategoryId('none'); setBrand(''); setPrice(null); setCost(null); setStock(0); setBarcode('');
  }, [open]);

  const genBarcode = useMutation({
    mutationFn: () => api.generateBarcode(),
    onSuccess: (result) => setBarcode(result.barcode),
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not generate a barcode'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createProduct({
        name: name.trim(),
        brand: brand.trim(),
        ...(categoryId !== 'none' ? { categoryId } : {}),
        variants: [
          {
            attributes: [],
            sellingPriceMinor: price ?? 0,
            costPriceMinor: cost ?? 0,
            stock: stock ?? 0,
            ...(barcode ? { barcode } : {}),
          },
        ],
      }),
    onSuccess: () => {
      toast.success('Product created');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the product'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>
            Creates a single-variant product in this workspace. The store owner can add colour and size variants later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Product name</Label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Brand</Label>
              <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {(categories?.items ?? []).map((c) => (
                    <SelectItem key={c._id} value={c._id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Selling price</Label>
              <MoneyInput value={price} onChange={setPrice} ariaLabel="Selling price" />
            </div>
            <div className="space-y-1.5">
              <Label>Cost price</Label>
              <MoneyInput value={cost} onChange={setCost} ariaLabel="Cost price" />
            </div>
            <div className="space-y-1.5">
              <Label>Opening stock</Label>
              <QuantityInput value={stock} onChange={setStock} showSteppers={false} ariaLabel="Opening stock" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Barcode</Label>
            <div className="flex gap-2">
              <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} className="font-mono" placeholder="Optional" />
              <Button variant="outline" loading={genBarcode.isPending} onClick={() => genBarcode.mutate()}>
                Generate
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={name.trim().length < 2 || !price || price <= 0}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create product
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- categories

function CategoriesTab({ api, tenantId }: { api: WsApi; tenantId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['ws', tenantId, 'categories'],
    queryFn: () => api.categories({ limit: 50, includeInactive: true }),
  });

  const create = useMutation({
    mutationFn: () => api.createCategory({ name: name.trim() }),
    onSuccess: () => {
      toast.success('Category created');
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId, 'categories'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the category'),
  });

  const columns: Column<Category>[] = [
    { key: 'name', header: 'Category', cell: (row) => <span className="font-medium">{row.name}</span> },
    { key: 'products', header: 'Products', cell: (row) => <span className="tabular">{row.productCount ?? 0}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.isActive ? 'success' : 'secondary'}>{row.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 p-4">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label>New category</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Panjabi" />
          </div>
          <Button disabled={name.trim().length < 1} loading={create.isPending} onClick={() => create.mutate()}>
            <Tags />
            Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(row) => row._id} loading={isLoading} emptyTitle="No categories" />
      </Card>
    </div>
  );
}

// --------------------------------------------------------------------- staff

function StaffTab({ api, tenantId }: { api: WsApi; tenantId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ name: '', email: '', password: '', roleId: 'none' });

  const { data, isLoading } = useQuery({
    queryKey: ['ws', tenantId, 'staff'],
    queryFn: () => api.staff({ limit: 50, includeInactive: true }),
  });
  const { data: roles } = useQuery({ queryKey: ['ws', tenantId, 'roles'], queryFn: api.roles });

  const create = useMutation({
    mutationFn: () =>
      api.createStaff({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        ...(form.roleId !== 'none' ? { roleId: form.roleId } : {}),
      }),
    onSuccess: () => {
      toast.success('Staff account created');
      setOpen(false);
      setForm({ name: '', email: '', password: '', roleId: 'none' });
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the account'),
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.updateStaff(id, { isActive }),
    onSuccess: () => {
      toast.success('Staff updated');
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId, 'staff'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not update the account'),
  });

  const columns: Column<StaffMember>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    { key: 'role', header: 'Role', cell: (row) => (row.role === 'admin' ? <Badge>Owner</Badge> : <Badge variant="secondary">{row.roleName ?? 'No role'}</Badge>) },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <Badge variant={row.isActive ? 'success' : 'destructive'}>{row.isActive ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) =>
        row.role === 'admin' ? null : (
          <Button variant="outline" size="sm" onClick={() => toggle.mutate({ id: row.id, isActive: !row.isActive })}>
            {row.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Users />
          New staff account
        </Button>
      </div>

      <Card>
        <DataTable columns={columns} rows={data?.items ?? []} rowKey={(row) => row.id} loading={isLoading} emptyTitle="No staff yet" />
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New staff account</DialogTitle>
            <DialogDescription>Created inside this customer's workspace with the role you choose.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Temporary password</Label>
              <Input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.roleId} onValueChange={(v) => setForm((f) => ({ ...f, roleId: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No role</SelectItem>
                  {(roles ?? []).map((role) => (
                    <SelectItem key={role._id} value={role._id}>{role.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              disabled={form.name.trim().length < 2 || form.email.trim().length < 5 || form.password.length < 8}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// --------------------------------------------------------------------- roles

function RolesTab({ api, tenantId }: { api: WsApi; tenantId: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [permissions, setPermissions] = React.useState<string[]>([]);
  const [open, setOpen] = React.useState(false);

  const { data: roles, isLoading } = useQuery({ queryKey: ['ws', tenantId, 'roles'], queryFn: api.roles });
  const { data: catalog } = useQuery({ queryKey: ['permission-catalog'], queryFn: roleApi.catalog, enabled: open });

  const create = useMutation({
    mutationFn: () => api.createRole({ name: name.trim(), permissions }),
    onSuccess: () => {
      toast.success('Role created');
      setOpen(false);
      setName('');
      setPermissions([]);
      void queryClient.invalidateQueries({ queryKey: ['ws', tenantId, 'roles'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the role'),
  });

  const columns: Column<Role>[] = [
    { key: 'name', header: 'Role', cell: (row) => <span className="font-medium">{row.name}</span> },
    { key: 'perms', header: 'Permissions', cell: (row) => <span className="tabular">{row.permissions.length}</span> },
    { key: 'staff', header: 'Staff', cell: (row) => <span className="tabular">{row.staffCount ?? 0}</span> },
    { key: 'system', header: '', cell: (row) => (row.isSystem ? <Badge variant="secondary">Built-in</Badge> : null) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <UserCog />
          New role
        </Button>
      </div>

      <Card>
        <DataTable columns={columns} rows={roles ?? []} rowKey={(row) => row._id} loading={isLoading} emptyTitle="No roles" />
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New role</DialogTitle>
            <DialogDescription>Uses the same permission catalogue as the store owner's own role editor.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Role name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="scrollbar-thin max-h-[45vh] space-y-2 overflow-y-auto">
              {(catalog ?? []).map((group) => (
                <div key={group.group} className="rounded-md border">
                  <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </div>
                  <div className="divide-y">
                    {group.permissions.map((permission) => (
                      <label key={permission.key} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/40">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={permissions.includes(permission.key)}
                          onChange={() =>
                            setPermissions((prev) =>
                              prev.includes(permission.key) ? prev.filter((p) => p !== permission.key) : [...prev, permission.key],
                            )
                          }
                        />
                        {permission.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={name.trim().length < 2} loading={create.isPending} onClick={() => create.mutate()}>
              Create role
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// -------------------------------------------------------------------- wallet

/** Workspace wallet: balance, ledger, and manual credit/debit. */
function WalletTab({ tenantId, tenantName, currency }: { tenantId: string; tenantName: string; currency: string }) {
  const [adjusting, setAdjusting] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['platform', 'wallet', tenantId],
    queryFn: () => platformApi.tenantWallet(tenantId),
  });

  if (isLoading || !data) return <LoadingState label="Loading wallet…" />;

  const columns: Column<UntypedAdminPayload>[] = [
    {
      key: 'when',
      header: 'When',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">{format(new Date(row.createdAt), 'd MMM yyyy, hh:mm a')}</span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant={row.type === 'debit' ? 'destructive' : 'success'}>{row.type}</Badge>
          {row.referenceType && <Badge variant="secondary">{row.referenceType}</Badge>}
        </div>
      ),
    },
    { key: 'reason', header: 'Description', cell: (row) => <span className="text-sm">{row.reason}</span> },
    { key: 'by', header: 'By', cell: (row) => <span className="text-xs text-muted-foreground">{row.performedByNameSnapshot}</span> },
    {
      key: 'amount',
      header: 'Amount',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <span className={cn('tabular font-medium', row.type === 'debit' ? 'text-destructive' : 'text-success')}>
          {row.type === 'debit' ? '−' : '+'}
          {formatMoney(row.amountMinor, currency)}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => <span className="tabular text-sm text-muted-foreground">{formatMoney(row.balanceAfterMinor, currency)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Wallet balance</p>
            <p className="tabular mt-1 text-3xl font-bold">{formatMoney(data.wallet.balanceMinor, currency)}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatMoney(data.wallet.lifetimeCreditedMinor, currency)} added ·{' '}
              {formatMoney(data.wallet.lifetimeDebitedMinor, currency)} spent
              {data.wallet.isFrozen ? ' · frozen' : ''}
            </p>
          </div>
          <Button onClick={() => setAdjusting(true)}>
            <Plus />
            Add / deduct money
          </Button>
        </CardContent>
      </Card>

      <Card>
        <DataTable
          columns={columns}
          rows={data.transactions ?? []}
          rowKey={(row) => row._id}
          emptyTitle="No wallet activity"
          emptyDescription="Credits, spending and adjustments appear here."
        />
      </Card>

      <WalletAdjustDialog
        tenantId={adjusting ? tenantId : null}
        tenantName={tenantName}
        currentBalanceMinor={data.wallet.balanceMinor}
        currency={currency}
        onClose={() => setAdjusting(false)}
      />
    </div>
  );
}

// --------------------------------------------------------------------- sales

function SalesTab({ api, tenantId, currency }: { api: WsApi; tenantId: string; currency: string }) {
  const [preset, setPreset] = React.useState('last30');
  const { data: analytics } = useQuery({
    queryKey: ['ws', tenantId, 'analytics', preset],
    queryFn: () => api.analytics({ preset }),
  });
  const { data: sales, isLoading } = useQuery({
    queryKey: ['ws', tenantId, 'sales'],
    queryFn: () => api.sales({ limit: 20 }),
  });

  const columns: Column<UntypedAdminPayload>[] = [
    { key: 'number', header: 'Invoice', cell: (row) => <span className="font-mono text-sm">{row.saleNumber}</span> },
    { key: 'date', header: 'Date', cell: (row) => <span className="text-sm text-muted-foreground">{format(new Date(row.soldAt), 'd MMM, hh:mm a')}</span> },
    { key: 'cashier', header: 'Cashier', cell: (row) => <span className="text-sm">{row.cashierNameSnapshot}</span> },
    { key: 'items', header: 'Items', cell: (row) => <span className="tabular">{row.items?.length ?? 0}</span> },
    {
      key: 'total',
      header: 'Total',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => <span className="tabular font-medium">{formatMoney(row.totalMinor, currency)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {['today', 'last7', 'last30', 'thisMonth', 'thisYear'].map((value) => (
          <Button key={value} variant={preset === value ? 'default' : 'outline'} size="sm" onClick={() => setPreset(value)}>
            {value}
          </Button>
        ))}
      </div>

      {analytics && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Gross sales" value={formatMoney(analytics.grossSalesMinor, currency)} />
          <Stat label="Discounts" value={formatMoney(analytics.discountsMinor, currency)} />
          <Stat label="Returns" value={formatMoney(analytics.returnAmountMinor, currency)} />
          <Stat label="Net sales" value={formatMoney(analytics.netSalesMinor, currency)} />
          <Stat label="COGS" value={formatMoney(analytics.cogsMinor, currency)} />
          <Stat label="Net profit" value={formatMoney(analytics.netProfitMinor, currency)} tone="success" />
          <Stat label="Invoices" value={String(analytics.invoiceCount)} />
          <Stat label="Items sold" value={String(analytics.itemCount)} />
        </div>
      )}

      <Card>
        <DataTable columns={columns} rows={sales?.items ?? []} rowKey={(row) => row._id} loading={isLoading} emptyTitle="No sales yet" />
      </Card>
    </div>
  );
}
