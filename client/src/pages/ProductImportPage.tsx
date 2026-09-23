import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileSpreadsheet, Upload, X } from 'lucide-react';
import { ApiError } from '@/api/client';
import { productImportApi } from '@/api/endpoints';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { DataTable, type Column } from '@/components/DataTable';
import { PageHeader } from '@/components/PageHeader';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { ImportPreview, ImportResult, ImportRowError, ProductImportJob } from '@/types/domain';

const ACCEPT = '.xlsx,.csv';

/**
 * Bulk product import.
 *
 * Choose a file → validate and preview → confirm. Nothing is created until the
 * preview is confirmed, and the server re-checks everything it shows here.
 */
export function ProductImportPage() {
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [file, setFile] = React.useState<File | null>(null);
  const [createMissingCategories, setCreateMissingCategories] = React.useState(false);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [showErrors, setShowErrors] = React.useState(false);

  const { data: catalog } = useQuery({ queryKey: ['product-import', 'columns'], queryFn: productImportApi.columns, retry: false });
  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: ['product-import', 'history'],
    queryFn: () => productImportApi.history({ limit: 10 }),
    retry: false,
  });

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
      return productImportApi.preview(file, { createMissingCategories });
    },
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setShowErrors(data.summary.invalidRows > 0 && data.summary.validRows === 0);
    },
    onError: (error) => {
      setPreview(null);
      toast.error('The file could not be read', { description: error instanceof ApiError ? error.message : 'Please try again.' });
    },
  });

  const commit = useMutation({
    mutationFn: async () => {
      if (!preview) throw new ApiError('VALIDATION_ERROR', 'Validate a file first.', 400);
      return productImportApi.commit(preview.importId, { skipInvalidRows: preview.summary.invalidRows > 0 });
    },
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['product-import', 'history'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.success('Import finished', { description: `${data.summary.productsCreated} products, ${data.summary.variantsCreated} variants created.` });
    },
    onError: (error) => {
      toast.error('The import failed', { description: error instanceof ApiError ? error.message : 'Please try again.' });
      void queryClient.invalidateQueries({ queryKey: ['product-import', 'history'] });
    },
  });

  const historyColumns: Column<ProductImportJob>[] = [
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
    { key: 'rows', header: 'Rows', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{row.rowsImported} / {row.totalRows}</span> },
    { key: 'products', header: 'Products', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{row.productsCreated}</span> },
    { key: 'variants', header: 'Variants', className: 'text-right', headerClassName: 'text-right', cell: (row) => <span className="tabular">{row.variantsCreated}</span> },
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
        title="Import products"
        description="Create many products and variants at once from an Excel or CSV file."
        actions={
          <Button variant="outline" asChild>
            <Link to="/catalogue">
              <ArrowLeft />
              Back to products
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">1. Choose a file</CardTitle>
            <CardDescription>
              Excel (.xlsx) or CSV (.csv), up to {catalog?.limits.maxRows.toLocaleString() ?? '2,000'} product rows and {maxMb} MB. A file exported from Data export can be
              edited and uploaded straight back.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                setFile(chosen);
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

            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={createMissingCategories}
                onCheckedChange={(checked) => {
                  setCreateMissingCategories(checked === true);
                  reset(true);
                }}
              />
              <span>
                Create categories that do not exist yet
                <span className="block text-xs text-muted-foreground">Off: a row naming an unknown category is reported as an error instead.</span>
              </span>
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => validate.mutate()} disabled={!file || validate.isPending || commit.isPending} loading={validate.isPending}>
                {validate.isPending ? 'Checking…' : 'Validate & preview'}
              </Button>
              <span className="text-xs text-muted-foreground">Nothing is created until you confirm.</span>
            </div>
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Columns</CardTitle>
            <CardDescription>Product, Variant and Selling price are required; the rest are optional.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(catalog?.columns ?? []).map((column) => (
              <div key={column.field} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {column.label}
                  {column.required && <Badge variant="secondary">Required</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{column.hint}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {preview && summary && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">2. Preview</CardTitle>
            <CardDescription>
              {preview.filename} · header row {preview.headerRow}
              {preview.unmappedHeaders.length > 0 && ` · ignored columns: ${preview.unmappedHeaders.join(', ')}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Total rows', value: summary.totalRows },
                { label: 'Valid rows', value: summary.validRows },
                { label: 'Invalid rows', value: summary.invalidRows, bad: summary.invalidRows > 0 },
                { label: 'Products to create', value: summary.productsToCreate },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className={cn('text-xl font-semibold tabular', item.bad && 'text-destructive')}>{item.value.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {summary.categoriesToCreate > 0 && (
              <p className="text-sm text-muted-foreground">
                {summary.categoriesToCreate} new categor{summary.categoriesToCreate === 1 ? 'y' : 'ies'} will be created: {preview.missingCategories.join(', ')}.
              </p>
            )}

            {summary.invalidRows > 0 && (
              <div className="flex flex-wrap items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">
                    {summary.invalidRows.toLocaleString()} row{summary.invalidRows === 1 ? '' : 's'} cannot be imported.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Fix them in the file and upload it again, or import the {summary.validRows.toLocaleString()} valid row
                    {summary.validRows === 1 ? '' : 's'} only.
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={() => setShowErrors((open) => !open)}>
                  {showErrors ? 'Hide errors' : 'View errors'}
                </Button>
              </div>
            )}

            {showErrors && <ErrorList errors={preview.errors} truncated={preview.errorsTruncated} />}

            {summary.validRows > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Variants</th>
                      <th className="px-3 py-2">Prices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.map((product) => (
                      <tr key={product.name} className="border-t align-top">
                        <td className="px-3 py-2 font-medium">{product.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">{product.category || '—'}</td>
                        <td className="px-3 py-2">
                          {product.variants.map((variant) => variant.name).join(', ')}
                          {product.variantCount > product.variants.length && ` +${product.variantCount - product.variants.length} more`}
                        </td>
                        <td className="px-3 py-2 tabular">
                          {product.variants.map((variant) => formatMoney(variant.sellingPriceMinor)).join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.summary.productsToCreate > preview.preview.length && (
                  <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                    Showing {preview.preview.length} of {preview.summary.productsToCreate} products.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={() => commit.mutate()}
                disabled={commit.isPending || summary.validRows === 0}
                loading={commit.isPending}
              >
                <CheckCircle2 />
                {summary.invalidRows > 0
                  ? `Import ${summary.validRows.toLocaleString()} valid row${summary.validRows === 1 ? '' : 's'}`
                  : `Import ${summary.productsToCreate.toLocaleString()} product${summary.productsToCreate === 1 ? '' : 's'}`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (preview) void productImportApi.cancel(preview.importId).catch(() => undefined);
                  reset();
                }}
                disabled={commit.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Import completed</CardTitle>
            <CardDescription>Imported products are immediately sellable at the till.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Products created', value: result.summary.productsCreated },
                { label: 'Variants created', value: result.summary.variantsCreated },
                { label: 'Rows imported', value: result.summary.rowsImported },
                { label: 'Rows skipped', value: result.summary.rowsSkipped + result.summary.rowsFailed, bad: result.summary.rowsSkipped + result.summary.rowsFailed > 0 },
              ].map((item) => (
                <div key={item.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{item.label}</p>
                  <p className={cn('text-xl font-semibold tabular', item.bad && 'text-destructive')}>{item.value.toLocaleString()}</p>
                </div>
              ))}
            </div>
            {result.stopped && <p className="text-sm text-destructive">{result.stopped}</p>}
            {result.failures.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Products that could not be created</p>
                {result.failures.map((failure) => (
                  <div key={`${failure.productName}-${failure.rowNumbers[0]}`} className="rounded-md border px-3 py-2 text-sm">
                    <p className="font-medium">
                      {failure.productName} <span className="text-xs font-normal text-muted-foreground">row {failure.rowNumbers.join(', ')}</span>
                    </p>
                    <p className="text-xs text-destructive">{failure.message}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link to="/catalogue">View products</Link>
              </Button>
              <Button variant="outline" onClick={() => reset()}>
                Import another file
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent imports</CardTitle>
          <CardDescription>Uploaded files are not kept - only the record of what each import created.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            columns={historyColumns}
            rows={history?.items ?? []}
            rowKey={(row) => row._id}
            loading={historyLoading}
            emptyTitle="No imports yet"
            emptyDescription="Imports you run appear here."
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ErrorList({ errors, truncated }: { errors: ImportRowError[]; truncated: boolean }) {
  return (
    <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border p-3">
      {errors.map((error) => (
        <div key={`${error.rowNumber}-${error.field}-${error.message}`} className="rounded-md border px-3 py-2 text-sm">
          <p className="font-medium">
            Row {error.rowNumber}
            {error.productName && <span className="font-normal text-muted-foreground"> · {error.productName}</span>}
            {error.variantName && <span className="font-normal text-muted-foreground"> · {error.variantName}</span>}
          </p>
          <p className="text-xs text-destructive">{error.message}</p>
        </div>
      ))}
      {truncated && <p className="text-xs text-muted-foreground">Only the first {errors.length} errors are shown.</p>}
    </div>
  );
}
