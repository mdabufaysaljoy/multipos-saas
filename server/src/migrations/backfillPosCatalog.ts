/**
 * Introduces the platform POS product catalog.
 *
 *   - Inserts any missing default POS product (clothing, restaurant, pharmacy,
 *     supershop). Existing products are never overwritten.
 *   - Workspaces with no POS type stored predate verticals: they get
 *     `vertical = clothing`. Only that one field is written; `updatedAt` and
 *     every sale, return, product and subscription are left exactly as they are.
 *   - Workspaces whose stored type is not in the catalog are REPORTED, not changed.
 *
 * Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:pos-catalog -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { logger } from '../utils/logger';
import { PosProductModel } from '../models/PosProduct';
import { TenantModel } from '../models/Tenant';
import { ensureDefaultPosProducts } from '../services/posCatalog/posCatalog.service';

export async function backfillPosCatalog(): Promise<{
  productsCreated: number;
  workspacesDefaulted: number;
  workspacesWithUnknownType: number;
}> {
  const productsCreated = await ensureDefaultPosProducts();

  const defaulted = await TenantModel.collection.updateMany(
    { $or: [{ vertical: { $exists: false } }, { vertical: null }, { vertical: '' }] },
    { $set: { vertical: DEFAULT_POS_VERTICAL } },
  );

  const codes = await PosProductModel.distinct('code');
  const workspacesWithUnknownType = await TenantModel.collection.countDocuments({ vertical: { $nin: codes } });
  if (workspacesWithUnknownType > 0) {
    logger.warn('Some workspaces run a POS type that is not in the catalog; they were left unchanged', { workspacesWithUnknownType });
  }

  return { productsCreated, workspacesDefaulted: defaulted.modifiedCount, workspacesWithUnknownType };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await PosProductModel.syncIndexes();
  logger.info('POS catalog backfill complete', await backfillPosCatalog());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillPosCatalog')) {
  main().catch((error) => {
    logger.error('POS catalog backfill failed', { error: String(error) });
    process.exit(1);
  });
}
