import { z } from 'zod';
import { POS_PRODUCT_CODE_PATTERN } from '../../config/verticals';
import { objectId, optionalEmailAddress, optionalPhoneNumber } from '../common/common.validators';

/**
 * `.strict()`: the only things a client chooses are the name and the vertical.
 * An `accountId`, `ownerUserId`, `status` or anything else in the body is
 * rejected rather than silently ignored - ownership is decided on the server.
 */
export const createWorkspaceSchema = z
  .object({
    businessName: z.string().trim().min(2, 'Business name is required').max(160),
    // Only the shape is checked here. Whether it names an active POS product
    // with a module is decided against the catalog in the service.
    vertical: z.string().trim().regex(POS_PRODUCT_CODE_PATTERN, 'Unknown POS type'),
    /** How customers reach this business. Optional; the account's contact email is used when empty. */
    contactPhone: optionalPhoneNumber,
    contactEmail: optionalEmailAddress,
  })
  .strict();

export const workspaceParams = z.object({ workspaceId: objectId });

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * What an owner may change about a workspace. Strict: `accountId`, `ownerUserId`,
 * `vertical`/`businessType`, `status` and subscription fields are not writable
 * here - moving a workspace between accounts or verticals is not a profile edit.
 */
export const updateWorkspaceSchema = z
  .object({
    businessName: z.string().trim().min(2, 'Business name is required').max(160),
    contactEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email').max(160)]),
    contactPhone: z.string().trim().max(40),
    settings: z
      .object({
        timezone: z.string().trim().max(64).refine(isTimeZone, 'Unknown time zone'),
        locale: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, 'Use a locale such as en-BD'),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

/**
 * Cancelling one workspace's subscription. Strict: the workspace comes from the
 * verified route parameter and the account from the session, so an
 * `accountId`, `workspaceId` or `status` in the body is rejected.
 */
export const cancelWorkspaceSubscriptionSchema = z
  .object({
    /** false (the default) keeps access until the paid period ends; true ends it now. */
    immediate: z.boolean().default(false),
    reason: z.string().trim().max(300).optional().default(''),
  })
  .strict();

/** Actions that take no input. Strict, so nothing can ride along in the body. */
export const emptyBodySchema = z.object({}).strict();

export type CancelWorkspaceSubscriptionInput = z.infer<typeof cancelWorkspaceSubscriptionSchema>;
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
