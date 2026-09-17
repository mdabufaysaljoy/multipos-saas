import { z } from 'zod';
import { POS_PRODUCT_CODE_PATTERN } from '../../config/verticals';
import { POS_PRODUCT_ICONS, POS_PRODUCT_STATUSES } from '../../models/PosProduct';

const code = z.string().trim().regex(POS_PRODUCT_CODE_PATTERN, 'Use 2-32 lowercase letters, digits or underscores, starting with a letter');

export const posProductParams = z.object({ code }).strict();

const configuration = z
  .object({
    sortOrder: z.number().int().min(0).max(1000),
    highlights: z.array(z.string().trim().min(1).max(80)).max(6),
  })
  .partial()
  .strict();

const editable = {
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500),
  status: z.enum(POS_PRODUCT_STATUSES),
  icon: z.enum(POS_PRODUCT_ICONS),
  configuration,
};

/** Strict: counts, module availability, ids and timestamps are server facts, not inputs. */
export const createPosProductSchema = z
  .object({
    code,
    name: editable.name,
    description: editable.description.optional(),
    status: editable.status.optional(),
    icon: editable.icon.optional(),
    configuration: configuration.optional(),
  })
  .strict();

/** The code is deliberately absent: it is the product's stable identity. */
export const updatePosProductSchema = z
  .object(editable)
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');
