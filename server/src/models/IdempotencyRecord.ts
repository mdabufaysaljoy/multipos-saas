import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

export const IDEMPOTENCY_STATUSES = ['processing', 'completed'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

/**
 * How long a finished record is kept, and therefore how long a retry still
 * replays instead of acting again.
 *
 * Twenty-four hours. A till retrying after a dropped connection, a cashier
 * reloading the page, or a client library backing off all happen within
 * seconds or minutes; a payment provider re-delivering a notification can take
 * hours. A day is comfortably longer than any of those and short enough that
 * the collection stays small. Shorter would let a late retry ring up a second
 * sale, which is the whole thing this exists to prevent.
 */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How long one claim is held before another request may take it over.
 *
 * Long enough for a slow checkout (pricing, stock, loyalty, payment rows) and
 * short enough that a crashed process does not leave a key stuck until its
 * retention expires.
 */
export const IDEMPOTENCY_LEASE_MS = 60 * 1000;

/**
 * One record per (scope, key): the durable memory of "this operation was
 * already asked for".
 *
 * IN MONGODB, NOT REDIS, deliberately. The sale it protects is a MongoDB
 * write, and the protection must not be weaker than the thing it protects: a
 * Redis restart would forget the key and let a retry ring up a second sale.
 * Redis is a cache in this system (Phase 1); this is a ledger.
 *
 * It stores no request body and no payment data - only a hash of the business
 * input, and the id of whatever the operation produced.
 */
export interface IdempotencyRecordDoc extends BaseDoc {
  /** `<tenantId>:<storeId|->:<operation>` - never the key alone, so two workspaces cannot collide. */
  scope: string;
  /** The client's key. Opaque, validated, bounded; never a credential. */
  key: string;
  /** sha256 of the canonicalised business input, so a reused key with different input is caught. */
  fingerprint: string;
  status: IdempotencyStatus;
  tenantId: Types.ObjectId;
  storeId: Types.ObjectId | null;
  operation: string;
  /** The document the operation created, for replaying the original result. */
  resultId: Types.ObjectId | null;
  /** Which collection `resultId` names, so a replay cannot read the wrong thing. */
  resultKind: string;
  /** Lease held while the operation runs. */
  claimedUntil: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
}

const schema = new Schema<IdempotencyRecordDoc>(
  {
    scope: { type: String, required: true },
    key: { type: String, required: true, maxlength: 200 },
    fingerprint: { type: String, required: true, maxlength: 64 },
    status: { type: String, enum: [...IDEMPOTENCY_STATUSES], required: true, default: 'processing' },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    operation: { type: String, required: true, maxlength: 60 },
    resultId: { type: Schema.Types.ObjectId, default: null },
    resultKind: { type: String, default: '' },
    claimedUntil: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

/**
 * THE concurrency guard.
 *
 * Two identical checkouts arriving at once both try to insert this pair; the
 * database lets exactly one through and the other is told the operation is
 * already in hand. A `findOne` followed by a `create` could not do that - both
 * would read "nothing there" and both would sell.
 */
schema.index({ scope: 1, key: 1 }, { unique: true });

/** Expired records are removed by MongoDB itself, so the collection cannot grow without bound. */
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyRecordModel = model<IdempotencyRecordDoc>('IdempotencyRecord', schema);
