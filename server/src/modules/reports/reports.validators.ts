import { z } from 'zod';
import { objectId, calendarDate } from '../common/common.validators';

export const RANGE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom'] as const;

export const reportRangeSchema = z
  .object({
    preset: z.enum(RANGE_PRESETS).default('last7'),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
    /** Bucket size for the trend chart. */
    granularity: z.enum(['day', 'week', 'month']).default('day'),
    cashierId: objectId.optional(),
    categoryId: objectId.optional(),
    /**
     * Branch scope. "current" uses the active branch; "all" aggregates every
     * branch of the tenant and is restricted to admins by the service.
     */
    branch: z.union([z.literal('current'), z.literal('all'), objectId]).default('current'),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .superRefine((data, ctx) => {
    if (data.preset === 'custom' && (!data.from || !data.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'A custom range needs both a start and an end date' });
    }
    if (data.from && data.to && data.from > data.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'The end date must be after the start date' });
    }
  });

export type ReportRangeInput = z.infer<typeof reportRangeSchema>;

/**
 * The date range for a vertical's Advanced Analytics (Pharmacy, Supershop):
 * the same presets and custom-range rules as every other report, current branch.
 */
export const analyticsRangeSchema = z
  .object({
    preset: z.enum(RANGE_PRESETS).default('last7'),
    from: calendarDate.optional(),
    to: calendarDate.optional(),
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

export type AnalyticsRangeInput = z.infer<typeof analyticsRangeSchema>;

export const BREAKDOWN_DIMENSIONS = ['product', 'variant', 'category', 'brand'] as const;

/** One schema for every "group the sale lines by X" report. */
export const breakdownSchema = reportRangeSchema.innerType().extend({
  dimension: z.enum(BREAKDOWN_DIMENSIONS).default('product'),
  sortBy: z.enum(['quantity', 'revenue', 'profit']).default('quantity'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const inventoryReportSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  branch: z.union([z.literal('current'), z.literal('all'), objectId]).default('current'),
});

export type BreakdownInput = z.infer<typeof breakdownSchema>;
export type InventoryReportInput = z.infer<typeof inventoryReportSchema>;
