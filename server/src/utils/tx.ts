import mongoose, { type ClientSession } from 'mongoose';
import { supportsTransactions } from '../config/db';

/**
 * Runs `work` inside a MongoDB transaction when the deployment supports one
 * (replica set / sharded cluster) and falls back to a plain execution on a
 * standalone server, where sessions cannot be used.
 *
 * IMPORTANT: services must not rely on transactions for correctness. Stock
 * mutations use atomic conditional updates plus explicit compensation so that
 * overselling is impossible on both code paths. Transactions are an extra layer
 * of atomicity, not the only one.
 */
export async function withTransaction<T>(work: (session: ClientSession | undefined) => Promise<T>): Promise<T> {
  if (!supportsTransactions()) {
    return work(undefined);
  }

  const session = await mongoose.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

/** Spreads `{ session }` into query options only when a session exists. */
export const sessionOpt = (session?: ClientSession) => (session ? { session } : {});
