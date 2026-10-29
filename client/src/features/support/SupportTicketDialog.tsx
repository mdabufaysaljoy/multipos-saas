import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ApiError } from '@/api/client';
import { supportApi } from '@/api/endpoints';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SUPPORT_AREA_LABELS, SUPPORT_AREAS, createTicketSchema, type CreateTicketValues } from './supportSchema';

/**
 * Write to the platform team: something is broken, or something is missing.
 *
 * The kind is a choice rather than something inferred from the words, because
 * it is what the operator sorts their inbox by. The area is optional in spirit
 * - it defaults to "Something else" and nobody is stopped by it.
 */

const EMPTY: CreateTicketValues = { type: 'problem', area: 'other', subject: '', message: '' };

interface SupportTicketDialogProps {
  open: boolean;
  /** Which kind the dialog opens on, following the button that was pressed. */
  initialType: CreateTicketValues['type'];
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

export function SupportTicketDialog({ open, initialType, onOpenChange, onSent }: SupportTicketDialogProps) {
  const form = useForm<CreateTicketValues>({ resolver: zodResolver(createTicketSchema), defaultValues: EMPTY });

  React.useEffect(() => {
    if (open) form.reset({ ...EMPTY, type: initialType });
  }, [open, initialType, form]);

  const send = useMutation({
    mutationFn: (values: CreateTicketValues) => supportApi.create(values),
    onSuccess: (ticket) => {
      toast.success('Sent to the platform team', { description: `${ticket.reference} · we will reply here` });
      onOpenChange(false);
      onSent();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not send this'),
  });

  const type = form.watch('type');
  const error = (field: keyof CreateTicketValues) => form.formState.errors[field]?.message;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Contact the platform team</DialogTitle>
          <DialogDescription>
            Tell us what went wrong or what you would like the system to do. We reply on this page, and you can see the status of everything you have sent.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit((values) => send.mutate(values))} className="space-y-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-type">What is this about?</Label>
              <Select value={type} onValueChange={(value) => form.setValue('type', value as CreateTicketValues['type'])}>
                <SelectTrigger id="t-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="problem">Report a problem</SelectItem>
                  <SelectItem value="feature">Request a feature</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="t-area">Which part of the system?</Label>
              <Select value={form.watch('area')} onValueChange={(value) => form.setValue('area', value as CreateTicketValues['area'])}>
                <SelectTrigger id="t-area">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_AREAS.map((area) => (
                    <SelectItem key={area} value={area}>
                      {SUPPORT_AREA_LABELS[area]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t-subject">Subject</Label>
            <Input
              id="t-subject"
              autoFocus
              placeholder={type === 'problem' ? 'Receipt prints twice on the second till' : 'Let us email a receipt to the customer'}
              {...form.register('subject')}
            />
            {error('subject') && <p className="text-xs text-destructive">{error('subject')}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="t-message">{type === 'problem' ? 'What happens?' : 'What would you like?'}</Label>
            <Textarea
              id="t-message"
              rows={7}
              placeholder={
                type === 'problem'
                  ? 'What you did, what you expected and what happened instead. Which branch and which till, if it is only one of them.'
                  : 'What you are trying to do today, and how this would help.'
              }
              {...form.register('message')}
            />
            {error('message') && <p className="text-xs text-destructive">{error('message')}</p>}
            <p className="text-xs text-muted-foreground">Plain text, up to 4000 characters. Please do not include passwords or card numbers.</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={send.isPending} disabled={send.isPending}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
