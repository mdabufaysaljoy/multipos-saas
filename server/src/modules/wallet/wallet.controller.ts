import { getReceiptForTopUp } from '../../services/billing/receipt.service';
import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import { asyncHandler } from '../../utils/asyncHandler';
import { buildPageMeta, created, ok, paginated } from '../../utils/apiResponse';
import { body, params, query } from '../../middleware/validate';
import { getContext } from '../../middleware/tenant';
import { walletService, presentLedgerRows } from '../../services/wallet/wallet.service';
import { topUpService } from './wallet.service';
import type { TopUpRequestInput, UsageListInput, WalletHistoryInput } from './wallet.validators';
import { usageChargeService } from '../../services/billing/usageCharge.service';
import { usagePriceList } from '../../services/billing/usagePricing';

export const balance = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await walletService.balance(getContext(req).tenantId));
});

// The wallet belongs to the account, so its ledger can hold other workspaces'
// rows. The viewer is passed so only the account owner sees those; everyone
// else sees the rows their own workspace generated.

export const history = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await walletService.transactions(ctx.tenantId, query<WalletHistoryInput>(req), { userId: ctx.userId });
  paginated(res, await presentLedgerRows(result.items as never), buildPageMeta(result.page, result.limit, result.total));
});

/** Spending grouped by service, for the wallet dashboard. */
export const breakdown = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const input = query<{ from?: Date; to?: Date }>(req);
  ok(res, await walletService.breakdown(ctx.tenantId, input, { userId: ctx.userId }));
});

/** Billed usage of paid services, with a per-service summary. */
export const usage = asyncHandler(async (req: Request, res: Response) => {
  const ctx = getContext(req);
  const result = await usageChargeService.list(ctx.tenantId, query<UsageListInput>(req), { userId: ctx.userId });
  ok(res, result);
});

/** Unit prices for the paid services, as set by the platform admin. */
export const usagePrices = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, await usagePriceList());
});

export const submitTopUp = asyncHandler(async (req: Request, res: Response) => {
  created(res, await topUpService.submit(getContext(req), body<TopUpRequestInput>(req)));
});

export const listTopUps = asyncHandler(async (req: Request, res: Response) => {
  const result = await topUpService.listForTenant(getContext(req).tenantId, query<WalletHistoryInput>(req));
  paginated(res, result.items, buildPageMeta(result.page, result.limit, result.total));
});

export const cancelTopUp = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await topUpService.cancel(getContext(req), id));
});

/** The receipt for one of this workspace's own approved top-ups. */
export const topUpReceipt = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: Types.ObjectId }>(req);
  ok(res, await getReceiptForTopUp(id, getContext(req).tenantId));
});
