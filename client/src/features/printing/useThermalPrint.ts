import * as React from 'react';
import { useThermalPrinterSettings } from './printerSettings';
import { ThermalPrintError, printThermalDocument, type ThermalPrintJob } from './thermalPrintService';

export type ThermalPrintStatus = 'idle' | 'printing' | 'printed' | 'failed';

/**
 * Print status for a dialog. `direct` tells the caller whether this computer is
 * set up for QZ Tray printing (otherwise the existing browser printing stays).
 * `print` never throws; it reports through `status` / `message`.
 */
export function useThermalPrint() {
  const settings = useThermalPrinterSettings();
  const [status, setStatus] = React.useState<ThermalPrintStatus>('idle');
  const [message, setMessage] = React.useState<string | null>(null);
  const busy = React.useRef(false);

  const print = React.useCallback(
    async (job: ThermalPrintJob) => {
      // One job at a time from a dialog: a double click never prints twice.
      if (busy.current) return false;
      busy.current = true;
      setStatus('printing');
      setMessage(null);
      try {
        const result = await printThermalDocument(job, settings);
        setStatus('printed');
        setMessage(`Printed on ${result.printer}`);
        return true;
      } catch (error) {
        setStatus('failed');
        setMessage(error instanceof ThermalPrintError ? error.message : 'Printing failed.');
        return false;
      } finally {
        busy.current = false;
      }
    },
    [settings],
  );

  const reset = React.useCallback(() => {
    setStatus('idle');
    setMessage(null);
  }, []);

  return { direct: settings.mode === 'direct', settings, status, message, print, reset };
}
