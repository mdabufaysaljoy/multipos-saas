import type { Document, Types } from 'mongoose';

export interface BaseDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** Mixin for tenant-scoped documents. Every query MUST filter on tenantId. */
export interface TenantScoped {
  tenantId: Types.ObjectId;
}

export interface StoreScoped extends TenantScoped {
  storeId: Types.ObjectId;
}

export interface SoftDeletable {
  deletedAt: Date | null;
}
