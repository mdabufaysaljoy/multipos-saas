/**
 * The branch details a receipt is printed with, in every POS vertical.
 *
 * Mirrors `server/src/services/receipt/receiptStore.ts`. Each vertical renders
 * its own receipt content; the paper, the header, the logo and the configured
 * width are the same everywhere.
 */
export interface ReceiptStore {
  name: string;
  logoUrl: string | null;
  receiptLogoUrl: string | null;
  phone: string;
  email: string;
  address: string;
  currency: string;
  receipt: {
    headerText: string;
    footerText: string;
    returnPolicy: string;
    showLogo: boolean;
    showCashier: boolean;
    /** 48 / 57 / 58 / 78 / 80 / 88 mm. */
    paperWidthMm: number;
  };
  tax?: { enabled: boolean; label: string; rateBasisPoints: number; inclusive: boolean };
}
