import { Types } from 'mongoose';
import { StorageObjectModel } from '../../models/StorageObject';
import { logger } from '../../utils/logger';
import { storage } from './index';

/**
 * Releases files a workspace no longer references.
 *
 * Storage keys reach us inside request bodies (a product's `images` array, a
 * store's `logoUrl`), so they are UNTRUSTED. A key is only acted on when the
 * ledger says it belongs to the calling tenant - otherwise one workspace could
 * delete another's files simply by naming them in its own product and then
 * removing it.
 *
 * Deleting bytes is best-effort: the ledger row is closed either way, because a
 * file the provider has already lost must not keep consuming quota forever.
 */
export async function releaseStorageKeys(tenantId: Types.ObjectId, keys: (string | null | undefined)[]): Promise<number> {
  const wanted = [...new Set(keys.filter((key): key is string => typeof key === 'string' && key.length > 0))];
  if (wanted.length === 0) return 0;

  // The ownership check. Only rows this tenant owns, still live, come back.
  const owned = await StorageObjectModel.find({
    tenantId,
    key: { $in: wanted },
    deletedAt: null,
  })
    .select('_id key')
    .lean();

  if (owned.length === 0) return 0;

  const now = new Date();
  await StorageObjectModel.updateMany(
    { _id: { $in: owned.map((row) => row._id) } },
    { $set: { deletedAt: now } },
  );

  for (const row of owned) {
    try {
      await storage.delete(row.key);
    } catch (error) {
      // The quota is already freed. Losing the bytes is a janitorial problem,
      // not a correctness one, so it is logged rather than thrown.
      logger.warn('Could not delete stored file; ledger row was still closed', {
        key: row.key,
        error: String(error),
      });
    }
  }

  return owned.length;
}

/**
 * Same guarantees as `releaseStorageKeys`, but addressed by public URL.
 *
 * Store branding is persisted as a URL rather than a storage key, so the ledger
 * is what maps it back to something deletable. Tenant scoping is identical.
 */
export async function releaseStorageUrls(tenantId: Types.ObjectId, urls: (string | null | undefined)[]): Promise<number> {
  const wanted = [...new Set(urls.filter((url): url is string => typeof url === 'string' && url.length > 0))];
  if (wanted.length === 0) return 0;

  const owned = await StorageObjectModel.find({ tenantId, url: { $in: wanted }, deletedAt: null })
    .select('key')
    .lean();

  return releaseStorageKeys(tenantId, owned.map((row) => row.key));
}

/** Keys present in `before` but not in `after`. */
export function droppedKeys(before: (string | null | undefined)[], after: (string | null | undefined)[]): string[] {
  const kept = new Set(after.filter((key): key is string => Boolean(key)));
  return [...new Set(before.filter((key): key is string => Boolean(key) && !kept.has(key as string)))];
}
