/**
 * Export safeguards (docs/DATA_EXPORT.md §5). Rows stream through a cursor, so
 * these caps protect the browser and the response time rather than server
 * memory: past them the request is refused with a clear message instead of
 * producing an unusable file.
 */
/** CSV / XLSX / JSON. */
export const ROW_LIMIT = 200_000;
/** PDF is a report format, not a database dump. */
export const PDF_ROW_LIMIT = 5_000;
/** Exports per minute, per signed-in user. */
export const EXPORTS_PER_MINUTE = 5;
