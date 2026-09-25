import { buildRegistry } from '../../services/import/sheet.columns';
import { parseSheet, type ImportFormat, type ParsedRow, type ParsedSheet } from '../../services/import/sheet.parse';
import { IMPORT_COLUMNS, normalizeHeader, type ImportField } from './import.columns';

/**
 * Clothing's product sheet, read by the shared parser.
 *
 * The parsing itself (header row inside an export's title block, formula-guard
 * unwrapping, duplicate columns, row ceiling) lives in
 * `services/import/sheet.parse` and is identical in every vertical; what is
 * Clothing's own is the column registry below.
 */
const registry = buildRegistry<ImportField>(IMPORT_COLUMNS);

export const parseProductSheet = (buffer: Buffer, format: ImportFormat): Promise<ParsedSheet<ImportField>> => parseSheet(buffer, format, registry);

export { formatFromFilename } from '../../services/import/sheet.parse';
export { normalizeHeader };
export type { ImportFormat, ParsedRow, ParsedSheet };
