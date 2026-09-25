import type { Response } from 'express';
import { StoreModel } from '../../models/Store';
import { TenantModel } from '../../models/Tenant';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import type { TenantContext } from '../../types/express';
import type { ExportColumn, ExportSection } from '../../modules/exports/export.datasets';
import { EXPORT_FORMATS, formatDay, writePdf, type ExportMeta } from '../../modules/exports/export.formats';

/**
 * Printing a report.
 *
 * This is NOT the data export. Data export is a paid feature that hands over
 * rows of the underlying data; this hands back a PDF of the report the user is
 * already looking at, so it is gated exactly as that report is - the same
 * permission, the same plan feature - and it produces no other format.
 *
 * The PDF itself is written by the export module's own writer, so a printed
 * report and an exported dataset look like the same product, and money, dates
 * and formula-guarding are handled in one place.
 */

export interface PrintableSection {
  key: string;
  label: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
}

export interface PrintableReport {
  /** "Advanced Analytics", "Sales & profit"… */
  title: string;
  rangeLabel: string;
  /** The figures the page shows as cards, printed as the first table. */
  summary: { label: string; value: string }[];
  sections: PrintableSection[];
}

const summarySection = (rows: { label: string; value: string }[]): ExportSection => ({
  key: 'summary',
  label: 'Summary',
  columns: [
    { key: 'label', label: 'Figure', type: 'text' },
    { key: 'value', label: 'Value', type: 'text' },
  ],
  rows: async function* () {
    for (const row of rows) yield row;
  },
});

const asSection = (section: PrintableSection): ExportSection => ({
  key: section.key,
  label: section.label,
  columns: section.columns,
  rows: async function* () {
    for (const row of section.rows) yield row;
  },
});

/**
 * Streams the report as a PDF download. Sections with no rows are left out: a
 * printed report should be what happened, not a list of empty tables.
 */
export async function streamReportPdf(ctx: TenantContext, res: Response, report: PrintableReport): Promise<{ rows: number; bytes: number }> {
  const [store, tenant] = await Promise.all([
    StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('name currency').lean(),
    TenantModel.findById(ctx.tenantId).select('name').lean(),
  ]);
  if (!store) throw ApiError.notFound('Store not found');

  const generatedAt = new Date();
  const meta: ExportMeta = {
    datasetKey: 'report',
    datasetLabel: report.title,
    storeName: store.name,
    workspaceName: tenant?.name ?? '',
    rangeLabel: report.rangeLabel,
    filterSummary: `Branch: ${store.name} · Printed ${formatDay(generatedAt)}`,
    generatedAt,
    generatedBy: ctx.userName,
    currency: store.currency,
  };

  const sections: ExportSection[] = [summarySection(report.summary), ...report.sections.filter((section) => section.rows.length > 0).map(asSection)];

  const { contentType, extension } = EXPORT_FORMATS.pdf;
  const stamp = generatedAt.toISOString().slice(0, 10);
  const filename = `${report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${stamp}.${extension}`;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  try {
    const result = await writePdf(res, sections, meta);
    if (!res.writableEnded) res.end();
    return result;
  } catch (error) {
    logger.error('Report print failed', { title: report.title, error: String(error) });
    if (res.headersSent) {
      // The download already started; end it rather than leaving the browser hanging.
      res.end();
      return { rows: 0, bytes: 0 };
    }
    throw ApiError.internal('The report could not be printed. Please try again.');
  }
}

/** Money columns are minor units; the writer divides by 100 once. */
export const money = (key: string, label: string): ExportColumn => ({ key, label, type: 'money' });
export const number = (key: string, label: string): ExportColumn => ({ key, label, type: 'number' });
export const text = (key: string, label: string): ExportColumn => ({ key, label, type: 'text' });
