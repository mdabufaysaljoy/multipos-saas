import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
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
import { ApiError } from '@/api/client';
import { workspaceApi } from '@/api/endpoints';
import { useAuth } from '@/hooks/useAuth';

/**
 * Opens a new POS workspace under the signed-in owner's account.
 *
 * The vertical list, ownership, the account and the trial decision all come
 * from the server; this only collects a name and a choice. After creation the
 * session moves into the new workspace, where the existing onboarding creates
 * its first store.
 */
export function CreateWorkspaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { switchWorkspace } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = React.useState('');
  const [vertical, setVertical] = React.useState('clothing');

  const { data: options } = useQuery({
    queryKey: ['workspace-verticals'],
    queryFn: workspaceApi.verticals,
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const create = useMutation({
    mutationFn: () => workspaceApi.create({ businessName: name.trim(), vertical }),
    onSuccess: async (result) => {
      toast.success(`${result.workspace.name} is ready`, {
        description: result.trial.started
          ? `Your ${result.trial.days}-day free trial has started.`
          : 'Choose a plan on the Subscription page to start selling. It is paid from your account wallet.',
      });
      onOpenChange(false);
      setName('');
      try {
        await switchWorkspace(result.workspace.id);
        navigate('/onboarding', { replace: true });
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'The workspace was created, but switching to it failed.');
      }
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not create the workspace'),
  });

  const nameValid = name.trim().length >= 2;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            A separate business with its own products, staff, sales and subscription. Every workspace pays from your
            account wallet.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (nameValid && !create.isPending) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="workspace-name">Business name</Label>
            <Input
              id="workspace-name"
              value={name}
              maxLength={160}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Denim Republic Uttara"
            />
          </div>

          <div className="space-y-1.5">
            <Label>POS type</Label>
            <Select value={vertical} onValueChange={setVertical}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(options ?? [{ vertical: 'clothing', label: 'Clothing', available: true }]).map((option) => (
                  <SelectItem key={option.vertical} value={option.vertical} disabled={!option.available}>
                    {option.label} POS{option.available ? '' : ' — coming soon'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options?.find((option) => option.vertical === vertical)?.description && (
              <p className="text-xs text-muted-foreground">{options.find((option) => option.vertical === vertical)?.description}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!nameValid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create workspace'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
