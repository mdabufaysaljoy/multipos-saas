import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileSpreadsheet, Upload, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { ApiError } from '@/api/client';
import { formatMoney } from '@/lib/money';
import { useAuth } from '@/hooks/useAuth';
import type { PosImportJob, PosImportPreview, PosImportResult, posImportsApi } from '@/api/posImports';

const ACCEPT = '.xlsx,.csv';
const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

interface PosImportScreenProps {
  title: string;
  description: string;
  api: ReturnType<typeof posImportsApi>;
  /** Where "back" goes, and what the cache key of this vertical is. */
  backTo: { href: string; label: string };
  invalidate: string;
}

/**
 * Bulk import for Super Shop, Pharmacy and Restaurant.
 *
 * Choose a file -> validate and preview -> confirm. Nothing is created until
 * the preview is confirmed, and the server re-checks everything shown here; the
 * columns and the wording come from that vertical's own registry, so this
 * screen never hard-codes what a file may contain.
 */
export function PosImportScreen({ title, description, api, backTo, invalidate }: PosImportScreenProps) {
  const queryClient = useQueryClient();
  const { activeStore } = useAuth();
  const currency = activeStore?.currency ?? 'BDT';
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<PosImportPreview | null>(null);
  const [result, setResult] = React.useState<PosImportResult | null>(null);
  const [showErrors, setShowErrors] = React.useState(false);

  const { data: catalog } = useQuery({ queryKey: [invalidate, 'import', 'columns'], queryFn: api.columns, retry: false });
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: [invalidate, 'import', 'history'],
    queryFn: () => api.history({ limit: 10 }),
    retry: false,
  });

  const noun = preview?.noun ?? catalog?.noun ?? { one: 'item', many: 'items' };

  const reset = (keepFile = false) => {
    setPreview(null);
    setResult(null);
    setShowErrors(false);
    if (!keepFile) {
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const validate = useMutation({
    mutationFn: async () => {
      if (!file) throw new ApiError('VALIDATION_ERROR', 'Choose a file first.', 400);
      return api.preview(file);
    },
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setShowErrors(data.summary.invalidRows > 0 && data.summary.validRows === 0);
    },
    onError: (error) => {
      setPreview(null);
      toast.error('The file could not be read', { description: message(error, 'Please try again.') });
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!preview) throw new ApiError('VALIDATION_ERROR', 'Validate a file first.', 400);
      return api.commit(preview.importId, { skipInvalidRows: preview.summary.invalidRows > 0 });
    },
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: [invalidate] });
      toast.success('Import finished', { description: `${data.summary.itemsCreated} ${noun.many} created.` });
    },
    onError: (error) => {
      toast.error('The import failed', { description: message(error, 'Please try again.') });
      void queryClient.invalidateQueries({ queryKey: [invalidate, 'import', 'history'] });
    },
  });

  const historyColumns: Column<PosImportJob>[] = [
    {
      key: 'file',
      mobile: 'title',
      header: 'File',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{row.filename || 'Import'}</p>
          <p className="truncate text-xs text-muted-foreground">{row.requestedByNameSnapshot}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'completed' ? 'success' : row.status === 'failed' ? 'destructive' : 'secondary'}>
          {row.status === 'completed' ? 'Completed' : row.status === 'failed' ? 'Failed' : 'Cancelled'}
        </Badge>
      ),
    },
    {
      key: 'rows',
      header: 'Rows',
      className: 'text-right',
      headerClassName: 'text-right',
      cell: (row) => (
        <span className="tabular">
          {row.rowsImported} / {row.totalRows}
        </span>
      ),
    },
    {
      key: 'when',
      mobile: 'meta',
      header: 'When',
      cell: (row) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.createdAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </span>
      ),
    },
  ];

  const summary = preview?.summary;
  const maxMb = catalog ? Math.round(catalog.limits.maxBytes / 1024 / 1024) : 5;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button variant="outline" asChild>
            <Link to={backTo.href}>
              <ArrowLeft />
              {backTo.label}
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">1. Choose a file</CardTitle>
            <CardDescription>
              Excel (.xlsx) or CSV (.csv), up to {(catalog?.limits.maxRows ?? 2000).toLocaleString()} rows and {maxMb} MB. Nothing is created until you confirm.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                reset(true);
              }}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} disabled={validate.isPending || commit.isPending}>
                <Upload />
                Choose file
              </Button>
              {file ? (
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{file.name}</span>
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => reset()} aria-label="Remove file">
                    <X className="h-4 w-4" />
                  </button>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">No file selected.</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => validate.mutate()} disabled={!file || validate.isPending || commit.isPending} loading={validate.isPending}>
                {validate.isPending ? 'Checking…' : 'Validate & preview'}
              </Button>
              <span className="text-xs text-muted-foreground">A category the file names is created with the {noun.one}.</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Columns</CardTitle>
            <CardDescription>Headers are matched by name; order does not matter.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {(catalog?.columns ?? []).map((column) => (
                <li key={column.field}>
                  <span className="font-medium">{column.label}</span>{' '}
                  {column.required ? <Badge variant="destructive">Required</Badge> : <Badge variant="secondary">Optional</Badge>}
                  <span className="block text-xs text-muted-foreground">{column.hint}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {summary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">2. What will be created</CardTitle>
            <CardDescription>
              {summary.validRows} of {summary.totalRows} row(s) are ready
              {summary.invalidRows > 0 ? `, ${summary.invalidRows} cannot be imported` : ''}
              {summary.categoriesToCreate > 0 ? `, ${summary.categoriesToCreate} new categor${summary.categoriesToCreate === 1 ? 'y' : 'ies'}` : ''}
              {summary.withOpeningStock > 0 ? `, ${summary.withOpeningStock} with opening stock` : ''}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {preview!.unmappedHeaders.length > 0 && (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                Ignored columns: {preview!.unmappedHeaders.join(', ')}
              </p>
            )}

            <ul className="divide-y text-sm">
              {preview!.preview.map((row) => (
                <li key={row.rowNumber} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      Row {row.rowNumber} · {[row.detail, row.category].filter(Boolean).join(' · ')}
                      {row.openingQuantity > 0 ? ` · ${row.openingQuantity} in opening stock` : ''}
                    </p>
                  </div>
                  <span className="tabular shrink-0 font-medium">{formatMoney(row.priceMinor, currency)}</span>
                </li>
              ))}
            </ul>
            {summary.validRows > preview!.preview.length && (
              <p className="text-xs text-muted-foreground">…and {summary.validRows - preview!.preview.length} more.</p>
            )}

            {summary.invalidRows > 0 && (
              <div className="space-y-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setShowErrors((open) => !open)}>
                  <AlertTriangle />
                  {showErrors ? 'Hide' : 'Show'} the {summary.invalidRows} row(s) that cannot be imported
                </Button>
                {showErrors && (
                  <ul className="scrollbar-thin max-h-64 divide-y overflow-y-auto rounded-md border text-sm">
                    {preview!.errors.map((error, index) => (
                      <li key={`${error.rowNumber}-${index}`} className="px-3 py-2">
                        <span className="font-medium">Row {error.rowNumber}</span>
                        {error.itemName ? ` · ${error.itemName}` : ''} — <span className="text-destructive">{error.message}</span>
                        <span className="block text-xs text-muted-foreground">Column: {error.field}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => commit.mutate()} disabled={summary.validRows === 0 || commit.isPending} loading={commit.isPending}>
                {summary.invalidRows > 0 ? `Import the ${summary.validRows} valid row(s)` : `Import ${summary.validRows} ${noun.many}`}
              </Button>
              <Button variant="outline" onClick={() => reset()} disabled={commit.isPending}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-success" />
              Import finished
            </CardTitle>
            <CardDescription>
              {result.summary.itemsCreated} {noun.many} created from {result.summary.rowsProcessed} row(s)
              {result.summary.rowsSkipped > 0 ? `, ${result.summary.rowsSkipped} skipped` : ''}
              {result.summary.rowsFailed > 0 ? `, ${result.summary.rowsFailed} failed` : ''}.
            </CardDescription>
          </CardHeader>
          {(result.failures.length > 0 || result.stopped) && (
            <CardContent className="space-y-2">
              {result.stopped && <p className="text-sm text-destructive">{result.stopped}</p>}
              <ul className="divide-y text-sm">
                {result.failures.map((failure, index) => (
                  <li key={`${failure.itemName}-${index}`} className="py-1.5">
                    <span className="font-medium">{failure.itemName}</span>{' '}
                    <span className="text-xs text-muted-foreground">(row {failure.rowNumbers.join(', ')})</span>
                    <span className="block text-destructive">{failure.message}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent imports</CardTitle>
        </CardHeader>
        <DataTable
          columns={historyColumns}
          rows={history?.items ?? []}
          rowKey={(row) => row._id}
          loading={historyLoading}
          emptyTitle="No imports yet"
          emptyDescription="Uploaded files are never stored; only what they created is kept."
        />
      </Card>
    </div>
  );
}
