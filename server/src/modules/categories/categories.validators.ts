import { z } from 'zod';
import { objectId, searchSchema } from '../common/common.validators';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').max(120),
  description: z.string().trim().max(500).optional().default(''),
  parentId: objectId.nullable().optional(),
  isActive: z.boolean().default(true),
});

export const updateCategorySchema = createCategorySchema.partial();

export const listCategoriesSchema = searchSchema.extend({
  includeInactive: z.coerce.boolean().default(false),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ListCategoriesInput = z.infer<typeof listCategoriesSchema>;
