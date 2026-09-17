import { Schema, model } from 'mongoose';

/**
 * Platform-wide numbering (invoices), as opposed to `Counter`, which numbers
 * documents per workspace and branch (sales receipts).
 */
export interface DocumentSequenceDoc {
  key: string;
  seq: number;
}

const documentSequenceSchema = new Schema<DocumentSequenceDoc>(
  {
    key: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

documentSequenceSchema.index({ key: 1 }, { unique: true });

export const DocumentSequenceModel = model<DocumentSequenceDoc>('DocumentSequence', documentSequenceSchema);

/**
 * The next number in a sequence. One atomic `$inc`, so concurrent callers never
 * receive the same number. Two callers creating a brand-new sequence at once
 * can collide on the unique key; the loser simply retries.
 */
export async function nextDocumentSequence(key: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const doc = await DocumentSequenceModel.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
      return doc!.seq;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000 || attempt === 2) throw error;
    }
  }
  throw new Error('Could not allocate a document number');
}
