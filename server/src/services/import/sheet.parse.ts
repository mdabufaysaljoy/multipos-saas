import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { ApiError } from '../../utils/ApiError';
import { MAX_IMPORT_ROWS, MAX_SCANNED_HEADER_ROWS } from '../../modules/productImports/import.limits';
import { isIgnoredHeader, normalizeHeader, type ColumnRegistry } from './sheet.columns';

/**
 * Turning an uploaded spreadsheet into plain strings, for any vertical.
 *
 * The file is untrusted input: nothing in it is evaluated. A formula cell is
 * read as its stored result, never recalculated; macros are irrelevant because
 * only the workbook's cell data is read, and a `.xlsm` is refused by extension
 * before we get here.
 *
 * What the file MEANS is not decided here. This returns the cells a registry
 * asked for, keyed by field, with the line number they came from.
 */

export type ImportFormat = 'xlsx' | 'csv';

export interface ParsedRow<TField extends string = string> {
  /** 1-based line number IN THE UPLOADED FILE, so an error points at the row the user sees. */
  rowNumber: number;
  values: Partial<Record<TField, string>>;
}

export interface ParsedSheet<TField extends string = string> {
  format: ImportFormat;
  /** The headers as they appear in the file, in order. */
  headers: string[];
  /** Header -> field, for the mapping the UI shows. */
  mapping: { header: string; field: TField | null; ignored: boolean }[];
  headerRowNumber: number;
  rows: ParsedRow<TField>[];
  /** Rows that were read but had no content at all. */
  blankRows: number;
}

/** A cell as text. Formula cells give their cached result; nothing is evaluated. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const object = value as unknown as Record<string, unknown>;
    if ('text' in object && typeof object.text === 'string') return object.text;
    if ('richText' in object && Array.isArray(object.richText)) {
      return (object.richText as { text?: string }[]).map((part) => part.text ?? '').join('');
    }
    if ('result' in object) {
      const result = object.result;
      if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return String(result);
      return '';
    }
    if ('hyperlink' in object && typeof object.hyperlink === 'string') return String(object.text ?? object.hyperlink);
  }
  return '';
}

/**
 * Undoes the export's spreadsheet-injection guard.
 *
 * An export writes `'=1+1` so Excel cannot execute the cell. Importing that
 * same file back must restore `=1+1` rather than storing the apostrophe in a
 * product name. Only the characters the exporter neutralises are unwrapped.
 */
const unescapeFormulaGuard = (text: string): string => (/^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text);

const rowCells = (row: ExcelJS.Row, width: number): string[] => {
  const cells: string[] = [];
  for (let index = 1; index <= width; index += 1) cells.push(cellText(row.getCell(index).value).trim());
  return cells;
};

export function formatFromFilename(filename: string): ImportFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

async function readWorksheet(buffer: Buffer, format: ImportFormat): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    if (format === 'csv') {
      return await workbook.csv.read(Readable.from([buffer]));
    }
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw ApiError.badRequest(
      format === 'csv' ? 'That CSV file could not be read. Save it as UTF-8 CSV and try again.' : 'That Excel file could not be read. Save it as .xlsx and try again.',
    );
  }
  // An export writes one sheet per section; the first one carries the items.
  const sheet = workbook.worksheets[0];
  if (!sheet) throw ApiError.badRequest('The file has no sheets');
  return sheet;
}

/**
 * Finds the header row.
 *
 * A file straight from an export starts with a title block (workspace, dataset,
 * generated-at, filters) and a blank line before the headers, so the first rows
 * are scanned for the row that names the most import columns. This is what
 * makes "export -> edit -> import" work with no manual tidying.
 */
function findHeaderRow<TField extends string>(sheet: ExcelJS.Worksheet, width: number, registry: ColumnRegistry<TField>) {
  let best = { rowNumber: 0, cells: [] as string[], score: 0 };
  const last = Math.min(sheet.rowCount, MAX_SCANNED_HEADER_ROWS);
  for (let rowNumber = 1; rowNumber <= last; rowNumber += 1) {
    const cells = rowCells(sheet.getRow(rowNumber), width);
    const score = registry.headerScore(cells);
    if (score > best.score) best = { rowNumber, cells, score };
    // Every required column found: this is the header row, stop looking.
    if (score >= registry.requiredFields.length && cells.filter((cell) => registry.fieldForHeader(cell)).length >= registry.requiredFields.length) break;
  }
  return { rowNumber: best.rowNumber, cells: best.cells };
}

export async function parseSheet<TField extends string>(
  buffer: Buffer,
  format: ImportFormat,
  registry: ColumnRegistry<TField>,
): Promise<ParsedSheet<TField>> {
  const sheet = await readWorksheet(buffer, format);
  const width = Math.max(sheet.columnCount, 1);
  const header = findHeaderRow(sheet, width, registry);
  if (header.rowNumber === 0) {
    throw ApiError.badRequest(`The file has no recognisable header row. It needs the columns: ${registry.requiredLabels.join(', ')}.`);
  }

  const headers = header.cells;
  const mapping = headers
    .map((text) => ({ header: text, field: registry.fieldForHeader(text), ignored: isIgnoredHeader(text) }))
    .filter((entry) => entry.header !== '');

  // A field may be named only once; two "Price" columns would be a silent guess.
  const seen = new Map<TField, string>();
  for (const entry of mapping) {
    if (!entry.field) continue;
    const previous = seen.get(entry.field);
    if (previous) throw ApiError.badRequest(`The file has two columns for the same field: "${previous}" and "${entry.header}".`);
    seen.set(entry.field, entry.header);
  }

  const missing = registry.requiredFields.filter((field) => !seen.has(field));
  if (missing.length > 0) {
    const labels = missing.map((field) => registry.columns.find((column) => column.field === field)?.label ?? field);
    throw ApiError.badRequest(`Import cannot continue. Missing required columns: ${labels.join(', ')}.`, { missingColumns: labels });
  }

  // Column index (1-based) per field, taken from the header row.
  const columnOf = new Map<TField, number>();
  headers.forEach((text, index) => {
    const field = registry.fieldForHeader(text);
    if (field && !columnOf.has(field)) columnOf.set(field, index + 1);
  });

  const rows: ParsedRow<TField>[] = [];
  let blankRows = 0;
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values: Partial<Record<TField, string>> = {};
    let hasContent = false;
    for (const [field, column] of columnOf) {
      const text = unescapeFormulaGuard(cellText(row.getCell(column).value).trim());
      if (text !== '') hasContent = true;
      values[field] = text;
    }
    if (!hasContent) {
      blankRows += 1;
      continue;
    }
    if (rows.length >= MAX_IMPORT_ROWS) {
      throw ApiError.badRequest(
        `This file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows. Split it into smaller files and import them one after another.`,
        { maxRows: MAX_IMPORT_ROWS },
      );
    }
    rows.push({ rowNumber, values });
  }

  if (rows.length === 0) throw ApiError.badRequest('The file has headers but no rows.');

  return { format, headers: headers.filter(Boolean), mapping, headerRowNumber: header.rowNumber, rows, blankRows };
}

export { normalizeHeader };
