import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
}

/** Every destructive action in the app routes through this dialog. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [working, setWorking] = React.useState(false);

  const handleConfirm = async () => {
    setWorking(true);
    try {
      await onConfirm();
    } finally {
      setWorking(false);
    }
  };

  const busy = working || loading;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            {destructive && (
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
            )}
            <div className="space-y-1.5">
              <DialogTitle>{title}</DialogTitle>
              {description && <DialogDescription asChild><div>{description}</div></DialogDescription>}
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={handleConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Small helper for the common "open a confirm, then run something" pattern. */
export function useConfirm() {
  const [state, setState] = React.useState<{ open: boolean; props: Omit<ConfirmDialogProps, 'open' | 'onOpenChange'> | null }>({
    open: false,
    props: null,
  });

  const confirm = (props: Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>) => setState({ open: true, props });

  const dialog = state.props ? (
    <ConfirmDialog
      {...state.props}
      open={state.open}
      onOpenChange={(open) => setState((prev) => ({ ...prev, open }))}
      onConfirm={async () => {
        await state.props?.onConfirm();
        setState({ open: false, props: null });
      }}
    />
  ) : null;

  return { confirm, dialog };
}
