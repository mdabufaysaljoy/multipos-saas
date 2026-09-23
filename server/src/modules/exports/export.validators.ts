import { z } from 'zod';
import { objectId, paginationSchema } from '../common/common.validators';
import { RANGE_PRESETS } from '../reports/reports.validators';
import { EXPORT_TYPES } from './export.datasets';

/**
 * The request may only name a dataset from the registry and a format - never a
 * collection, field, workspace or store. Branch scope mirrors the reports API
 * ("current" / "all" / a branch id) and is re-checked against the session.
 */
export const createExportSchema = z
  .object({
    type: z.enum(EXPORT_TYPES),
    format: z.enum(['csv', 'xlsx', 'json', 'pdf']),
    preset: z.enum(RANGE_PRESETS).default('last30'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    branch: z.union([z.literal('current'), z.literal('all'), objectId]).default('current'),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && (!data.from || !data.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'A custom range needs both a start and an end date' });
    }
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The end date must be after the start date' });
    }
  });

export const listExportsSchema = paginationSchema;

export type CreateExportInput = z.infer<typeof createExportSchema>;
