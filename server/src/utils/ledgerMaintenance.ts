import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The wallet ledger is immutable: rows are never updated or deleted by the
 * application. The only exceptions are explicit maintenance jobs (a migration
 * adding descriptive fields to old rows, a development seed reset), which run
 * inside this context and nowhere else.
 */
const maintenance = new AsyncLocalStorage<{ reason: string }>();

export function withLedgerMaintenance<T>(reason: string, work: () => Promise<T>): Promise<T> {
  return maintenance.run({ reason }, work);
}

export const ledgerMaintenanceActive = () => Boolean(maintenance.getStore());
