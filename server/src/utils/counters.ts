import { Types, type ClientSession } from 'mongoose';
import { CounterModel } from '../models/Counter';
import { sessionOpt } from './tx';

/**
 * Atomically increments a per-store sequence. `findOneAndUpdate` with `$inc` and
 * `upsert` is a single-document operation, so it is safe under concurrency and
 * never hands out a duplicate invoice number.
 */
export async function nextSequence(
  tenantId: Types.ObjectId,
  storeId: Types.ObjectId,
  key: string,
  session?: ClientSession,
): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { tenantId, storeId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...sessionOpt(session) },
  ).lean();

  return doc!.seq;
}

/**
 * The workspace-wide equivalent: one sequence for the whole tenant, whatever
 * branch the caller is signed into. Used where the records themselves are
 * shared across branches, such as supplier codes.
 */
export async function nextTenantSequence(tenantId: Types.ObjectId, key: string, session?: ClientSession): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { tenantId, storeId: null, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, ...sessionOpt(session) },
  ).lean();

  return doc!.seq;
}

/** Formats a document number such as INV-000012. */
export const formatDocumentNumber = (prefix: string, seq: number, pad = 6): string =>
  `${prefix}${String(seq).padStart(pad, '0')}`;
