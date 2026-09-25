import { StoreModel } from '../../models/Store';
import type { TenantContext } from '../../types/express';

/** The branch's currency code, for figures printed as text rather than money columns. */
export async function storeCurrency(ctx: TenantContext): Promise<string> {
  const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('currency').lean();
  return store?.currency ?? 'BDT';
}
