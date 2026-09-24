import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Download, FileDown, Lock, Sparkles, XCircle } from 'lucide-react';
import { ApiError } from '@/api/client';
import { exportApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { useAuth } from '@/hooks/useAuth';
import { saveBlob } from '@/lib/download';
import { formatBytes } from '@/lib/planCatalog';
import { cn } from '@/lib/utils';
import type { ExportJob } from '@/types/domain';

const PRESETS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'thisYear', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
] as const;

/**
 * Data Export (Professional and Enterprise plans).
 *
 * The page only offers what the server's registry returns; the generated file
 * streams straight to the browser, so nothing is stored. The backend checks the
 * plan entitlement and the `reports.export` permission on every request - this
 * screen is convenience, not security.
 */
export function DataExportPage() {
  const queryClient = useQueryClient();
  const { session, can, isAdmin } = useAuth();
  const entitled = session?.entitlement?.features?.exportData === true;

  const [type, setType] = React.useState('sales');
  const [format, setFormat] = React.useState<'csv' | 'xlsx' | 'json' | 'pdf'>('xlsx');
  const [preset, setPreset] = React.useState<string>('last30');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [branch, setBranch] = React.useState<'current' | 'all'>('current');

  const { data: catalog, error: catalogError } = useQuery({
    queryKey: ['exports', 'datasets'],
    queryFn: exportApi.datasets,
    enabled: entitled,
    retry: false,
  });
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['exports', 'history'],
    queryFn: () => exportApi.history({ limit: 10 }),
    enabled: entitled,
    retry: false,
  });

  const dataset = catalog?.datasets.find((item) => item.key === type);
  const locked = !entitled || (catalogError instanceof ApiError && ['ENTITLEMENT_REQUIRED', 'FORBIDDEN'].includes(catalogError.code));

  const run = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await exportApi.run({
        type,
        format,
        ...(dataset?.dated ? { preset, ...(preset === 'custom' ? { from, to } : {}) } : {}),
        branch,
      });
      saveBlob(blob, filename);
      return filename;
    },
    onSuccess: (filename) => {
      toast.success('Export ready', { description: filename });
      void queryClient.invalidateQueries({ queryKey: ['exports', 'history'] });
    },
    onError: async (error) => {
      // A failed download still arrives as a blob; read the message out of it.
      let message = 'The export could not be generated.';
      if (error instanceof ApiError) message = error.message;
      const blob = (error as { response?: { data?: Blob } }).response?.data;
      if (blob instanceof Blob) {
        try {
          const parsed = JSON.parse(await blob.text()) as { error?: { message?: string } };
          message = parsed.error?.message ?? message;
        } catch {
          // Keep the generic message.
        }
      }
      toast.error('Export failed', { description: message });
      void queryClient.invalidateQueries({ queryKey: ['exports', 'history'] });
    },
  });

  if (locked) {
    return (
      <div className="p-4 lg:p-6">
        <Card className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-4 p-6 text-center">
            <div className="relative flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <FileDown className="h-6 w-6" />
              <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background">
                <Lock className="h-3 w-3" />
              </span>
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">Data Export</h2>
              <p className="text-sm text-muted-foreground">
                Download your customers, products, sales, inventory, returns and loyalty data as CSV, Excel, JSON or PDF. Available on the
                Professional and Enterprise plans.
              </p>
            </div>
            {can('subscription.view') ? (
              <Button asChild>
                <Link to="/subscription">
                  <Sparkles />
                  Upgrade
                </Link>
              </Button>
            ) : (
              <p className="text-sm font-medium">Ask your store owner to upgrade the subscription.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const columns: Column<ExportJob>[] = [
    {
      key: 'type',
      mobile: 'title',
      header: 'Export',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{catalog?.datasets.find((item) => item.key === row.type)?.label ?? row.type}</p>
          <p className="truncate text-xs text-muted-foreground">{row.filterSummary}</p>
        </div>
      ),
    },
    { key: 'format', header: 'Format', cell: (row) => <span className="uppercase">{row.format}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'completed' ? 'success' : 'destructive'} className="gap-1">
          {row.status === 'completed' ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {row.status === 'completed' ? 'Completed' : 'Failed'}
        </Badge>
      ),
    },
    { key: 'rows', header: 'Rows', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{row.rowCount.toLocaleString()}</span> },
    { key: 'size', header: 'Size', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{formatBytes(row.byteSize)}</span> },
    { key: 'by', mobile: 'meta', header: 'By', cell: (row) => <span className="text-sm text-muted-foreground">{row.requestedByNameSnapshot}</span> },
    {
      key: 'when',
      mobile: 'meta',
      header: 'When',
      cell: (row) => <span className="text-sm text-muted-foreground">{new Date(row.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>,
    },
  ];

  const customIncomplete = dataset?.dated && preset === 'custom' && (!from || !to);

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader title="Data export" description="Download your business data. Files are generated on request and never stored." />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">What do you want to export?</CardTitle>
            <CardDescription>{dataset?.description ?? 'Choose a dataset.'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Data</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose data" />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.datasets ?? []).map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Format</Label>
                <Select value={format} onValueChange={(value) => setFormat(value as typeof format)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.formats ?? []).map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{catalog?.formats.find((item) => item.key === format)?.description}</p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Date range</Label>
                {dataset?.dated ? (
                  <Select value={preset} onValueChange={setPreset}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESETS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">Not applicable - this export is a current snapshot.</p>
                )}
              </div>
              {isAdmin && (
                <div className="space-y-1.5">
                  <Label>Branch</Label>
                  <Select value={branch} onValueChange={(value) => setBranch(value as 'current' | 'all')}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="current">This branch</SelectItem>
                      <SelectItem value="all">All branches</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {dataset?.dated && preset === 'custom' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="export-from">From</Label>
                  <Input id="export-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="export-to">To</Label>
                  <Input id="export-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => run.mutate()} disabled={run.isPending || !dataset || Boolean(customIncomplete)} loading={run.isPending}>
                <Download />
                {run.isPending ? 'Preparing…' : 'Export data'}
              </Button>
              {customIncomplete && <span className="text-xs text-destructive">Choose both dates for a custom range.</span>}
              {catalog && (
                <span className={cn('text-xs text-muted-foreground')}>
                  Up to {catalog.limits.rows.toLocaleString()} rows ({catalog.limits.pdfRows.toLocaleString()} for PDF).
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Formats</CardTitle>
            <CardDescription>All exports respect your branch access.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(catalog?.formats ?? []).map((item) => (
              <div key={item.key} className="rounded-md border px-3 py-2">
                <p className="font-medium">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent exports</CardTitle>
          <CardDescription>A log of what was exported. Files are not kept - run an export again to download it.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={history?.items ?? []}
            rowKey={(row) => row._id}
            loading={historyLoading}
            emptyTitle="No exports yet"
            emptyDescription="Exports you run appear here."
          />
        </CardContent>
      </Card>
    </div>
  );
}
