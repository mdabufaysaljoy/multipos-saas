import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

let transactionsSupported = false;

/** True when the connected deployment is a replica set / mongos (transaction-capable). */
export const supportsTransactions = () => transactionsSupported;

async function probeTransactionSupport(): Promise<boolean> {
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return false;
    const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
    return Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    return false;
  }
}

export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  // NOTE: `sanitizeFilter` is deliberately NOT enabled. It rewrites any object
  // containing a `$` key into an `$eq` literal, which breaks legitimate
  // operators such as `$in` in internal queries. Injection safety comes from
  // Zod: every id and filter reaching a query has already been parsed into a
  // real ObjectId / primitive, so a client cannot smuggle an operator through.

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });

  transactionsSupported = await probeTransactionSupport();
  logger.info(
    `MongoDB connected (${mongoose.connection.name}); transactions ${
      transactionsSupported ? 'ENABLED' : 'UNAVAILABLE (standalone) - using compensating writes'
    }`,
  );

  mongoose.connection.on('error', (err) => logger.error('MongoDB connection error', err));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  return mongoose;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}
