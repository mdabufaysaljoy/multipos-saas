import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { roleApi, staffApi } from '@/api/endpoints';
import type { StaffMember } from '@/types/domain';

export function StaffPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [term, setTerm] = React.useState('');
  const search = useDebounced(term, 300);
  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<StaffMember | null>(null);
  const [deleting, setDeleting] = React.useState<StaffMember | null>(null);
  const [resetting, setResetting] = React.useState<StaffMember | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['staff', page, search],
    queryFn: () => staffApi.list({ page, limit: 20, search, includeInactive: true }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => staffApi.remove(id),
    onSuccess: () => {
      toast.success('Staff account removed', { description: 'Their past sales remain attributed to them.' });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not remove the account'),
  });

  const columns: Column<StaffMember>[] = [
    {
      key: 'person',
      header: 'Name',
      cell: (row) => (
        <div>
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      cell: (row) =>
        row.role === 'admin' ? (
          <Badge>Administrator</Badge>
        ) : row.roleName ? (
          <Badge variant="secondary">{row.roleName}</Badge>
        ) : (
          <span className="text-sm text-muted-foreground">No role</span>
        ),
    },
    {
      key: 'price',
      header: 'Can change price',
      cell: (row) =>
        row.role === 'admin' || row.effectivePermissions.includes('sales.changePrice') ? (
          <Badge variant="warning">Yes</Badge>
        ) : (
          <Badge variant="secondary">No</Badge>
        ),
    },
    {
      key: 'perms',
      header: 'Permissions',
      cell: (row) => (
        <span className="tabular text-sm text-muted-foreground">
          {row.role === 'admin' ? 'All' : row.effectivePermissions.length}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last sign-in',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {row.lastLoginAt ? format(new Date(row.lastLoginAt), 'dd MMM yyyy') : 'Never'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>,
    },
    {
      key: 'actions',
      header: '',
      headerClassName: 'text-right',
      className: 'text-right',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <PermissionGate anyOf={['staff.edit']}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => { setEditing(row); setFormOpen(true); }}
              aria-label="Edit staff"
            >
              <Pencil />
            </Button>
            {row.role !== 'admin' && (
              <Button variant="ghost" size="icon-sm" onClick={() => setResetting(row)} aria-label="Reset password">
                <KeyRound />
              </Button>
            )}
          </PermissionGate>
          {row.role !== 'admin' && (
            <PermissionGate anyOf={['staff.delete']}>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setDeleting(row)}
                aria-label="Delete staff"
              >
                <Trash2 />
              </Button>
            </PermissionGate>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Staff"
        description="Create sales-representative accounts and control exactly what each one can do."
        actions={
          <PermissionGate anyOf={['staff.create']}>
            <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
              <Plus />
              New staff account
            </Button>
          </PermissionGate>
        }
      />

      <SearchInput value={term} onChange={setTerm} placeholder="Search name, email or phone…" className="max-w-sm" />

      <Card>
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row.id}
          loading={isLoading}
          error={error ? (error as Error).message : null}
          onRetry={() => void refetch()}
          meta={data?.meta}
          onPageChange={setPage}
          emptyTitle="No staff accounts yet"
          emptyDescription="Add a cashier so they can run the POS with their own login."
          emptyAction={
            <PermissionGate anyOf={['staff.create']}>
              <Button onClick={() => { setEditing(null); setFormOpen(true); }}>
                <Users />
                Add a staff member
              </Button>
            </PermissionGate>
          }
        />
      </Card>

      <StaffFormDialog
        open={formOpen}
        staff={editing}
        onOpenChange={(open) => { setFormOpen(open); if (!open) setEditing(null); }}
      />

      <ResetPasswordDialog staff={resetting} onClose={() => setResetting(null)} />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove ${deleting?.name}?`}
        description="Their account is deactivated and all sessions ended. Sales they processed stay attributed to them."
        confirmLabel="Remove account"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </div>
  );
}

function StaffFormDialog({
  open,
  staff,
  onOpenChange,
}: {
  open: boolean;
  staff: StaffMember | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isEdit = Boolean(staff);

  const [form, setForm] = React.useState({
    name: '',
    email: '',
    phone: '',
    password: '',
    roleId: 'none',
    isActive: true,
  });
  const [extra, setExtra] = React.useState<string[]>([]);
  const [denied, setDenied] = React.useState<string[]>([]);

  const { data: roles } = useQuery({ queryKey: ['roles'], queryFn: roleApi.list, enabled: open });
  const { data: catalog } = useQuery({ queryKey: ['permission-catalog'], queryFn: roleApi.catalog, enabled: open });

  React.useEffect(() => {
    if (!open) return;
    if (staff) {
      setForm({
        name: staff.name,
        email: staff.email,
        phone: staff.phone,
        password: '',
        roleId: staff.roleId ?? 'none',
        isActive: staff.isActive,
      });
      setExtra(staff.extraPermissions);
      setDenied(staff.deniedPermissions);
    } else {
      setForm({ name: '', email: '', phone: '', password: '', roleId: 'none', isActive: true });
      setExtra([]);
      setDenied([]);
    }
  }, [open, staff]);

  const selectedRole = roles?.find((role) => role._id === form.roleId);
  const rolePermissions = new Set(selectedRole?.permissions ?? []);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        phone: form.phone.trim(),
        roleId: form.roleId === 'none' ? null : form.roleId,
        extraPermissions: extra,
        deniedPermissions: denied,
        isActive: form.isActive,
      };
      if (staff) return staffApi.update(staff.id, payload);
      return staffApi.create({ ...payload, email: form.email.trim(), password: form.password });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Staff account updated' : 'Staff account created');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the account'),
  });

  const toggle = (list: string[], setList: (next: string[]) => void, key: string) =>
    setList(list.includes(key) ? list.filter((item) => item !== key) : [...list, key]);

  const invalid =
    form.name.trim().length < 2 || (!isEdit && (form.email.trim().length < 5 || form.password.length < 8));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${staff?.name}` : 'New staff account'}</DialogTitle>
          <DialogDescription>
            Pick a role for the baseline, then grant or deny individual permissions on top of it.
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin max-h-[60vh] space-y-5 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="s-name">Name</Label>
              <Input id="s-name" autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-phone">Phone</Label>
              <Input id="s-phone" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s-email">Email {isEdit && <span className="text-muted-foreground">(cannot change)</span>}</Label>
              <Input
                id="s-email"
                type="email"
                disabled={isEdit}
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            {!isEdit && (
              <div className="space-y-1.5">
                <Label htmlFor="s-password">Password</Label>
                <Input
                  id="s-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="At least 8 characters"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="s-role">Role</Label>
              <Select value={form.roleId} onValueChange={(value) => setForm((f) => ({ ...f, roleId: value }))}>
                <SelectTrigger id="s-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No role (individual permissions only)</SelectItem>
                  {(roles ?? []).map((role) => (
                    <SelectItem key={role._id} value={role._id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label htmlFor="s-active">Active</Label>
                <p className="text-xs text-muted-foreground">Inactive accounts cannot sign in</p>
              </div>
              <Switch
                id="s-active"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, isActive: checked }))}
              />
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <Label>Permissions</Label>
              <p className="text-xs text-muted-foreground">
                A tick from the role is inherited. Add extras, or explicitly deny something the role grants.
              </p>
            </div>

            {(catalog ?? []).map((group) => (
              <div key={group.group} className="rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                <div className="divide-y">
                  {group.permissions.map((permission) => {
                    const fromRole = rolePermissions.has(permission.key);
                    const isExtra = extra.includes(permission.key);
                    const isDenied = denied.includes(permission.key);
                    const effective = (fromRole || isExtra) && !isDenied;

                    return (
                      <div key={permission.key} className="flex items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{permission.label}</p>
                          <p className="text-xs text-muted-foreground">{permission.description}</p>
                        </div>

                        {fromRole && !isDenied && <Badge variant="secondary">From role</Badge>}
                        {effective && <Badge variant="success">Allowed</Badge>}
                        {isDenied && <Badge variant="destructive">Denied</Badge>}

                        <label className="flex items-center gap-1.5 text-xs">
                          <Checkbox
                            checked={isExtra}
                            onCheckedChange={() => toggle(extra, setExtra, permission.key)}
                            aria-label={`Grant ${permission.label}`}
                          />
                          Grant
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                          <Checkbox
                            checked={isDenied}
                            onCheckedChange={() => toggle(denied, setDenied, permission.key)}
                            aria-label={`Deny ${permission.label}`}
                          />
                          Deny
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={invalid} loading={save.isPending}>
            {isEdit ? 'Save changes' : 'Create account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ staff, onClose }: { staff: StaffMember | null; onClose: () => void }) {
  const [password, setPassword] = React.useState('');

  React.useEffect(() => {
    if (staff) setPassword('');
  }, [staff]);

  const reset = useMutation({
    mutationFn: () => staffApi.resetPassword(staff!.id, password),
    onSuccess: () => {
      toast.success('Password reset', { description: 'They will need to sign in again.' });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not reset the password'),
  });

  return (
    <Dialog open={Boolean(staff)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new password for {staff?.name}. Every active session will be signed out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="new-pass">New password</Label>
          <Input
            id="new-pass"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={password.length < 8} loading={reset.isPending} onClick={() => reset.mutate()}>
            <ShieldCheck />
            Reset password
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
