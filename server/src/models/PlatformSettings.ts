import { Schema, model } from 'mongoose';
import type { BaseDoc } from './types';

export interface PaymentInstruction {
  method: 'bkash' | 'nagad' | 'bank';
  label: string;
  accountNumber: string;
  accountName: string;
  steps: string[];
  isActive: boolean;
}

/**
 * Singleton holding platform-wide configuration a platform admin can edit at
 * runtime - notably the manual-payment instructions shown to customers during
 * an upgrade. These are deliberately NOT hardcoded: account numbers change, and
 * a redeploy should not be needed to change them.
 */
export interface PlatformSettingsDoc extends BaseDoc {
  key: string;
  paymentInstructions: PaymentInstruction[];
  supportEmail: string;
  supportPhone: string;
  /** Cost per SMS segment, in minor units. Set by the platform admin. */
  smsCostMinor: number;
  /** Cost per email, in minor units. Charged the same way as SMS. */
  emailCostMinor: number;
  /** Cost per AI request, in minor units. For AI services billed per use. */
  aiRequestCostMinor: number;
  /** Cost per GB-month of billed storage, in minor units. */
  storageGbMonthCostMinor: number;
  /**
   * SMTP credentials. `select: false` on the password keeps it out of every
   * ordinary query, and the tenant-facing API never returns this block at all.
   */
  /**
   * SMS gateway credentials.
   *
   * `apiKey` is `select: false` for the same reason the SMTP password is: it
   * must never ride along on an ordinary settings read, and no tenant-facing
   * response returns this block at all.
   */
  sms: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    senderId: string;
    enabled: boolean;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromName: string;
    fromEmail: string;
    enabled: boolean;
  };
  currency: string;
  /** Email digests to platform admins about payments needing attention. */
  paymentAlerts: {
    enabled: boolean;
    /** Sent in addition to every active platform administrator. */
    recipients: string[];
  };
}

const instructionSchema = new Schema<PaymentInstruction>(
  {
    method: { type: String, enum: ['bkash', 'nagad', 'bank'], required: true },
    label: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, default: '' },
    steps: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { _id: false },
);

const platformSettingsSchema = new Schema<PlatformSettingsDoc>(
  {
    // Fixed key so there is exactly one document.
    key: { type: String, default: 'platform', unique: true },
    paymentInstructions: { type: [instructionSchema], default: [] },
    supportEmail: { type: String, default: '' },
    supportPhone: { type: String, default: '' },
    smsCostMinor: { type: Number, default: 50, min: 0 },
    emailCostMinor: { type: Number, default: 0, min: 0 },
    aiRequestCostMinor: { type: Number, default: 0, min: 0 },
    storageGbMonthCostMinor: { type: Number, default: 0, min: 0 },
    sms: {
      provider: { type: String, default: 'alpha' },
      apiKey: { type: String, default: '', select: false },
      baseUrl: { type: String, default: 'https://api.sms.net.bd' },
      senderId: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
    },
    smtp: {
      host: { type: String, default: '' },
      port: { type: Number, default: 587 },
      secure: { type: Boolean, default: false },
      username: { type: String, default: '' },
      password: { type: String, default: '', select: false },
      fromName: { type: String, default: '' },
      fromEmail: { type: String, default: '' },
      enabled: { type: Boolean, default: false },
    },
    currency: { type: String, default: 'BDT' },
    paymentAlerts: {
      enabled: { type: Boolean, default: true },
      recipients: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);

export const PlatformSettingsModel = model<PlatformSettingsDoc>('PlatformSettings', platformSettingsSchema);

/** Reads the singleton, creating it with defaults on first use. */
export async function getPlatformSettings() {
  const existing = await PlatformSettingsModel.findOne({ key: 'platform' }).lean();
  if (existing) return existing;
  const created = await PlatformSettingsModel.create({ key: 'platform' });
  return created.toObject();
}
