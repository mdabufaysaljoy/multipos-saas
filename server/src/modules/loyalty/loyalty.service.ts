import { randomInt } from 'node:crypto';
import { Types } from 'mongoose';
import { PERMISSIONS } from '../../config/permissions';
import { CustomerModel } from '../../models/Customer';
import { LoyaltyMembershipModel, type LoyaltyMembershipDoc } from '../../models/LoyaltyMembership';
import { LoyaltyTransactionModel, type LoyaltyTxType } from '../../models/LoyaltyTransaction';
import { SaleModel, type SaleLoyalty } from '../../models/Sale';
import { StoreModel, type LoyaltySettings } from '../../models/Store';
import { assertEntitlement, hasEntitlement } from '../../services/entitlements/entitlementEngine';
import type { TenantContext } from '../../types/express';
import { ApiError } from '../../utils/ApiError';
import { formatDocumentNumber, nextSequence } from '../../utils/counters';
import { logger } from '../../utils/logger';
import { resolvePage, searchRegex } from '../../utils/pagination';
import { returnTargets } from './loyalty.math';
import type { AdjustPointsInput, IssueMembershipInput, ListMembershipsInput, SetStatusInput } from './loyalty.validators';

type MembershipFields = Omit<LoyaltyMembershipDoc, keyof import('mongoose').Document>;
type LeanMembership = Pick<MembershipFields, 'tenantId' | 'storeId' | 'customerId' | 'cardNumber' | 'barcode' | 'status' | 'pointsBalance'> & {
  _id: Types.ObjectId;
} & Partial<MembershipFields>;

export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettings = { enabled: false, earnSpendMinor: 10_000, pointValueMinor: 100, membershipFeeMinor: 0 };

const CARD_PREFIX = 'LM-';
/** GS1 restricted-circulation range, kept apart from product labels (which use 200). */
const CARD_BARCODE_PREFIX = '299';

/** EAN-13 check digit, so any retail scanner reads the card without configuration. */
function eanCheckDigit(body: string): number {
  const sum = body.split('').reduce((acc, digit, index) => acc + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** True for a code shaped like a loyalty card; the POS uses the same test to route a scan. */
export const isLoyaltyCardCode = (code: string) => /^299\d{10}$/.test(code) && eanCheckDigit(code.slice(0, 12)) === Number(code[12]);

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;
const duplicateIndex = (error: unknown) => JSON.stringify((error as { keyPattern?: unknown })?.keyPattern ?? {});

interface LedgerRef {
  saleId?: Types.ObjectId | null;
  saleNumber?: string;
  returnId?: Types.ObjectId | null;
  returnNumber?: string;
  reason?: string;
}

/**
 * The loyalty program: membership cards, the point ledger, and the hooks the
 * sale and return services call.
 *
 * Every balance change is ONE atomic `$inc` on the membership plus ONE ledger
 * row carrying a unique `dedupeKey`. If the ledger row cannot be written (a
 * retry that already happened), the `$inc` is undone, so a sale, return or
 * adjustment moves points at most once and the balance always equals the sum
 * of its ledger.
 */
class LoyaltyService {
  private scope(ctx: TenantContext) {
    return { tenantId: ctx.tenantId, storeId: ctx.storeId };
  }

  // ------------------------------------------------------------ availability

  async settings(ctx: TenantContext): Promise<LoyaltySettings> {
    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('loyalty').lean();
    if (!store) throw ApiError.notFound('Store not found');
    return { ...DEFAULT_LOYALTY_SETTINGS, ...(store.loyalty ?? {}) };
  }

  /** The plan includes loyalty AND the owner switched the program on. Throws otherwise. */
  async assertProgramOn(ctx: TenantContext): Promise<LoyaltySettings> {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const settings = await this.settings(ctx);
    if (!settings.enabled) {
      throw ApiError.badRequest('The loyalty program is switched off for this branch. Turn it on in Settings → Loyalty.', { reason: 'LOYALTY_DISABLED' });
    }
    return settings;
  }

  // ---------------------------------------------------------------- reading

  private async present(membership: LeanMembership, settings: LoyaltySettings) {
    const customer = await CustomerModel.findOne({ _id: membership.customerId, tenantId: membership.tenantId })
      .select('name phone email')
      .lean();
    return {
      id: membership._id,
      cardNumber: membership.cardNumber,
      barcode: membership.barcode,
      status: membership.status,
      pointsBalance: membership.pointsBalance,
      pointValueMinor: settings.pointValueMinor,
      // Negative balances (points reversed after being spent) are worth nothing.
      valueMinor: Math.max(0, membership.pointsBalance) * settings.pointValueMinor,
      pointsEarnedTotal: membership.pointsEarnedTotal ?? 0,
      pointsRedeemedTotal: membership.pointsRedeemedTotal ?? 0,
      membershipFeeMinor: membership.membershipFeeMinor ?? 0,
      feePayments: membership.feePayments ?? [],
      feeChangeMinor: membership.feeChangeMinor ?? 0,
      issuedAt: membership.issuedAt,
      issuedByNameSnapshot: membership.issuedByNameSnapshot ?? '',
      statusChangedAt: membership.statusChangedAt ?? null,
      statusReason: membership.statusReason ?? '',
      customer: customer ? { id: customer._id, name: customer.name, phone: customer.phone, email: customer.email } : null,
    };
  }

  /**
   * The till's card scan. Identifies a membership by its barcode (or printed
   * card number) in THIS branch only. Reads the cached balance - never the
   * history - and changes nothing: no customer, card or points are created.
   */
  async lookup(ctx: TenantContext, code: string) {
    const settings = await this.assertProgramOn(ctx);
    const value = code.trim().toUpperCase();
    const membership = await LoyaltyMembershipModel.findOne({
      ...this.scope(ctx),
      ...(value.startsWith(CARD_PREFIX) ? { cardNumber: value } : { barcode: value }),
    }).lean();
    if (!membership) throw ApiError.notFound('Loyalty member not found');
    const presented = await this.present(membership, settings);
    // The till needs identity and balance, not fee payments or staff names.
    return {
      id: presented.id,
      cardNumber: presented.cardNumber,
      status: presented.status,
      pointsBalance: presented.pointsBalance,
      pointValueMinor: presented.pointValueMinor,
      valueMinor: presented.valueMinor,
      earnSpendMinor: settings.earnSpendMinor,
      customer: presented.customer,
    };
  }

  async list(ctx: TenantContext, input: ListMembershipsInput) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const settings = await this.settings(ctx);
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = { ...this.scope(ctx) };
    if (input.status) filter.status = input.status;
    if (input.search) {
      const rx = searchRegex(input.search);
      const customers = await CustomerModel.find({ ...this.scope(ctx), $or: [{ name: rx }, { phone: rx }, { email: rx }] })
        .select('_id')
        .limit(500)
        .lean();
      filter.$or = [{ cardNumber: rx }, { barcode: rx }, { customerId: { $in: customers.map((c) => c._id) } }];
    }
    const [rows, total] = await Promise.all([
      LoyaltyMembershipModel.find(filter).sort({ issuedAt: -1 }).skip(skip).limit(limit).lean(),
      LoyaltyMembershipModel.countDocuments(filter),
    ]);
    const items = await Promise.all(rows.map((row) => this.present(row, settings)));
    return { items, page, limit, total };
  }

  async getById(ctx: TenantContext, id: Types.ObjectId) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const membership = await LoyaltyMembershipModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!membership) throw ApiError.notFound('Loyalty member not found');
    return this.present(membership, await this.settings(ctx));
  }

  /** A customer's membership for their profile: the active card, else the most recent one. Null when none. */
  async forCustomer(ctx: TenantContext, customerId: Types.ObjectId) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const membership = await LoyaltyMembershipModel.findOne({ ...this.scope(ctx), customerId })
      .sort({ status: 1, issuedAt: -1 })
      .lean();
    return membership ? this.present(membership, await this.settings(ctx)) : null;
  }

  async history(ctx: TenantContext, id: Types.ObjectId, input: { page?: number; limit?: number }) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const membership = await LoyaltyMembershipModel.findOne({ _id: id, ...this.scope(ctx) }).select('_id').lean();
    if (!membership) throw ApiError.notFound('Loyalty member not found');
    const { page, limit, skip } = resolvePage(input);
    const filter = { tenantId: ctx.tenantId, membershipId: id };
    const [items, total] = await Promise.all([
      LoyaltyTransactionModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .select('type points balanceBefore balanceAfter saleId saleNumber returnId returnNumber reason performedByNameSnapshot createdAt')
        .lean(),
      LoyaltyTransactionModel.countDocuments(filter),
    ]);
    return { items, page, limit, total };
  }

  async summary(ctx: TenantContext) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const scope = this.scope(ctx);
    const [counts, totals] = await Promise.all([
      LoyaltyMembershipModel.aggregate<{ _id: string; count: number }>([{ $match: scope }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      LoyaltyMembershipModel.aggregate<{ issued: number; redeemed: number; outstanding: number; fees: number }>([
        { $match: scope },
        {
          $group: {
            _id: null,
            issued: { $sum: '$pointsEarnedTotal' },
            redeemed: { $sum: '$pointsRedeemedTotal' },
            outstanding: { $sum: { $max: ['$pointsBalance', 0] } },
            fees: { $sum: '$membershipFeeMinor' },
          },
        },
      ]),
    ]);
    const active = counts.find((row) => row._id === 'active')?.count ?? 0;
    const inactive = counts.find((row) => row._id === 'inactive')?.count ?? 0;
    return {
      totalMembers: active + inactive,
      activeCards: active,
      pointsIssued: totals[0]?.issued ?? 0,
      pointsRedeemed: totals[0]?.redeemed ?? 0,
      pointsOutstanding: totals[0]?.outstanding ?? 0,
      membershipFeesMinor: totals[0]?.fees ?? 0,
    };
  }

  // --------------------------------------------------------------- managing

  private async generateBarcode(): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const body = `${CARD_BARCODE_PREFIX}${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
      const candidate = `${body}${eanCheckDigit(body)}`;
      // Unique platform-wide (also enforced by a unique index).
      const taken = await LoyaltyMembershipModel.exists({ barcode: candidate });
      if (!taken) return candidate;
    }
    throw ApiError.internal('Could not allocate a unique card barcode. Please try again.');
  }

  /**
   * Issues a membership card to an existing customer.
   *
   * The fee is the store's configured fee, never a client figure. The card is
   * written ACTIVE only together with a payment that covers the fee exactly
   * (payments are recorded tenders, exactly like a POS sale); nothing is
   * written when the payment does not add up.
   */
  async issue(ctx: TenantContext, input: IssueMembershipInput) {
    const settings = await this.assertProgramOn(ctx);

    const replay = await LoyaltyMembershipModel.findOne({ ...this.scope(ctx), idempotencyKey: input.idempotencyKey }).lean();
    if (replay) return { ...(await this.present(replay, settings)), replayed: true };

    const customer = await CustomerModel.findOne({ _id: input.customerId, ...this.scope(ctx), deletedAt: null }).select('_id name').lean();
    if (!customer) throw ApiError.badRequest('Select an existing customer of this branch');

    const existing = await LoyaltyMembershipModel.findOne({ ...this.scope(ctx), customerId: customer._id, status: 'active' }).select('cardNumber').lean();
    if (existing) throw ApiError.conflict(`${customer.name} already has an active loyalty card (${existing.cardNumber})`);

    const store = await StoreModel.findOne({ _id: ctx.storeId, tenantId: ctx.tenantId }).select('paymentMethods').lean();
    const fee = settings.membershipFeeMinor;
    const payments = input.payments ?? [];
    let changeMinor = 0;

    if (fee === 0) {
      if (payments.length > 0 || (input.cashTenderedMinor ?? 0) > 0) {
        throw ApiError.validation('Membership is free for this branch - remove the payment.');
      }
    } else {
      if (payments.length === 0) throw ApiError.validation('Take the membership fee before issuing the card.', { feeMinor: fee });
      const methods = new Set<string>();
      for (const payment of payments) {
        if (!store?.paymentMethods.includes(payment.method)) {
          throw ApiError.badRequest(`"${payment.method}" is not an enabled payment method for this store`);
        }
        if (methods.has(payment.method)) throw ApiError.validation(`"${payment.method}" appears twice - combine it into a single row`);
        methods.add(payment.method);
      }
      const applied = payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
      if (applied !== fee) {
        throw ApiError.validation(`The payments (${applied}) must add up to exactly the membership fee (${fee}).`, { feeMinor: fee, appliedMinor: applied });
      }
      if (input.cashTenderedMinor !== undefined) {
        const cashRow = payments.find((payment) => payment.method === 'cash');
        if (!cashRow) throw ApiError.validation('Cash received was entered, but no cash payment is part of this fee.');
        if (input.cashTenderedMinor < cashRow.amountMinor) {
          throw ApiError.validation(`The cash received (${input.cashTenderedMinor}) is less than the cash due (${cashRow.amountMinor}).`);
        }
        changeMinor = input.cashTenderedMinor - cashRow.amountMinor;
      }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const barcode = await this.generateBarcode();
      try {
        const seq = await nextSequence(ctx.tenantId, ctx.storeId, 'loyaltyCard');
        const doc = await LoyaltyMembershipModel.create({
          ...this.scope(ctx),
          customerId: customer._id,
          cardNumber: formatDocumentNumber(CARD_PREFIX, seq),
          barcode,
          status: 'active',
          membershipFeeMinor: fee,
          feePayments: payments.map((payment) => ({ method: payment.method, amountMinor: payment.amountMinor, reference: payment.reference ?? '' })),
          feeChangeMinor: changeMinor,
          issuedAt: new Date(),
          issuedBy: ctx.userId,
          issuedByNameSnapshot: ctx.userName,
          idempotencyKey: input.idempotencyKey,
        });
        return this.present(doc.toObject(), settings);
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const index = duplicateIndex(error);
        if (index.includes('idempotencyKey')) {
          const winner = await LoyaltyMembershipModel.findOne({ ...this.scope(ctx), idempotencyKey: input.idempotencyKey }).lean();
          if (winner) return { ...(await this.present(winner, settings)), replayed: true };
        }
        if (index.includes('customerId')) throw ApiError.conflict(`${customer.name} already has an active loyalty card`);
        // A barcode or card number collided with a concurrent issue: try again with fresh ones.
      }
    }
    throw ApiError.internal('Could not issue the card. Please try again.');
  }

  /** Deactivates or reactivates a card. History and points are always kept. */
  async setStatus(ctx: TenantContext, id: Types.ObjectId, input: SetStatusInput) {
    const settings = await this.settings(ctx);
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const membership = await LoyaltyMembershipModel.findOne({ _id: id, ...this.scope(ctx) });
    if (!membership) throw ApiError.notFound('Loyalty member not found');
    if (membership.status === input.status) throw ApiError.badRequest(`This card is already ${input.status}`);
    membership.status = input.status;
    membership.statusChangedAt = new Date();
    membership.statusChangedBy = ctx.userId;
    membership.statusReason = input.reason;
    try {
      await membership.save();
    } catch (error) {
      if (isDuplicateKey(error)) throw ApiError.conflict('This customer already has another active loyalty card');
      throw error;
    }
    return this.present(membership.toObject(), settings);
  }

  /** Manual correction. Never overwrites the balance: one signed ledger entry with a reason and the actor. */
  async adjust(ctx: TenantContext, id: Types.ObjectId, input: AdjustPointsInput) {
    await assertEntitlement(ctx.tenantId, 'loyalty');
    const membership = await LoyaltyMembershipModel.findOne({ _id: id, ...this.scope(ctx) }).lean();
    if (!membership) throw ApiError.notFound('Loyalty member not found');

    const dedupeKey = `adjust:${membership._id}:${input.idempotencyKey}`;
    const done = await LoyaltyTransactionModel.findOne({ tenantId: ctx.tenantId, dedupeKey }).lean();
    if (!done) {
      const moved = await this.move(ctx, membership._id, input.points, 'adjustment', dedupeKey, { reason: input.reason }, {
        // A deduction may not take the card below zero.
        requireBalance: input.points < 0 ? -input.points : undefined,
      });
      if (!moved) throw ApiError.validation('The card does not have that many points to remove.', { reason: 'LOYALTY_INSUFFICIENT_POINTS' });
    }
    return this.getById(ctx, id);
  }

  // ----------------------------------------------------------- the ledger

  /**
   * Moves points atomically and writes the ledger row. Returns null when a
   * required balance or active status is not met (nothing written), and
   * `{ duplicate: true }` when the dedupe key was already used (the move undone).
   */
  private async move(
    ctx: TenantContext,
    membershipId: Types.ObjectId,
    points: number,
    type: LoyaltyTxType,
    dedupeKey: string,
    ref: LedgerRef,
    options: { requireBalance?: number; requireActive?: boolean } = {},
  ): Promise<{ balanceBefore: number; balanceAfter: number; duplicate?: boolean } | null> {
    if (!Number.isSafeInteger(points) || points === 0) return null;

    const filter: Record<string, unknown> = { _id: membershipId, tenantId: ctx.tenantId };
    if (options.requireBalance !== undefined) filter.pointsBalance = { $gte: options.requireBalance };
    if (options.requireActive) filter.status = 'active';

    const totals: Record<string, number> = { pointsBalance: points };
    if (type === 'earn') totals.pointsEarnedTotal = points;
    if (type === 'earn_reversed') totals.pointsEarnedTotal = points;
    if (type === 'redeem') totals.pointsRedeemedTotal = -points;
    if (type === 'redeem_reversed' || type === 'redeem_restored') totals.pointsRedeemedTotal = -points;

    const before = await LoyaltyMembershipModel.findOneAndUpdate(filter, { $inc: totals }, { new: false })
      .select('pointsBalance customerId storeId')
      .lean();
    if (!before) return null;

    const balanceBefore = before.pointsBalance;
    const balanceAfter = balanceBefore + points;
    try {
      await LoyaltyTransactionModel.create({
        tenantId: ctx.tenantId,
        storeId: before.storeId,
        membershipId,
        customerId: before.customerId,
        type,
        points,
        balanceBefore,
        balanceAfter,
        saleId: ref.saleId ?? null,
        saleNumber: ref.saleNumber ?? '',
        returnId: ref.returnId ?? null,
        returnNumber: ref.returnNumber ?? '',
        reason: ref.reason ?? '',
        performedBy: ctx.userId,
        performedByNameSnapshot: ctx.userName,
        dedupeKey,
      });
    } catch (error) {
      // Undo the balance change: either it already happened once (duplicate) or it must not happen at all.
      const inverse = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, -value]));
      await LoyaltyMembershipModel.updateOne({ _id: membershipId, tenantId: ctx.tenantId }, { $inc: inverse });
      if (isDuplicateKey(error)) return { balanceBefore, balanceAfter: balanceBefore, duplicate: true };
      throw error;
    }
    return { balanceBefore, balanceAfter };
  }

  // ------------------------------------------------------------ sale hooks

  /**
   * Validates a card for a sale BEFORE anything moves. Only a card scanned at
   * the till (`membershipId`) makes a sale a loyalty sale - a customer or phone
   * number never does.
   *
   * `internal` is the exchange path re-using the original sale's card: there a
   * card or program that is no longer usable simply means "no points", never a
   * failed exchange.
   */
  async prepareForSale(ctx: TenantContext, input: { membershipId?: Types.ObjectId; redeemPoints: number; internal: boolean }) {
    if (!input.membershipId) {
      if (input.redeemPoints > 0) throw ApiError.validation('Scan the loyalty card before redeeming points.');
      return null;
    }

    if (input.internal) {
      if (!(await hasEntitlement(ctx.tenantId, 'loyalty'))) return null;
      const settings = await this.settings(ctx);
      if (!settings.enabled) return null;
      const membership = await LoyaltyMembershipModel.findOne({ _id: input.membershipId, ...this.scope(ctx), status: 'active' }).lean();
      return membership ? { membership, settings } : null;
    }

    const settings = await this.assertProgramOn(ctx);
    const membership = await LoyaltyMembershipModel.findOne({ _id: input.membershipId, ...this.scope(ctx) }).lean();
    if (!membership) throw ApiError.badRequest('Loyalty member not found in this branch');
    if (membership.status !== 'active') throw ApiError.badRequest(`Loyalty card ${membership.cardNumber} is inactive and cannot earn or redeem points.`);

    if (input.redeemPoints > 0) {
      if (!ctx.can(PERMISSIONS.LOYALTY_REDEEM)) throw ApiError.forbidden('You do not have permission to redeem loyalty points');
      if (membership.pointsBalance < input.redeemPoints) {
        throw ApiError.validation(`The card has ${Math.max(0, membership.pointsBalance)} points; ${input.redeemPoints} cannot be redeemed.`, {
          reason: 'LOYALTY_INSUFFICIENT_POINTS',
          balance: membership.pointsBalance,
        });
      }
    }
    return { membership, settings };
  }

  /**
   * Spends points for a sale that is about to be created. Atomic: two tills
   * cannot spend the same points. `checkoutRef` names this checkout until the
   * sale exists (see `attachSale`).
   */
  async redeemForSale(ctx: TenantContext, membershipId: Types.ObjectId, points: number, checkoutRef: Types.ObjectId) {
    const moved = await this.move(ctx, membershipId, -points, 'redeem', `redeem:${checkoutRef}`, { reason: 'Redeemed at checkout' }, {
      requireBalance: points,
      requireActive: true,
    });
    if (!moved || moved.duplicate) {
      throw ApiError.validation('The card no longer has enough points for this redemption. Scan it again.', { reason: 'LOYALTY_INSUFFICIENT_POINTS' });
    }
    return moved;
  }

  /** Gives redeemed points back when the sale they were spent on did not complete. Never throws. */
  async reverseRedemption(ctx: TenantContext, membershipId: Types.ObjectId, points: number, checkoutRef: Types.ObjectId) {
    try {
      await this.move(ctx, membershipId, points, 'redeem_reversed', `redeem_reversed:${checkoutRef}`, { reason: 'Sale could not be completed' });
    } catch (error) {
      logger.error('CRITICAL: failed to give back redeemed loyalty points; manual adjustment required', {
        tenantId: String(ctx.tenantId),
        membershipId: String(membershipId),
        points,
        error,
      });
    }
  }

  /** Awards the points of a COMPLETED sale, once. Returns the points actually awarded and the balance after. */
  async earnForSale(ctx: TenantContext, membershipId: Types.ObjectId, points: number, sale: { _id: Types.ObjectId; saleNumber: string }) {
    if (points <= 0) return null;
    const moved = await this.move(ctx, membershipId, points, 'earn', `earn:${sale._id}`, { saleId: sale._id, saleNumber: sale.saleNumber, reason: 'Purchase' }, {
      requireActive: true,
    });
    if (!moved || moved.duplicate) return null;
    return moved;
  }

  /** Links the redemption row, written before the sale existed, to the sale and its number. */
  async attachSale(ctx: TenantContext, checkoutRef: Types.ObjectId, saleId: Types.ObjectId, saleNumber: string) {
    await LoyaltyTransactionModel.updateOne({ tenantId: ctx.tenantId, dedupeKey: `redeem:${checkoutRef}` }, { $set: { saleId, saleNumber } });
  }

  // ---------------------------------------------------------- return hooks

  /**
   * Claims this return's share of a loyalty sale's points, BEFORE the return
   * document is written, so the money refund can be reduced by the value of the
   * redeemed points given back. The claim is an optimistic, atomic update of
   * the sale's running totals, so concurrent returns never both claim the same
   * points. Returns null for a sale without a card.
   */
  async claimReturn(ctx: TenantContext, saleId: Types.ObjectId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sale = await SaleModel.findOne({ _id: saleId, tenantId: ctx.tenantId }).select('loyalty items subtotalMinor').lean();
      const loyalty = sale?.loyalty as SaleLoyalty | null | undefined;
      if (!sale || !loyalty) return null;

      // Returned so far, INCLUDING the quantities this return has just reserved.
      const returnedValue = sale.items.reduce((sum, item) => sum + item.unitPriceMinor * item.returnedQuantity, 0);
      const targets = returnTargets(loyalty, sale.subtotalMinor, returnedValue);
      const earnDelta = targets.earnReversedTarget - loyalty.pointsEarnedReversed;
      const restoreDelta = targets.redeemRestoredTarget - loyalty.pointsRedeemedRestored;

      if (earnDelta === 0 && restoreDelta === 0) {
        return { membershipId: loyalty.membershipId, pointsEarnedReversed: 0, pointsRedeemedRestored: 0, valueMinor: 0 };
      }

      const claimed = await SaleModel.updateOne(
        {
          _id: saleId,
          tenantId: ctx.tenantId,
          'loyalty.pointsEarnedReversed': loyalty.pointsEarnedReversed,
          'loyalty.pointsRedeemedRestored': loyalty.pointsRedeemedRestored,
        },
        { $set: { 'loyalty.pointsEarnedReversed': targets.earnReversedTarget, 'loyalty.pointsRedeemedRestored': targets.redeemRestoredTarget } },
      );
      if (claimed.modifiedCount === 1) {
        return {
          membershipId: loyalty.membershipId,
          pointsEarnedReversed: earnDelta,
          pointsRedeemedRestored: restoreDelta,
          valueMinor: restoreDelta * loyalty.pointValueMinor,
        };
      }
    }
    throw ApiError.conflict('This sale is being returned by someone else right now. Try again.');
  }

  /** Undoes a claim when the return itself could not be completed. */
  async releaseReturnClaim(ctx: TenantContext, saleId: Types.ObjectId, claim: { pointsEarnedReversed: number; pointsRedeemedRestored: number } | null) {
    if (!claim || (claim.pointsEarnedReversed === 0 && claim.pointsRedeemedRestored === 0)) return;
    await SaleModel.updateOne(
      { _id: saleId, tenantId: ctx.tenantId },
      { $inc: { 'loyalty.pointsEarnedReversed': -claim.pointsEarnedReversed, 'loyalty.pointsRedeemedRestored': -claim.pointsRedeemedRestored } },
    );
  }

  /**
   * Applies a claimed return to the card: earned points taken back (the balance
   * may go below zero if they were already spent - it then blocks redemption
   * until it recovers) and redeemed points given back.
   */
  async applyReturnClaim(
    ctx: TenantContext,
    claim: { membershipId: Types.ObjectId; pointsEarnedReversed: number; pointsRedeemedRestored: number },
    ref: { key: string; saleId: Types.ObjectId; saleNumber: string; returnId?: Types.ObjectId | null; returnNumber?: string; reason: string },
  ) {
    const ledgerRef = { saleId: ref.saleId, saleNumber: ref.saleNumber, returnId: ref.returnId ?? null, returnNumber: ref.returnNumber ?? '', reason: ref.reason };
    try {
      if (claim.pointsEarnedReversed > 0) {
        await this.move(ctx, claim.membershipId, -claim.pointsEarnedReversed, 'earn_reversed', `${ref.key}:earn`, ledgerRef);
      }
      if (claim.pointsRedeemedRestored > 0) {
        await this.move(ctx, claim.membershipId, claim.pointsRedeemedRestored, 'redeem_restored', `${ref.key}:restore`, ledgerRef);
      }
    } catch (error) {
      logger.error('CRITICAL: failed to apply loyalty points for a return; manual adjustment required', {
        tenantId: String(ctx.tenantId),
        key: ref.key,
        claim,
        error,
      });
    }
  }

  /** A cancelled sale takes back everything it earned and gives back everything it redeemed. */
  async applyCancellation(ctx: TenantContext, sale: { _id: Types.ObjectId; saleNumber: string; loyalty?: SaleLoyalty | null }, reason: string) {
    const loyalty = sale.loyalty;
    if (!loyalty) return;
    const claim = {
      membershipId: loyalty.membershipId,
      pointsEarnedReversed: Math.max(0, loyalty.pointsEarned - loyalty.pointsEarnedReversed),
      pointsRedeemedRestored: Math.max(0, loyalty.pointsRedeemed - loyalty.pointsRedeemedRestored),
    };
    await SaleModel.updateOne(
      { _id: sale._id, tenantId: ctx.tenantId },
      { $set: { 'loyalty.pointsEarnedReversed': loyalty.pointsEarned, 'loyalty.pointsRedeemedRestored': loyalty.pointsRedeemed } },
    );
    await this.applyReturnClaim(ctx, claim, { key: `cancel:${sale._id}`, saleId: sale._id, saleNumber: sale.saleNumber, reason: `Sale cancelled: ${reason}` });
  }
}

export const loyaltyService = new LoyaltyService();
