import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLogModel } from '../../models/AuditLog';
import { logger } from '../../utils/logger';

export interface AuditInput {
  action: string;
  targetTenantId?: Types.ObjectId | null;
  targetStoreId?: Types.ObjectId | null;
  targetUserId?: Types.ObjectId | null;
  targetLabel?: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Records a sensitive action.
 *
 * Deliberately never throws: an audit failure must not roll back the business
 * operation that already succeeded. A write failure is logged loudly instead.
 */
export async function recordAudit(req: Request, input: AuditInput): Promise<void> {
  try {
    await AuditLogModel.create({
      actorId: req.auth?.id ?? null,
      actorNameSnapshot: req.auth?.name ?? 'system',
      actorRole: req.auth?.role ?? '',
      action: input.action,
      targetTenantId: input.targetTenantId ?? null,
      targetStoreId: input.targetStoreId ?? null,
      targetUserId: input.targetUserId ?? null,
      targetLabel: input.targetLabel ?? '',
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      ip: req.ip ?? '',
    });
  } catch (error) {
    logger.error('Failed to write an audit log entry', { action: input.action, error });
  }
}
