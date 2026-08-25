import * as React from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableSkeleton, EmptyState, ErrorState } from '@/components/states';
import type { PageMeta } from '@/types/api';
import { cn } from '@/lib/utils';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Renders the cell. Keep formatting here, not in the data layer. */
  cell: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  meta?: PageMeta;
  onPageChange?: (page: number) => void;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  meta,
  onPageChange,
  onRowClick,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyAction,
  className,
}: DataTableProps<T>) {
  /**
   * A row-level click must not fire when the click actually landed on an
   * interactive control inside the row. Without this guard, an action button
   * (print, view, delete) triggers its own handler AND bubbles to the row -
   * which is what caused two dialogs to open at once from the sales table.
   */
  const handleRowClick = (event: React.MouseEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, label, [role="menuitem"], [data-no-row-click]')) {
      return;
    }
    onRowClick(row);
  };

  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading) return <TableSkeleton columns={columns.length} />;
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />;
  }

  return (
    <div className={cn('flex flex-col', className)}>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground',
                    column.headerClassName,
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? (event) => handleRowClick(event, row) : undefined}
                className={cn(
                  'border-b last:border-0 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-accent/50',
                )}
              >
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-4 py-2.5 align-middle', column.className)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {meta && meta.totalPages > 1 && onPageChange && (
        <div className="flex items-center justify-between border-t px-4 py-3 text-sm">
          <p className="text-muted-foreground">
            Page {meta.page} of {meta.totalPages} · {meta.total} record{meta.total === 1 ? '' : 's'}
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={meta.page <= 1}
              onClick={() => onPageChange(meta.page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={meta.page >= meta.totalPages}
              onClick={() => onPageChange(meta.page + 1)}
              aria-label="Next page"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
