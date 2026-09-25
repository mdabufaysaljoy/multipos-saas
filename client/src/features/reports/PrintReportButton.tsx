import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, getDownload } from '@/api/client';
import { saveBlob } from '@/lib/download';

/**
 * Prints the report on screen: the server renders the same figures as a PDF,
 * through the same writer the data export uses, so a printed report and an
 * exported dataset look like one product.
 *
 * It is not a data export: it needs nothing beyond the permission and the plan
 * feature that opened the report itself.
 */
export function PrintReportButton({ path, params, disabled }: { path: string; params: Record<string, unknown>; disabled?: boolean }) {
  const print = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await getDownload(path, params);
      saveBlob(blob, filename);
    },
    onError: (error) => toast.error('The report could not be printed', { description: error instanceof ApiError ? error.message : 'Please try again.' }),
  });

  return (
    <Button variant="outline" disabled={disabled} loading={print.isPending} onClick={() => print.mutate()}>
      <Printer />
      Print / PDF
    </Button>
  );
}
