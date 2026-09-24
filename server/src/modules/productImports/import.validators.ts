import { z } from 'zod';
import { paginationSchema } from '../common/common.validators';

/**
 * The import body carries only choices about the import itself. It never
 * carries a workspace, branch, category id or product id - those come from the
 * authenticated context or are resolved by name inside it.
 */
export const previewImportSchema = z
  .object({
    // Multipart fields arrive as strings.
    createMissingCategories: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .default(false)
      .transform((value) => value === true || value === 'true'),
  })
  .strict();

export const commitImportSchema = z
  .object({
    skipInvalidRows: z.boolean().default(false),
  })
  .strict();

export const listImportsSchema = paginationSchema;

export type PreviewImportInput = z.infer<typeof previewImportSchema>;
export type CommitImportInput = z.infer<typeof commitImportSchema>;
