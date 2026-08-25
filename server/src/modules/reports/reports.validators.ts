import { z } from 'zod';
import { objectId } from '../common/common.validators';

export const RANGE_PRESETS = ['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'custom'] as const;

export const reportRangeSchema = z
  .object({
    preset: z.enum(RANGE_PRESETS).default('last7'),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    /** Bucket size for the trend chart. */
    granularity: z.enum(['day', 'week', 'month']).default('day'),
    cashierId: objectId.optional(),
    categoryId: objectId.optional(),
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
