import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ApiError } from '@/api/client';
import { memberApi, roleApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';
import type { WorkspaceMemberRow } from '@/types/domain';

const errorMessage = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * People from the account's other workspaces who also work here.
 *
 * Only the account owner can add someone (the server enforces it); anyone with
 * staff permissions sees and manages existing members within their own authority.
 */
export function WorkspaceMembersCard() {
  const { session, can } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<WorkspaceMemberRow | null>(null);

  const isOwner = session?.user.role === 'admin';
  const hasSiblings = (session?.workspaces?.length ?? 0) > 1;
  const { data: members = [], isLoading } = useQuery({
    queryKey: ['staff', 'members'],
    queryFn: memberApi.list,
    enabled: can('staff.view'),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['staff', 'members'] });
    void queryClient.invalidateQueries({ queryKey: ['subscription', 'current'] });
  };

  const toggle = useMutation({
    mutationFn: (member: WorkspaceMemberRow) => memberApi.update(member.id, { isActive: !member.isActive }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorMessage(err, 'Could not update the member')),
  });
  const remove = useMutation({
    mutationFn: (id: string) => memberApi.remove(id),
    onSuccess: () => {
      toast.success('Member removed', { description: 'Their home workspace is not affected.' });
      setRemoving(null);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not remove the member')),
  });

  if (!can('staff.view')) return null;
  if (!isLoading && members.length === 0 && !(isOwner && hasSiblings)) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-base">From your other workspaces</CardTitle>
          <p className="text-sm text-muted-foreground">Staff who work here too, with access set separately for this workspace.</p>
        </div>
        {isOwner && hasSiblings && (
          <Button variant="outline" onClick={() => setAdding(true)}>
            <UserPlus />
            Add member
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Nobody from another workspace works here yet.</p>
        ) : (
          <ul className="divide-y">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{member.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {member.email} · from {member.homeWorkspace?.name ?? 'another workspace'}
                  </p>
                </div>
                {member.roleName ? <Badge variant="secondary">{member.roleName}</Badge> : <span className="text-xs text-muted-foreground">No role</span>}
                <span className="tabular text-xs text-muted-foreground">{member.effectivePermissions.length} permissions</span>
                {!member.accountActive && <Badge variant="destructive">Account deactivated</Badge>}
                {can('staff.edit') && (
                  <Switch
                    checked={member.isActive}
                    onCheckedChange={() => toggle.mutate(member)}
                    disabled={toggle.isPending}
                    aria-label={member.isActive ? 'Deactivate member' : 'Activate member'}
                  />
                )}
                {can('staff.delete') && (
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRemoving(member)} aria-label="Remove member">
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AddMemberDialog open={adding} onOpenChange={setAdding} onAdded={refresh} />
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name} from this workspace?`}
        description="They lose access here straight away. Their own workspace and account are not affected."
        confirmLabel="Remove member"
        destructive
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id);
        }}
      />
    </Card>
  );
}

function AddMemberDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  const [email, setEmail] = React.useState('');
  const [roleId, setRoleId] = React.useState('none');
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: roleApi.list, enabled: open });

  React.useEffect(() => {
    if (open) {
      setEmail('');
      setRoleId('none');
    }
  }, [open]);

  const add = useMutation({
    mutationFn: () => memberApi.add({ email: email.trim(), roleId: roleId === 'none' ? null : roleId }),
    onSuccess: (member) => {
      toast.success(`${member.name} can now work here`, { description: 'They can switch to this workspace after signing in.' });
      onOpenChange(false);
      onAdded();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not add the member')),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add someone from another workspace</DialogTitle>
          <DialogDescription>They keep one login. Their access here is separate from their own workspace.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="member-email">Their staff email</Label>
            <Input id="member-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cashier@yourbusiness.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Role here</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No role</SelectItem>
                {roles
                  .filter((role) => role.isActive)
                  .map((role) => (
                    <SelectItem key={role._id} value={role._id}>
                      {role.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!email.includes('@')} loading={add.isPending} onClick={() => add.mutate()}>
            Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
