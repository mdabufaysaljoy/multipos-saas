import { PassThrough, type Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { BRANDING } from '../../config/branding';
import type { ExportColumn, ExportSection } from './export.datasets';
import { PDF_ROW_LIMIT, ROW_LIMIT } from './export.limits';

/**
 * Streaming writers for the four export formats.
 *
 * Rules that apply to all of them:
 *  - money is stored in minor units and converted ONCE (value / 100), never
 *    calculated on;
 *  - dates are printed in the business timezone, named in the header, so a
 *    spreadsheet is unambiguous;
 *  - any text cell that a spreadsheet could read as a formula is neutralised.
 */
export type ExportFormat = 'csv' | 'xlsx' | 'json' | 'pdf';

export interface ExportMeta {
  datasetLabel: string;
  datasetKey: string;
  storeName: string;
  workspaceName: string;
  rangeLabel: string | null;
  filterSummary: string;
  generatedAt: Date;
  generatedBy: string;
  currency: string;
}

export class ExportTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`This export is larger than ${limit.toLocaleString('en-US')} rows. Narrow the date range and try again.`);
    this.name = 'ExportTooLargeError';
  }
}

const TZ = BRANDING.timezone;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-09-23 14:05` in the business timezone. */
export function formatDateTime(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(value)
    .reduce<Record<string, string>>((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export const formatDay = (value: Date) => {
  const text = formatDateTime(value);
  const [y, m, d] = text.slice(0, 10).split('-');
  return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
};

const asDate = (value: unknown): Date | null => {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(value);
  return null;
};

/** Minor units → a plain 2-decimal number (e.g. 199000 → 1990.00). */
export const moneyValue = (value: unknown) => Math.round(Number(value ?? 0)) / 100;

/**
 * Spreadsheet formula injection: Excel / Sheets / LibreOffice execute a cell
 * that starts with = + - @ (or a leading tab/CR). A leading apostrophe keeps
 * the text visible and inert.
 */
export const neutralizeFormula = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

const textValue = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const date = asDate(value);
  if (date) return formatDateTime(date);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

/** The value a CSV/PDF cell shows for a column. */
export function cellText(row: Record<string, unknown>, column: ExportColumn): string {
  const raw = row[column.key];
  if (column.type === 'money') return moneyValue(raw).toFixed(2);
  if (column.type === 'number') return raw === null || raw === undefined ? '' : String(raw);
  if (column.type === 'date') {
    const date = asDate(raw);
    return date ? formatDateTime(date) : '';
  }
  return neutralizeFormula(textValue(raw));
}

const headerLines = (meta: ExportMeta) => [
  `${meta.workspaceName} - ${meta.storeName}`,
  `${meta.datasetLabel}${meta.rangeLabel ? ` - ${meta.rangeLabel}` : ''}`,
  `Generated ${formatDateTime(meta.generatedAt)} (${TZ}) by ${meta.generatedBy}`,
  meta.filterSummary,
];

export interface WriteResult {
  rows: number;
  bytes: number;
}

/** Counts bytes as they pass through, for the export history record. */
function counted(out: Writable) {
  let bytes = 0;
  return {
    write(chunk: string | Buffer) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      bytes += buffer.length;
      return out.write(buffer);
    },
    get bytes() {
      return bytes;
    },
  };
}

const csvCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

export async function writeCsv(out: Writable, sections: ExportSection[], meta: ExportMeta): Promise<WriteResult> {
  const sink = counted(out);
  // BOM: Excel then reads UTF-8 (Bengali, ৳) correctly.
  sink.write('﻿');
  for (const line of headerLines(meta)) if (line) sink.write(`${csvCell(line)}\r\n`);
  let rows = 0;
  for (const section of sections) {
    sink.write('\r\n');
    if (sections.length > 1) sink.write(`${csvCell(section.label)}\r\n`);
    sink.write(`${section.columns.map((column) => csvCell(column.label)).join(',')}\r\n`);
    for await (const row of section.rows()) {
      if (++rows > ROW_LIMIT) throw new ExportTooLargeError(ROW_LIMIT);
      sink.write(`${section.columns.map((column) => csvCell(cellText(row, column))).join(',')}\r\n`);
    }
  }
  return { rows, bytes: sink.bytes };
}

export async function writeJson(out: Writable, sections: ExportSection[], meta: ExportMeta): Promise<WriteResult> {
  const sink = counted(out);
  sink.write(
    `{\n  "exportType": ${JSON.stringify(meta.datasetKey)},\n  "generatedAt": ${JSON.stringify(meta.generatedAt.toISOString())},\n  "timezone": ${JSON.stringify(TZ)},\n  "workspace": ${JSON.stringify(meta.workspaceName)},\n  "store": ${JSON.stringify(meta.storeName)},\n  "range": ${JSON.stringify(meta.rangeLabel)},\n  "filters": ${JSON.stringify(meta.filterSummary)},\n  "currency": ${JSON.stringify(meta.currency)},\n  "sections": [\n`,
  );
  let rows = 0;
  let firstSection = true;
  for (const section of sections) {
    sink.write(`${firstSection ? '' : ',\n'}    { "key": ${JSON.stringify(section.key)}, "label": ${JSON.stringify(section.label)}, "columns": ${JSON.stringify(section.columns)}, "records": [`);
    firstSection = false;
    let firstRow = true;
    for await (const row of section.rows()) {
      if (++rows > ROW_LIMIT) throw new ExportTooLargeError(ROW_LIMIT);
      const record: Record<string, unknown> = {};
      for (const column of section.columns) {
        const raw = row[column.key];
        const date = asDate(raw);
        record[column.key] = column.type === 'money' ? moneyValue(raw) : date ? date.toISOString() : (raw ?? null);
      }
      sink.write(`${firstRow ? '\n      ' : ',\n      '}${JSON.stringify(record)}`);
      firstRow = false;
    }
    sink.write(firstRow ? '] }' : '\n    ] }');
  }
  sink.write('\n  ]\n}\n');
  return { rows, bytes: sink.bytes };
}

export async function writeXlsx(out: Writable, sections: ExportSection[], meta: ExportMeta): Promise<WriteResult> {
  // exceljs pipes into the stream it is given, so it must be a real one; the
  // bytes are counted on the way through to the response.
  let bytes = 0;
  const relay = new PassThrough();
  relay.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    out.write(chunk);
  });
  const relayed = new Promise<void>((resolve, reject) => {
    relay.on('end', resolve);
    relay.on('error', reject);
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: relay, useStyles: true });
  workbook.creator = meta.workspaceName;
  workbook.created = meta.generatedAt;

  let rows = 0;
  for (const section of sections) {
    // A streamed worksheet writes rows as they arrive, so the frozen header and
    // the column widths have to be declared up front - they cannot be set once
    // the rows are out. The title block is a fixed number of lines, so the
    // header row number is known in advance.
    const title = headerLines(meta).filter(Boolean);
    const sheet = workbook.addWorksheet(section.label.slice(0, 31) || 'Data', {
      views: [{ state: 'frozen', ySplit: title.length + 2 }],
    });
    sheet.columns = section.columns.map((column) => ({ width: column.type === 'date' ? 20 : column.type === 'text' ? 26 : 14 }));
    for (const line of title) sheet.addRow([line]).commit();
    sheet.addRow([]).commit();
    const header = sheet.addRow(section.columns.map((column) => column.label));
    header.font = { bold: true };
    header.commit();
    for await (const row of section.rows()) {
      if (++rows > ROW_LIMIT) throw new ExportTooLargeError(ROW_LIMIT);
      const values = section.columns.map((column) => {
        const raw = row[column.key];
        if (column.type === 'money') return moneyValue(raw);
        if (column.type === 'number') return raw === null || raw === undefined ? null : Number(raw);
        if (column.type === 'boolean') return raw ? 'Yes' : 'No';
        if (column.type === 'date') {
          const date = asDate(raw);
          // Written as text in the business timezone: a raw Date would be shown in the reader's own zone.
          return date ? formatDateTime(date) : '';
        }
        return neutralizeFormula(String(raw ?? ''));
      });
      const excelRow = sheet.addRow(values);
      section.columns.forEach((column, index) => {
        if (column.type === 'money') excelRow.getCell(index + 1).numFmt = '#,##0.00';
      });
      excelRow.commit();
    }
    sheet.commit();
  }
  await workbook.commit();
  await relayed;
  return { rows, bytes };
}

export async function writePdf(out: Writable, sections: ExportSection[], meta: ExportMeta): Promise<WriteResult> {
  const sink = counted(out);
  const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, bufferPages: true });
  document.on('data', (chunk: Buffer) => sink.write(chunk));
  const finished = new Promise<void>((resolve) => document.on('end', () => resolve()));

  const left = document.page.margins.left;
  const usable = document.page.width - left - document.page.margins.right;
  const bottom = document.page.height - document.page.margins.bottom - 24;

  document.fontSize(15).text(`${meta.workspaceName} - ${meta.storeName}`, { align: 'left' });
  document.moveDown(0.2).fontSize(12).text(`${meta.datasetLabel}${meta.rangeLabel ? ` - ${meta.rangeLabel}` : ''}`);
  document.fontSize(8).fillColor('#555').text(`Generated ${formatDateTime(meta.generatedAt)} (${TZ}) by ${meta.generatedBy}`);
  if (meta.filterSummary) document.text(meta.filterSummary);
  document.fillColor('#000').moveDown(0.6);

  let rows = 0;
  for (const section of sections) {
    const widths = section.columns.map((column) => (column.type === 'text' ? 2 : 1));
    const total = widths.reduce((sum, weight) => sum + weight, 0);
    const columnWidths = widths.map((weight) => (weight / total) * usable);

    const drawHeader = () => {
      document.fontSize(9).font('Helvetica-Bold');
      let x = left;
      section.columns.forEach((column, index) => {
        document.text(column.label, x + 2, document.y, { width: columnWidths[index] - 4, height: 12, ellipsis: true, lineBreak: false });
        x += columnWidths[index];
      });
      document.moveDown(0.3);
      document.moveTo(left, document.y).lineTo(left + usable, document.y).strokeColor('#999').stroke();
      document.moveDown(0.25);
      document.font('Helvetica').fontSize(8);
    };

    if (sections.length > 1) {
      if (document.y > bottom - 60) document.addPage();
      document.font('Helvetica-Bold').fontSize(11).text(section.label).moveDown(0.3);
    }
    let headerY = document.y;
    drawHeader();

    for await (const row of section.rows()) {
      if (++rows > PDF_ROW_LIMIT) throw new ExportTooLargeError(PDF_ROW_LIMIT);
      if (document.y > bottom) {
        document.addPage();
        headerY = document.y;
        drawHeader();
      }
      const y = document.y;
      let x = left;
      section.columns.forEach((column, index) => {
        const value = cellText(row, column);
        document.text(value, x + 2, y, {
          width: columnWidths[index] - 4,
          height: 11,
          ellipsis: true,
          lineBreak: false,
          align: column.type === 'money' || column.type === 'number' ? 'right' : 'left',
        });
        x += columnWidths[index];
      });
      document.y = y + 12;
    }
    void headerY;
    document.moveDown(0.8);
  }

  if (rows === 0) document.fontSize(10).text('No data found for the selected filters.');

  // Page numbers, once the total is known.
  const range = document.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    document.switchToPage(range.start + index);
    document
      .fontSize(8)
      .fillColor('#555')
      .text(`Page ${index + 1} of ${range.count}`, left, document.page.height - document.page.margins.bottom - 12, { width: usable, align: 'right' });
  }

  document.end();
  await finished;
  return { rows, bytes: sink.bytes };
}

export const EXPORT_FORMATS: Record<ExportFormat, { extension: string; contentType: string }> = {
  csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8' },
  xlsx: { extension: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8' },
  pdf: { extension: 'pdf', contentType: 'application/pdf' },
};
