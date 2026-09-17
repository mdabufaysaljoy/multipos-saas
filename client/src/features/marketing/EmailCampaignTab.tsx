import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Info, Mail, Send, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SearchInput, useDebounced } from '@/components/SearchInput';
import { ApiError } from '@/api/client';
import { customerApi, messagingApi } from '@/api/endpoints';
import { formatMoney } from '@/lib/money';
import { sanitizeEmailHtml } from '@/lib/sanitizeHtml';
import { HtmlEditor } from './HtmlEditor';
import { ChannelUnavailable } from './ChannelUnavailable';
import { cn } from '@/lib/utils';

interface EmailCampaignTabProps {
  currency: string;
  /** The plan includes email marketing. Governs whether this tab exists at all. */
  includedInPlan: boolean;
  /** SMTP is set up on the server. Governs SENDING only, never composing. */
  providerConfigured: boolean;
  planName: string | null;
  perEmailCostMinor: number;
  walletBalanceMinor: number;
}

/**
 * Email campaign composer.
 *
 * Only customers WITH an email address can be targeted - the audience list
 * filters them out client-side and the server filters again, so the tenant is
 * never charged for an address that does not exist.
 */
export function EmailCampaignTab({
  currency,
  includedInPlan,
  providerConfigured,
  planName,
  perEmailCostMinor,
  walletBalanceMinor,
}: EmailCampaignTabProps) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(() => readDraft().name);
  const [subject, setSubject] = React.useState(() => readDraft().subject);
  const [html, setHtml] = React.useState(() => readDraft().html);
  const [audience, setAudience] = React.useState<'all-customers' | 'selected'>('all-customers');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [term, setTerm] = React.useState('');
  const [confirm, setConfirm] = React.useState(false);
  const search = useDebounced(term, 300);

  const { data: customers } = useQuery({
    queryKey: ['customers', 'email-audience', search],
    queryFn: () => customerApi.list({ search, limit: 100 }),
  });

  // The audience is only ever customers with a usable address.
  const withEmail = React.useMemo(
    () => (customers?.items ?? []).filter((c) => c.email && /.+@.+\..+/.test(c.email)),
    [customers],
  );

  // Composing is allowed before sending is possible, so the draft has to
  // survive a reload - otherwise "write it now" means "write it now and lose
  // it". Per-browser only; it never leaves the device.
  React.useEffect(() => {
    writeDraft({ name, subject, html });
  }, [name, subject, html]);

  const recipientCount = audience === 'all-customers' ? withEmail.length : selected.length;
  const totalCostMinor = perEmailCostMinor * recipientCount;
  const affordable = totalCostMinor <= walletBalanceMinor;

  const send = useMutation({
    mutationFn: () =>
      messagingApi.sendEmailCampaign({
        name: name.trim(),
        subject: subject.trim(),
        // Sanitised before it leaves the browser; the server sanitises too.
        body: sanitizeEmailHtml(html),
        audience,
        ...(audience === 'selected' ? { customerIds: selected } : {}),
      }),
    onSuccess: () => {
      toast.success('Email campaign sent');
      setName('');
      setSubject('');
      setHtml('');
      clearDraft();
      setSelected([]);
      setConfirm(false);
      void queryClient.invalidateQueries({ queryKey: ['messaging'] });
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'Could not send the campaign');
      setConfirm(false);
    },
  });

  const valid = name.trim().length >= 2 && subject.trim().length >= 2 && html.trim().length > 0 && recipientCount > 0;

  // A plan that does not include email gets an explanation, not a dead form.
  if (!includedInPlan) return <ChannelUnavailable channel="Email" planName={planName} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            Email campaign
          </CardTitle>
          <CardDescription>Basic HTML is supported. Scripts and event handlers are stripped.</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Campaign name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Eid collection launch" />
            </div>
            <div className="space-y-1.5">
              <Label>Subject line</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Our new Eid collection is here" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Content</Label>
            {/* Deliberately NOT gated on SMTP. Writing a campaign is not
                sending one, and blocking the editor because a server-side
                setting is missing left this field permanently disabled with no
                way for the customer to tell why. */}
            <HtmlEditor value={html} onChange={setHtml} />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-4 w-4" />
              Recipients
            </CardTitle>
            <CardDescription>Only customers with an email address are listed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant={audience === 'all-customers' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setAudience('all-customers')}
              >
                All ({withEmail.length})
              </Button>
              <Button
                variant={audience === 'selected' ? 'default' : 'outline'}
                size="sm"
                className="flex-1"
                onClick={() => setAudience('selected')}
              >
                Choose ({selected.length})
              </Button>
            </div>

            {audience === 'selected' && (
              <>
                <SearchInput value={term} onChange={setTerm} placeholder="Search customers…" />
                <div className="scrollbar-thin max-h-56 space-y-1 overflow-y-auto rounded-md border p-1">
                  {withEmail.length === 0 && (
                    <p className="py-6 text-center text-xs text-muted-foreground">No customers have an email address</p>
                  )}
                  {withEmail.map((customer) => (
                    <label key={customer._id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent">
                      <Checkbox
                        checked={selected.includes(customer._id)}
                        onCheckedChange={() =>
                          setSelected((prev) =>
                            prev.includes(customer._id) ? prev.filter((id) => id !== customer._id) : [...prev, customer._id],
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{customer.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{customer.email}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {withEmail.length === 0 && audience === 'all-customers' && (
              <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                None of your customers have an email address on file yet.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Estimated cost</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="space-y-1.5 text-sm">
              <Row label="Recipients" value={String(recipientCount)} />
              <Row label="Price per email" value={perEmailCostMinor > 0 ? formatMoney(perEmailCostMinor, currency) : 'Free'} />
              <div className="flex justify-between border-t pt-2 text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular">{formatMoney(totalCostMinor, currency)}</dd>
              </div>
              <div className="flex justify-between text-xs">
                <dt className="text-muted-foreground">Wallet balance</dt>
                <dd className={cn('tabular', !affordable && 'font-semibold text-destructive')}>
                  {formatMoney(walletBalanceMinor, currency)}
                </dd>
              </div>
            </dl>

            {!affordable && recipientCount > 0 && (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
                Insufficient balance. Top up by {formatMoney(totalCostMinor - walletBalanceMinor, currency)} to send this
                campaign.
              </p>
            )}

            <Button
              className="w-full"
              disabled={!valid || !providerConfigured || !affordable}
              onClick={() => setConfirm(true)}
            >
              <Send />
              Send to {recipientCount} recipient{recipientCount === 1 ? '' : 's'}
            </Button>

            {!providerConfigured && (
              <p className="flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/5 p-2.5 text-xs text-warning">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  You can write and keep this campaign now. Sending is unavailable until an administrator finishes
                  setting up the mail server.
                </span>
              </p>
            )}
            <Badge variant="secondary" className="w-full justify-center">
              Failed emails are refunded automatically
            </Badge>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Send to ${recipientCount} recipient${recipientCount === 1 ? '' : 's'}?`}
        description={
          <span>
            {formatMoney(totalCostMinor, currency)} will be deducted from your wallet. Emails cannot be recalled once
            sent.
          </span>
        }
        confirmLabel="Send campaign"
        loading={send.isPending}
        onConfirm={() => send.mutate()}
      />
    </div>
  );
}

const DRAFT_KEY = 'pos.emailCampaignDraft';

interface EmailDraft {
  name: string;
  subject: string;
  html: string;
}

const EMPTY_DRAFT: EmailDraft = { name: '', subject: '', html: '' };

/** Storage can throw in a private window or when site data is blocked. */
function readDraft(): EmailDraft {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<EmailDraft>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      html: typeof parsed.html === 'string' ? parsed.html : '',
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(draft: EmailDraft) {
  try {
    if (!draft.name && !draft.subject && !draft.html) {
      window.localStorage.removeItem(DRAFT_KEY);
      return;
    }
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A lost draft is a nuisance, not a failure worth surfacing.
  }
}

function clearDraft() {
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignored
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value}</dd>
    </div>
  );
}
