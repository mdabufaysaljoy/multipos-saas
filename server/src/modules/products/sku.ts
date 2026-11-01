import type { Types } from 'mongoose';
import { ProductModel } from '../../models/Product';
import { ProductVariantModel } from '../../models/ProductVariant';
import { escapeRegex } from '../../utils/pagination';

/**
 * Automatic, conflict-free SKUs (docs/SKU_GENERATION.md).
 *
 *   PRODUCT-NAME-VARIANT-NAME[-n]     e.g. OVERSIZED-GRAPHIC-TEE-BLACK-XL, …-XL-2
 *
 * Pure helpers plus one indexed lookup. Uniqueness itself is guaranteed by
 * the existing unique index {tenantId, storeId, sku} (live records); callers
 * retry on a duplicate-key error with the collided SKU excluded.
 */

/** The model's limit. */
export const SKU_MAX_LENGTH = 64;
/** Room kept for "-999999" so a suffix is never cut off. */
export const SKU_BASE_MAX_LENGTH = SKU_MAX_LENGTH - 7;
/** Insert attempts before giving up with a controlled error (normally 1). */
export const MAX_SKU_ATTEMPTS = 8;

const MIN_PRODUCT_PART = 16;

/** Deterministic 5-character code for text that cannot be spelled in A-Z (e.g. Bangla). */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 36 ** 5).toString(36).toUpperCase().padStart(5, '0');
}

/**
 * One part of an SKU: uppercase A-Z / 0-9 separated by single dashes.
 * Letters outside A-Z (Bangla, Arabic…) cannot be written, so a short stable
 * hash of the original is appended - the result is never empty and two
 * different names stay different.
 */
export function normalizeSkuComponent(value: string | null | undefined): string {
  const original = (value ?? '').trim();
  if (!original) return '';
  const upper = original
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/['’`]/g, '');
  const ascii = upper.replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const unrepresented = /[\p{L}\p{N}]/u.test(upper.replace(/[A-Z0-9]/g, ''));
  if (!unrepresented) return ascii;
  return ascii ? `${ascii}-${shortHash(original)}` : `U${shortHash(original)}`;
}

/** Shortens to `max`, preferring a dash boundary, never ending in a dash. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const dash = cut.lastIndexOf('-');
  return (dash >= max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, '');
}

/** PRODUCT-NAME-VARIANT-NAME, at most SKU_BASE_MAX_LENGTH; the variant part is kept whole where possible. */
export function variantSkuBase(productName: string, variantName: string): string {
  const product = normalizeSkuComponent(productName) || 'ITEM';
  const variant = normalizeSkuComponent(variantName) || 'DEFAULT';
  let base = `${product}-${variant}`;
  if (base.length > SKU_BASE_MAX_LENGTH) {
    const productRoom = Math.max(MIN_PRODUCT_PART, SKU_BASE_MAX_LENGTH - variant.length - 1);
    base = `${truncate(product, productRoom)}-${variant}`;
  }
  return truncate(base, SKU_BASE_MAX_LENGTH);
}

/** The product's own base SKU: the normalised product name. */
export function productSkuBase(productName: string): string {
  return truncate(normalizeSkuComponent(productName) || 'ITEM', SKU_BASE_MAX_LENGTH);
}

/** A typed SKU, made safe: uppercase, [A-Z0-9._-], single dashes. Null when nothing usable remains. */
export function normalizeManualSku(value: string | null | undefined): string | null {
  const cleaned = (value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return cleaned ? truncate(cleaned, SKU_BASE_MAX_LENGTH) : null;
}

export const skuCandidate = (base: string, n: number) => (n <= 1 ? base : `${base}-${n}`);

/** Lowest free suffix: ABC, ABC-2, ABC-4 taken → ABC-3. Never a count. */
export function lowestFreeSku(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; n <= taken.size + 1; n += 1) {
    const candidate = skuCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return skuCandidate(base, taken.size + 2);
}

/**
 * SKUs already used in the branch for this base: `BASE` and `BASE-<n>` only,
 * via an anchored regex on the unique index (a range scan, never a full scan).
 */
export type SkuOwner = 'product' | 'variant';

export async function takenSkus(
  owner: SkuOwner,
  scope: { tenantId: Types.ObjectId; storeId: Types.ObjectId },
  base: string,
  excludeId?: Types.ObjectId,
): Promise<Set<string>> {
  const filter = {
      tenantId: scope.tenantId,
      storeId: scope.storeId,
      deletedAt: null,
      sku: { $regex: `^${escapeRegex(base)}(-\\d+)?$` },
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  };
  const rows: { sku: string }[] =
    owner === 'product'
      ? await ProductModel.find(filter).select('sku').lean()
      : await ProductVariantModel.find(filter).select('sku').lean();
  return new Set(rows.map((row) => row.sku));
}

/**
 * Allocates one SKU per base, in order: the lowest free suffix, also avoiding
 * SKUs reserved earlier in the same request and ones that just collided.
 */
export async function allocateSkus(
  owner: SkuOwner,
  scope: { tenantId: Types.ObjectId; storeId: Types.ObjectId },
  bases: string[],
  avoid: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const takenByBase = new Map<string, Set<string>>();
  for (const base of new Set(bases)) takenByBase.set(base, await takenSkus(owner, scope, base));
  const reserved = new Set(avoid);
  return bases.map((base) => {
    const taken = new Set([...takenByBase.get(base)!, ...reserved]);
    const sku = lowestFreeSku(base, taken);
    reserved.add(sku);
    return sku;
  });
}

/** A duplicate-key error on an SKU index (product or variant). */
export function skuCollision(error: unknown): { sku: string | null; onVariant: boolean } | null {
  const e = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown>; message?: string };
  if (e?.code !== 11000) return null;
  const onSku = Boolean(e.keyPattern?.sku) || /sku_1/.test(e.message ?? '');
  if (!onSku) return null;
  return {
    sku: typeof e.keyValue?.sku === 'string' ? e.keyValue.sku : null,
    onVariant: /productvariants/.test(e.message ?? ''),
  };
}
