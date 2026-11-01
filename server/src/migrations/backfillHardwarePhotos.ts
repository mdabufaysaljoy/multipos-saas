/**
 * Gives the hardware catalogue its product photography.
 *
 * The photos ship as static files with the website, so a deployment seeded
 * before they existed has rows with no `imageUrl`. This fills those in by
 * slug, from the same defaults a fresh deployment is seeded with.
 *
 * Only rows whose image is MISSING are touched. A picture an admin chose is
 * never replaced, and a row they deliberately left blank is filled once -
 * blank and "never set" look the same in the data, and a catalogue entry
 * without a picture is the worse of the two outcomes.
 *
 * Idempotent: a second run changes nothing.
 *
 * Run with:  npm run migrate:hardware-photos -w server
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { HardwareItemModel } from '../models/HardwareItem';
import { HardwarePackageModel } from '../models/HardwarePackage';
import { DEFAULT_HARDWARE_ITEMS, DEFAULT_HARDWARE_PACKAGES } from '../services/hardware/hardware.defaults';

const blank = { $or: [{ imageUrl: { $exists: false } }, { imageUrl: null }, { imageUrl: '' }] };

async function fill(model: typeof HardwareItemModel | typeof HardwarePackageModel, defaults: readonly { slug: string; imageUrl: string }[]) {
  let updated = 0;
  for (const { slug, imageUrl } of defaults) {
    const result = await model.collection.updateOne({ slug, ...blank }, { $set: { imageUrl } });
    updated += result.modifiedCount;
  }
  return updated;
}

export async function backfillHardwarePhotos(): Promise<{ items: number; packages: number }> {
  return {
    items: await fill(HardwareItemModel, DEFAULT_HARDWARE_ITEMS),
    packages: await fill(HardwarePackageModel, DEFAULT_HARDWARE_PACKAGES),
  };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('Hardware photo backfill complete', await backfillHardwarePhotos());
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillHardwarePhotos')) {
  main().catch((error) => {
    logger.error('Hardware photo backfill failed', { error: String(error) });
    process.exit(1);
  });
}
