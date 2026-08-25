import { Schema, model } from 'mongoose';
import { BILLING_INTERVALS } from '../config/constants';
import type { BaseDoc } from './types';

export interface PlanLimits {
  /** -1 means unlimited. */
  maxStaff: number;
  maxProducts: number;
  maxStores: number;
  maxMonthlySales: number;
}

export interface PlanFeatures {
  salesReports: boolean;
  advancedReports: boolean;
  customerManagement: boolean;
  inventoryLedger: boolean;
  multiStore: boolean;
  customRoles: boolean;
  exportData: boolean;
  prioritySupport: boolean;
}

/** Pricing lives in the database - never hardcoded in application code. */
export interface SubscriptionPlanDoc extends BaseDoc {
  code: string;
  name: string;
  description: string;
  interval: string;
  priceMinor: number;
  currency: string;
  trialDays: number;
  features: PlanFeatures;
  limits: PlanLimits;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
}

const planSchema = new Schema<SubscriptionPlanDoc>(
  {
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    interval: { type: String, enum: [...BILLING_INTERVALS], required: true },
    priceMinor: { type: Number, required: true, min: 0, validate: { validator: Number.isSafeInteger, message: 'priceMinor must be an integer' } },
    currency: { type: String, default: 'BDT', uppercase: true },
    trialDays: { type: Number, default: 0, min: 0 },
    features: {
      salesReports: { type: Boolean, default: true },
      advancedReports: { type: Boolean, default: false },
      customerManagement: { type: Boolean, default: true },
      inventoryLedger: { type: Boolean, default: true },
      multiStore: { type: Boolean, default: false },
      customRoles: { type: Boolean, default: false },
      exportData: { type: Boolean, default: false },
      prioritySupport: { type: Boolean, default: false },
    },
    limits: {
      maxStaff: { type: Number, default: 2 },
      maxProducts: { type: Number, default: 200 },
      maxStores: { type: Number, default: 1 },
      maxMonthlySales: { type: Number, default: -1 },
    },
    isActive: { type: Boolean, default: true, index: true },
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);

planSchema.index({ code: 1 }, { unique: true });
planSchema.index({ interval: 1, isActive: 1, sortOrder: 1 });

export const SubscriptionPlanModel = model<SubscriptionPlanDoc>('SubscriptionPlan', planSchema);
