import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { LoadingState } from '@/components/states';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { ApiError } from '@/api/client';
import { roleApi } from '@/api/endpoints';
import type { Role } from '@/types/domain';

export function RolesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<Role | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Role | null>(null);

  const { data: roles, isLoading } = useQuery({ queryKey: ['roles'], queryFn: roleApi.list });
  const { data: catalog } = useQuery({ queryKey: ['permission-catalog'], queryFn: roleApi.catalog });

  const remove = useMutation({
    mutationFn: (id: string) => roleApi.remove(id),
    onSuccess: () => {
      toast.success('Role deleted');
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not delete the role'),
  });

  if (isLoading) return <LoadingState label="Loading roles…" />;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title="Roles"
        description="Reusable permission sets. Assign a role to staff instead of ticking boxes one by one."
        actions={
          <PermissionGate anyOf={['roles.manage']}>
            <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
              <Plus />
              New role
            </Button>
          </PermissionGate>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(roles ?? []).map((role) => (
          <Card key={role._id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-1.5 text-base">
                    {role.name}
                    {role.isSystem && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                  </CardTitle>
                  <p className="mt-0.5 text-sm text-muted-foreground">{role.description}</p>
                </div>
                <PermissionGate anyOf={['roles.manage']}>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => { setEditing(role); setDialogOpen(true); }}
                      aria-label={`Edit ${role.name}`}
                    >
                      <Pencil />
                    </Button>
                    {!role.isSystem && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleting(role)}
                        aria-label={`Delete ${role.name}`}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                </PermissionGate>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{role.permissions.length} permissions</Badge>
                <Badge variant="outline">{role.staffCount ?? 0} staff</Badge>
                {role.permissions.includes('sales.changePrice') && (
                  <Badge variant="warning">Can change prices</Badge>
                )}
                {role.isSystem && <Badge variant="outline">Built-in</Badge>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <RoleFormDialog
        open={dialogOpen}
        role={editing}
        catalog={catalog ?? []}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditing(null); }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete the "${deleting?.name}" role?`}
        description="Staff still using this role must be reassigned first."
        confirmLabel="Delete role"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting._id);
        }}
      />
    </div>
  );
}

function RoleFormDialog({
  open,
  role,
  catalog,
  onOpenChange,
}: {
  open: boolean;
  role: Role | null;
  catalog: { group: string; label: string; permissions: { key: string; label: string; description: string }[] }[];
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [permissions, setPermissions] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!open) return;
    setName(role?.name ?? '');
    setDescription(role?.description ?? '');
    setPermissions(role?.permissions ?? []);
  }, [open, role]);

  const save = useMutation({
    mutationFn: () => {
      const payload = { name: name.trim(), description: description.trim(), permissions };
      return role ? roleApi.update(role._id, payload) : roleApi.create(payload);
    },
    onSuccess: () => {
      toast.success(role ? 'Role updated' : 'Role created');
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the role'),
  });

  const toggle = (key: string) =>
    setPermissions((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));

  const toggleGroup = (groupKeys: string[]) => {
    const allOn = groupKeys.every((key) => permissions.includes(key));
    setPermissions((prev) =>
      allOn ? prev.filter((key) => !groupKeys.includes(key)) : [...new Set([...prev, ...groupKeys])],
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{role ? `Edit "${role.name}"` : 'New role'}</DialogTitle>
          <DialogDescription>
            Changes apply immediately to everyone holding this role.
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="r-name">Role name</Label>
              <Input
                id="r-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Senior Cashier"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-desc">Description</Label>
              <Textarea
                id="r-desc"
                rows={1}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this role is for"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Permissions ({permissions.length})</Label>
            </div>

            {catalog.map((group) => {
              const groupKeys = group.permissions.map((permission) => permission.key);
              const allOn = groupKeys.every((key) => permissions.includes(key));

              return (
                <div key={group.group} className="rounded-md border">
                  <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleGroup(groupKeys)}>
                      {allOn ? 'Clear all' : 'Select all'}
                    </Button>
                  </div>
                  <div className="divide-y">
                    {group.permissions.map((permission) => (
                      <label
                        key={permission.key}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/40"
                      >
                        <Checkbox
                          checked={permissions.includes(permission.key)}
                          onCheckedChange={() => toggle(permission.key)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{permission.label}</p>
                          <p className="text-xs text-muted-foreground">{permission.description}</p>
                        </div>
                        {(permission.key === 'sales.changePrice' || permission.key === 'sales.sellOutOfStock') && <Badge variant="warning">Sensitive</Badge>}
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={name.trim().length < 2} loading={save.isPending}>
            <ShieldCheck />
            {role ? 'Save role' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
