import { Schema, model, type Types } from 'mongoose';
import type { BaseDoc } from './types';

/**
 * A registered device allowed to REPORT payment SMS to the platform.
 *
 * It is not an account and not a user: it holds a credential of its own, which
 * a platform admin can rotate or revoke without touching anybody's login. A
 * device can only ever report evidence - it can never move money, name an
 * account, or decide that a payment is verified. The backend matches what it
 * reports against payments the customer already created.
 *
 * The secret itself is never stored: only its SHA-256 hash, the same way
 * refresh tokens are held.
 */
export const DEVICE_STATUSES = ['active', 'revoked'] as const;
export type PaymentDeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface PaymentDeviceDoc extends BaseDoc {
  /** Stable public identifier the device sends with every event. */
  deviceId: string;
  label: string;
  /** SHA-256 of the device secret. The secret is shown once, at registration. */
  tokenHash: string;
  status: PaymentDeviceStatus;
  /** Which payment sources this device is trusted to report (e.g. bkash, nagad). */
  allowedProviders: string[];
  /** The merchant wallet numbers whose SMS this device carries. */
  merchantAccounts: string[];
  lastSeenAt: Date | null;
  lastEventAt: Date | null;
  eventsAccepted: number;
  eventsRejected: number;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  revokedBy: Types.ObjectId | null;
  revokedReason: string;
  createdBy: Types.ObjectId | null;
  createdByNameSnapshot: string;
}

const deviceSchema = new Schema<PaymentDeviceDoc>(
  {
    deviceId: { type: String, required: true, unique: true, trim: true, maxlength: 64 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    // Never selected by default: no ordinary read can return it.
    tokenHash: { type: String, required: true, select: false },
    status: { type: String, enum: [...DEVICE_STATUSES], default: 'active', index: true },
    allowedProviders: { type: [String], default: [] },
    merchantAccounts: { type: [String], default: [] },
    lastSeenAt: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
    eventsAccepted: { type: Number, default: 0 },
    eventsRejected: { type: Number, default: 0 },
    rotatedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    revokedReason: { type: String, default: '', maxlength: 300 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdByNameSnapshot: { type: String, default: '' },
  },
  { timestamps: true },
);

export const PaymentDeviceModel = model<PaymentDeviceDoc>('PaymentDevice', deviceSchema);
