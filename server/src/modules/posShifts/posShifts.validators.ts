import { z } from 'zod';

const wholeMinor = z.number().int().min(0).max(100_000_000);

export const openPosShiftSchema = z
  .object({
    openingFloatMinor: wholeMinor,
    note: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const posCashMovementSchema = z
  .object({
    type: z.enum(['pay_in', 'pay_out']),
    amountMinor: wholeMinor.min(1),
    reason: z.string().trim().min(3).max(200),
  })
  .strict();

export const closePosShiftSchema = z
  .object({
    countedCashMinor: wholeMinor,
    note: z.string().trim().max(300).optional().default(''),
  })
  .strict();

export const listPosShiftsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['open', 'closed']).optional(),
});

export type OpenPosShiftInput = z.infer<typeof openPosShiftSchema>;
export type PosCashMovementInput = z.infer<typeof posCashMovementSchema>;
export type ClosePosShiftInput = z.infer<typeof closePosShiftSchema>;
export type ListPosShiftsInput = z.infer<typeof listPosShiftsSchema>;
