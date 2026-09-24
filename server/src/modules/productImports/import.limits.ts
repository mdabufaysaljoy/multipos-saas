/**
 * Import ceilings.
 *
 * There is no queue or worker in this stack (see docs/DATA_EXPORT.md §1), so an
 * import runs inside the request. The numbers below are what one request can do
 * comfortably: the file is read into memory once, and each product is created
 * through the ordinary product service, which writes a product, its variants
 * and an opening-stock ledger entry each.
 */

/** Product rows (variants) in one file. Roughly 2,000 variants ≈ 6,000 documents. */
export const MAX_IMPORT_ROWS = 2_000;

/** Upload size. A 2,000-row xlsx from the product export is well under 1 MB. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/** How far into a file to look for the header row (the export's title block is 5 lines). */
export const MAX_SCANNED_HEADER_ROWS = 20;

/** Error rows kept with a job. Enough to fix a file; not a second copy of it. */
export const MAX_STORED_ERRORS = 200;

/** Imports per minute per user. Each one can create thousands of records. */
export const IMPORTS_PER_MINUTE = 5;

/** How long a validated, uncommitted import stays available to confirm. */
export const PENDING_IMPORT_TTL_MINUTES = 60;
