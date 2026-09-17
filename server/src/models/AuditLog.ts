import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * Append-only record of sensitive platform-admin actions.
 *
 * Written by `recordAudit` at the point of change, never edited afterwards, so
 * "who changed this tenant's subscription and when" always has an answer.
 */
export interface AuditLogDoc extends BaseDoc {
  actorId: Types.ObjectId | null;
  actorNameSnapshot: string;
  actorRole: string;
  action: string;
  targetTenantId: Types.ObjectId | null;
  targetStoreId: Types.ObjectId | null;
  targetUserId: Types.ObjectId | null;
  targetLabel: string;
  oldValue: unknown;
  newValue: unknown;
  ip: string;
}

const auditSchema = new Schema<AuditLogDoc>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorNameSnapshot: { type: String, default: 'system' },
    actorRole: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    targetTenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    targetStoreId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    targetLabel: { type: String, default: '' },
    oldValue: { type: Schema.Types.Mixed, default: null },
    newValue: { type: Schema.Types.Mixed, default: null },
    ip: { type: String, default: '' },
  },
  { timestamps: true },
);

auditSchema.index({ createdAt: -1 });

export const AuditLogModel = model<AuditLogDoc>('AuditLog', auditSchema);
