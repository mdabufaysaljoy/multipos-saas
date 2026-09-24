import { Schema, model, type Types } from 'mongoose';

export interface CounterDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  /** null for a workspace-wide sequence, e.g. supplier codes. */
  storeId: Types.ObjectId | null;
  key: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    storeId: { type: Schema.Types.ObjectId, ref: 'Store', default: null },
    key: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

counterSchema.index({ tenantId: 1, storeId: 1, key: 1 }, { unique: true });

export const CounterModel = model<CounterDoc>('Counter', counterSchema);
