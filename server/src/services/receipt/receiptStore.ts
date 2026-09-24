import type { Types } from 'mongoose';
import { StoreModel, type StoreDoc } from '../../models/Store';
import { ApiError } from '../../utils/ApiError';

/**
 * The branch details every receipt needs, in every POS vertical.
 *
 * One shape, one projection: the header, the logo, the footer, the return
 * policy and - the part that matters for direct printing - the configured paper
 * width. Each vertical's receipt content differs; the paper it is printed on
 * does not.
 *
 * Nothing secret is included: this is what a customer already holds in their
 * hand after a sale.
 */
export interface ReceiptStore {
  name: string;
  logoUrl: string | null;
  receiptLogoUrl: string | null;
  phone: string;
  email: string;
  address: string;
  currency: string;
  receipt: StoreDoc['receipt'];
  tax: StoreDoc['tax'];
}

const RECEIPT_STORE_FIELDS = 'name logoUrl receiptLogoUrl phone email address currency receipt tax';

export const toReceiptStore = (store: Pick<StoreDoc, 'name' | 'logoUrl' | 'receiptLogoUrl' | 'phone' | 'email' | 'address' | 'currency' | 'receipt' | 'tax'>): ReceiptStore => ({
  name: store.name,
  logoUrl: store.logoUrl ?? null,
  receiptLogoUrl: store.receiptLogoUrl ?? null,
  phone: store.phone ?? '',
  email: store.email ?? '',
  address: store.address ?? '',
  currency: store.currency,
  receipt: store.receipt,
  tax: store.tax,
});

/**
 * Loads the branch a receipt belongs to.
 *
 * `storeId` names the branch the sale was made in, so a reprint reproduces the
 * receipt as it was issued - even from another branch, and even if that branch
 * has since been removed. It always falls back to the session's own branch, and
 * never leaves the tenant.
 */
export async function loadReceiptStore(tenantId: Types.ObjectId, storeId: Types.ObjectId, saleStoreId?: Types.ObjectId): Promise<ReceiptStore> {
  const store =
    (saleStoreId ? await StoreModel.findOne({ _id: saleStoreId, tenantId }).select(RECEIPT_STORE_FIELDS).lean() : null) ??
    (await StoreModel.findOne({ _id: storeId, tenantId }).select(RECEIPT_STORE_FIELDS).lean());
  if (!store) throw ApiError.notFound('Branch not found');
  return toReceiptStore(store);
}
