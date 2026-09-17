/**
 * Seeds the storage ledger from objects that already exist in storage.
 *
 * Uploads used to write bytes and forget them, so a workspace with existing
 * product images would start at zero usage and effectively get its quota twice.
 *
 * DRIVER-AGNOSTIC: this asks the configured storage provider to enumerate its
 * objects rather than reading the filesystem itself, so it works for any driver
 * that implements `list()`. Sizes come from the provider's metadata (a stat, or
 * a HEAD on an object store) - no object is ever downloaded to measure it.
 *
 * A driver that cannot enumerate is refused outright rather than producing a
 * usage figure that is quietly too low.
 *
 * Idempotent: a key already in the ledger is skipped, so a file is never
 * counted twice no matter how often this runs.
 *
 * Run with:  npm run migrate:storage-ledger -w server
 */
import mongoose, { Types } from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { StorageObjectModel } from '../models/StorageObject';
import { TenantModel } from '../models/Tenant';
import { storage } from '../services/storage';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const mimeFor = (key: string) => MIME_BY_EXT[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export interface LedgerBackfillResult {
  driver: string;
  recorded: number;
  alreadyKnown: number;
  skippedEmpty: number;
  unmatched: string[];
}

export async function backfillStorageLedger(): Promise<LedgerBackfillResult> {
  if (typeof storage.list !== 'function') {
    throw new Error(
      `The "${storage.name}" storage driver cannot enumerate its objects, so usage cannot be rebuilt from it. ` +
        'Implement `list()` on that provider, or rebuild the ledger from the provider\'s own inventory export.',
    );
  }

  // Uploads are namespaced `tenants/<tenantId>/<folder>/<file>`, so one listing
  // covers every workspace and nothing outside that prefix is touched.
  const objects = await storage.list('tenants');

  const tenantIds = new Set((await TenantModel.find().select('_id').lean()).map((t) => String(t._id)));
  const known = new Set((await StorageObjectModel.find().select('key').lean()).map((row) => row.key));

  let recorded = 0;
  let alreadyKnown = 0;
  let skippedEmpty = 0;
  const unmatched: string[] = [];

  for (const object of objects) {
    // Normalise separators so a Windows host and the stored keys agree.
    const key = object.key.split('\\').join('/');

    if (known.has(key)) {
      alreadyKnown += 1;
      continue;
    }
    // A zero-byte object contributes nothing and is usually a failed write.
    if (object.bytes <= 0) {
      skippedEmpty += 1;
      continue;
    }

    const parts = key.split('/');
    // Ownership comes from the key's own namespace. A file that does not sit
    // under a live tenant is never attributed to one - that would let deleted
    // or foreign data count against somebody's quota.
    if (parts[0] !== 'tenants' || !tenantIds.has(parts[1] ?? '')) {
      unmatched.push(key);
      continue;
    }

    await StorageObjectModel.create({
      tenantId: new Types.ObjectId(parts[1]),
      storeId: null,
      key,
      url: storage.getUrl(key),
      bytes: object.bytes,
      mimeType: mimeFor(key),
      folder: parts[2] ?? '',
      uploadedBy: null,
      ...(object.createdAt ? { createdAt: object.createdAt } : {}),
    });

    known.add(key);
    recorded += 1;
  }

  return { driver: storage.name, recorded, alreadyKnown, skippedEmpty, unmatched };
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const result = await backfillStorageLedger();
  logger.info('Storage ledger backfill complete', {
    driver: result.driver,
    recorded: result.recorded,
    alreadyKnown: result.alreadyKnown,
    skippedEmpty: result.skippedEmpty,
    unmatched: result.unmatched.length,
  });
  if (result.unmatched.length > 0) {
    logger.warn('Objects that belong to no live tenant were left uncounted', {
      sample: result.unmatched.slice(0, 10),
    });
  }
  await mongoose.disconnect();
}

if (process.argv[1]?.includes('backfillStorageLedger')) {
  main().catch((error) => {
    logger.error('Storage ledger backfill failed', { error: String(error) });
    process.exit(1);
  });
}
