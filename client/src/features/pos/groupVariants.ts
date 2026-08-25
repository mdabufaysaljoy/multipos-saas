import type { PosVariant } from '@/types/domain';

export interface PosProductGroup {
  productId: string;
  productName: string;
  brand: string;
  categoryName: string;
  imageUrl: string | null;
  variants: PosVariant[];
  totalStock: number;
  minPriceMinor: number;
  maxPriceMinor: number;
  /**
   * Compact chips for the card face, taken from the first attribute axis
   * (e.g. sizes for a shirt, colours for a saree). Empty for simple products.
   */
  chipLabel: string | null;
  chips: string[];
}

/**
 * Collapses the flat variant list from `/products/pos-search` into ONE entry
 * per product.
 *
 * The POS grid previously rendered a card per variant, so a shirt in 3 colours
 * × 4 sizes filled the screen with 12 near-identical tiles. Grouping here keeps
 * the API unchanged (it still returns sellable units, which is what the cart
 * needs) while giving the grid a product-level view.
 */
export function groupVariantsByProduct(variants: PosVariant[]): PosProductGroup[] {
  const byProduct = new Map<string, PosVariant[]>();

  for (const variant of variants) {
    const bucket = byProduct.get(variant.productId);
    if (bucket) bucket.push(variant);
    else byProduct.set(variant.productId, [variant]);
  }

  return [...byProduct.values()].map((group) => {
    const first = group[0];
    const prices = group.map((v) => v.sellingPriceMinor);

    // Use the first attribute axis for the chips; every variant of a product
    // shares the same axes, so reading it from any one of them is safe.
    const axisName = first.attributes[0]?.name ?? null;
    const chips = axisName
      ? [...new Set(group.map((v) => v.attributes.find((a) => a.name === axisName)?.value).filter(Boolean) as string[])]
      : [];

    return {
      productId: first.productId,
      productName: first.productName,
      brand: first.brand,
      categoryName: first.categoryName,
      imageUrl: group.find((v) => v.imageUrl)?.imageUrl ?? null,
      variants: group,
      totalStock: group.reduce((sum, v) => sum + v.stock, 0),
      minPriceMinor: Math.min(...prices),
      maxPriceMinor: Math.max(...prices),
      chipLabel: axisName,
      chips,
    };
  });
}
