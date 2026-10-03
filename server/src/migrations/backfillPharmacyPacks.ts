/**
 * Adds Pharmacy pack metadata to existing medicine rows and makes their
 * category match dosage form. Idempotent; stock remains unit-based.
 *
 * Run with: npm run migrate:pharmacy-packs -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { MedicineModel } from '../models/Medicine';
import { logger } from '../utils/logger';

export async function backfillPharmacyPacks() {
  const result = await MedicineModel.updateMany({}, [
    {
      $set: {
        containerType: { $ifNull: ['$containerType', ''] },
        packageSize: { $ifNull: ['$packageSize', ''] },
        packQuantity: {
          $cond: [{ $and: [{ $isNumber: '$packQuantity' }, { $gte: ['$packQuantity', 1] }] }, '$packQuantity', 1],
        },
        category: {
          $switch: {
            branches: [
              { case: { $eq: ['$dosageForm', 'tablet'] }, then: 'Tablet' },
              { case: { $eq: ['$dosageForm', 'capsule'] }, then: 'Capsule' },
              { case: { $eq: ['$dosageForm', 'syrup'] }, then: 'Syrup' },
              { case: { $eq: ['$dosageForm', 'suspension'] }, then: 'Suspension' },
              { case: { $eq: ['$dosageForm', 'injection'] }, then: 'Injection' },
              { case: { $eq: ['$dosageForm', 'cream'] }, then: 'Cream' },
              { case: { $eq: ['$dosageForm', 'ointment'] }, then: 'Ointment' },
              { case: { $eq: ['$dosageForm', 'drops'] }, then: 'Drops' },
              { case: { $eq: ['$dosageForm', 'inhaler'] }, then: 'Inhaler' },
              { case: { $eq: ['$dosageForm', 'powder'] }, then: 'Powder' },
            ],
            default: 'Other',
          },
        },
      },
    },
    { $set: { packPriceMinor: { $multiply: ['$sellingPriceMinor', '$packQuantity'] } } },
  ]);
  return { matched: result.matchedCount, updated: result.modifiedCount };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('Pharmacy pack backfill complete', await backfillPharmacyPacks());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillPharmacyPacks')) {
  main().catch((error) => {
    logger.error('Pharmacy pack backfill failed', { error: String(error) });
    process.exit(1);
  });
}
