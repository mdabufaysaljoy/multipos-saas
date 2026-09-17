import { PERMISSIONS } from '../../config/permissions';
import { Types } from 'mongoose';
import { PAYMENT_STATUS } from '../../config/constants';
import { PaymentModel } from '../../models/Payment';
import { SubscriptionPlanModel } from '../../models/SubscriptionPlan';
import { UpgradeRequestModel } from '../../models/UpgradeRequest';
import { ApiError } from '../../utils/ApiError';
import { resolvePage } from '../../utils/pagination';
import { openSubscriptionPeriod } from '../../services/subscription/activation.service';
import { planChangeService } from './planChange.service';
import { subscriptionService } from './subscriptions.service';
import { couponService } from '../coupons/coupons.service';
import { walletService } from '../../services/wallet/wallet.service';
import { pricingRecordOf } from '../../services/subscription/purchasePricing.service';
import { breakdownFor } from './purchaseBreakdown';
import { logger } from '../../utils/logger';
import type { TenantContext } from '../../types/express';
import { issueInvoiceSafely } from '../../services/billing/invoice.service';

interface Actor {
  id: Types.ObjectId | null;
  name: string;
}

export interface SubmitUpgradeInput {
  planId: Types.ObjectId;
  paymentMethod: string;
  couponCode?: string;
  amountMinor: number;
  senderNumber?: string;
  transactionId?: string;
  note?: string;
  idempotencyKey?: string;
}

class UpgradeService {
  /**
   * Records a manual-payment upgrade request.
   *
   * Nothing about the subscription changes here - the request lands as
   * `pending` and waits for a platform admin. A customer claiming to have paid
   * is not evidence that they have.
   */
  async submit(ctx: TenantContext, input: SubmitUpgradeInput) {
    // A retried purchase (same key) returns what the first attempt created,
    // before any rule is re-checked - the first attempt may already be active.
    if (input.idempotencyKey) {
      const existing = await UpgradeRequestModel.findOne({ tenantId: ctx.tenantId, idempotencyKey: input.idempotencyKey }).lean();
      if (existing) {
        if (!existing.planId.equals(input.planId)) {
          throw ApiError.conflict('That purchase key was already used for a different plan', { reason: 'IDEMPOTENCY_KEY_REUSED' });
        }
        return { ...existing, replayed: true };
      }
    }

    // The shared plan-change rule: availability, "already on it" unless renewing,
    // and downgrades only when usage fits. Online checkout applies the same one.
    const { plan, currentPlan, verdict, isRenewal } = await planChangeService.assertAllowed(ctx.tenantId, input.planId);
    const transitionKind = isRenewal ? 'renewal' : verdict.kind;

    // Engine list price, less the coupon (quoted, not yet consumed, so an invalid
    // code fails before anything is written), less credit for unused paid time.
    const priced = await breakdownFor(ctx.tenantId, plan, transitionKind, input.couponCode);
    const { offer, coupon: quote, payableMinor } = priced;
    const snapshot = { code: plan.code, name: plan.name, interval: plan.interval, priceMinor: offer.listPriceMinor, currency: offer.currency };

    if (input.amountMinor < payableMinor) {
      throw ApiError.badRequest(
        `${plan.name} costs ${(payableMinor / 100).toFixed(2)} ${offer.currency}${quote ? ' after the discount' : ''}. The amount entered is lower.`,
        { payableMinor, submittedMinor: input.amountMinor, discountMinor: quote?.discountMinor ?? 0 },
      );
    }

    const pending = await UpgradeRequestModel.findOne({ tenantId: ctx.tenantId, status: 'pending' }).lean();
    if (pending) {
      throw ApiError.conflict('You already have an upgrade request awaiting review.');
    }

    // ---- wallet payment ---------------------------------------------------
    // Paying from the prepaid balance is settled money, so it activates the
    // plan immediately rather than queueing for manual verification.
    if (input.paymentMethod === 'wallet') {
      if (!ctx.can(PERMISSIONS.WALLET_MANAGE)) {
        throw ApiError.forbidden('Paying from the account wallet needs the "wallet.manage" permission');
      }
      // Credit may cover the whole price: then nothing leaves the wallet.
      const movement = payableMinor > 0 ? await walletService.debit(ctx.tenantId, {
        amountMinor: payableMinor,
        reason: `Subscription upgrade to ${plan.name}`,
        referenceType: 'subscription',
        performedBy: ctx.userId,
        performedByName: ctx.userName,
      }) : null;

      // The money has left the wallet. There are no transactions here, so if
      // anything below fails we must hand it back ourselves - otherwise the
      // customer pays and gets nothing.
      try {
        const request = await UpgradeRequestModel.create({
          tenantId: ctx.tenantId,
          requestedBy: ctx.userId,
          requestedByNameSnapshot: ctx.userName,
          planId: plan._id,
          planSnapshot: snapshot,
          pricing: pricingRecordOf(offer),
          proration: priced.proration,
          idempotencyKey: input.idempotencyKey ?? null,
          currentPlanCodeSnapshot: currentPlan?.code ?? null,
          transitionKind,
          paymentMethod: 'wallet',
          couponId: quote?.couponId ?? null,
          couponCodeSnapshot: quote?.code ?? null,
          discountMinor: quote?.discountMinor ?? 0,
          amountMinor: payableMinor,
          senderNumber: '',
          transactionId: movement ? `WALLET-${movement.transaction._id}` : `CREDIT-${new Types.ObjectId()}`,
          note: input.note ?? '',
          status: 'pending',
        });

        if (quote) await couponService.redeem(quote, ctx.tenantId, request._id);

        // Settled instantly - approve with the system as the actor.
        const approved = await this.approve(request._id, { id: null, name: 'wallet' }, 'Paid from wallet balance');
        return approved.request;
      } catch (error) {
        if (movement) await walletService
          .credit(
            ctx.tenantId,
            {
              amountMinor: payableMinor,
              reason: `Refund: ${plan.name} subscription could not be activated`,
              referenceType: 'subscription',
              performedBy: ctx.userId,
              performedByName: ctx.userName,
            },
            'refund',
          )
          .catch(() => {
            // A failed refund must be loud - it is money owed to a customer.
            logger.error('Wallet refund failed after a failed subscription purchase', {
              tenantId: String(ctx.tenantId),
              amountMinor: payableMinor,
              debitTransactionId: String(movement.transaction._id),
            });
          });
        throw error;
      }
    }

    // Manual payment: both the sending account and the reference are required,
    // because a platform admin has to match this against a real transfer.
    // Checked here rather than in the schema so a wallet payment - which is
    // already settled and needs neither - still passes.
    const senderDigits = (input.senderNumber ?? '').replace(/\D/g, '');
    if (senderDigits.length < 6) {
      throw ApiError.badRequest('Enter the phone or account number you paid from');
    }
    if (!/^[+()\-\s\d.]+$/.test((input.senderNumber ?? '').trim())) {
      throw ApiError.badRequest('The paying number may only contain digits, spaces and + ( ) - .');
    }
    if (!input.transactionId || input.transactionId.trim().length < 4) {
      throw ApiError.badRequest('Enter the transaction ID from your payment confirmation');
    }

    const duplicate = await UpgradeRequestModel.findOne({ transactionId: input.transactionId.trim() }).lean();
    if (duplicate) {
      throw ApiError.conflict('That transaction ID has already been submitted.');
    }

    const request = await UpgradeRequestModel.create({
      tenantId: ctx.tenantId,
      requestedBy: ctx.userId,
      requestedByNameSnapshot: ctx.userName,
      planId: plan._id,
      planSnapshot: snapshot,
      pricing: pricingRecordOf(offer),
      proration: priced.proration,
      idempotencyKey: input.idempotencyKey ?? null,
      currentPlanCodeSnapshot: currentPlan?.code ?? null,
      transitionKind,
      paymentMethod: input.paymentMethod,
      couponId: quote?.couponId ?? null,
      couponCodeSnapshot: quote?.code ?? null,
      discountMinor: quote?.discountMinor ?? 0,
      amountMinor: input.amountMinor,
      senderNumber: input.senderNumber ?? '',
      transactionId: input.transactionId.trim(),
      note: input.note ?? '',
      status: 'pending',
    });

    // The coupon is consumed on submission and released again if the request
    // is rejected or cancelled, so a limited code cannot be tied up forever.
    if (quote) await couponService.redeem(quote, ctx.tenantId, request._id);

    return request.toObject();
  }

  async listForTenant(tenantId: Types.ObjectId) {
    return UpgradeRequestModel.find({ tenantId }).sort({ createdAt: -1 }).limit(20).lean();
  }

  async cancel(ctx: TenantContext, id: Types.ObjectId) {
    const request = await UpgradeRequestModel.findOne({ _id: id, tenantId: ctx.tenantId });
    if (!request) throw ApiError.notFound('Request not found');
    if (request.status !== 'pending') throw ApiError.badRequest('Only a pending request can be cancelled');

    request.status = 'cancelled';
    await request.save();

    if (request.couponId) await couponService.release(request.couponId, request.tenantId, request._id);
    return request.toObject();
  }

  // ------------------------------------------------------- platform admin

  async listAll(input: { page?: number; limit?: number; status?: string }) {
    const { page, limit, skip } = resolvePage(input);
    const filter: Record<string, unknown> = {};
    if (input.status) filter.status = input.status;

    const [items, total] = await Promise.all([
      UpgradeRequestModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('tenantId', 'name slug contactEmail contactPhone')
        .lean(),
      UpgradeRequestModel.countDocuments(filter),
    ]);

    return { items, page, limit, total };
  }

  /**
   * Approves a request: records the payment, activates the new plan and links
   * everything together. This is the ONLY path that turns a manual payment
   * into an active subscription.
   */
  async approve(id: Types.ObjectId, actor: Actor, reviewNote: string) {
    // Atomic claim: of any number of concurrent approvals (two admins, a double
    // click, a retried request) exactly one proceeds; the rest see it approved.
    const request = await UpgradeRequestModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'approved', reviewedBy: actor.id, reviewedByNameSnapshot: actor.name, reviewedAt: new Date(), reviewNote } },
      { new: true },
    );
    if (!request) {
      const existing = await UpgradeRequestModel.findById(id).select('status').lean();
      if (!existing) throw ApiError.notFound('Request not found');
      throw ApiError.badRequest(`This request is already ${existing.status}`);
    }

    let paymentId: Types.ObjectId | null = null;
    try {
      const plan = await SubscriptionPlanModel.findById(request.planId);
      if (!plan) throw ApiError.badRequest('The requested plan no longer exists');

      const payment = await PaymentModel.create({
        tenantId: request.tenantId,
        userId: request.requestedBy,
        planId: plan._id,
        amountMinor: request.amountMinor,
        currency: request.planSnapshot.currency,
        provider: request.paymentMethod,
        providerReference: request.transactionId,
        status: PAYMENT_STATUS.PAID,
        paidAt: new Date(),
        // One payment per request, enforced by the unique idempotency index.
        idempotencyKey: `upgrade-request:${request._id}`,
        metadata: {
          approvedBy: actor.name,
          upgradeRequestId: String(request._id),
          manual: true,
          pricing: request.pricing,
          // What this period was worth beyond the cash paid: credit rolled over from the plan it replaced.
          prorationCreditAppliedMinor: request.proration?.appliedMinor ?? 0,
        },
      });
      paymentId = payment._id;

      const subscription = await openSubscriptionPeriod({
        tenantId: request.tenantId,
        plan,
        autoRenew: false,
        provider: request.paymentMethod,
        isManual: true,
        activatedBy: actor.id,
        notes: `Upgrade approved from request ${request._id}`,
        lastPaymentId: payment._id,
        // Renewing the same plan continues from the end of the running period.
        stackOnSamePlan: request.transitionKind === 'renewal',
        // The subscription records the price the customer was quoted, not today's plan price.
        priceMinor: request.planSnapshot.priceMinor,
        currency: request.planSnapshot.currency,
      });
      await PaymentModel.updateOne({ _id: payment._id }, { $set: { subscriptionId: subscription._id } });

      request.resultingSubscriptionId = subscription._id;
      request.paymentId = payment._id;
      await request.save();
      await issueInvoiceSafely(payment._id);

      // Credit worth more than the new plan: the excess goes back to the wallet, once.
      const walletRefundMinor = request.proration?.walletRefundMinor ?? 0;
      if (walletRefundMinor > 0) {
        await walletService
          .credit(
            request.tenantId,
            {
              amountMinor: walletRefundMinor,
              reason: `Unused time on ${request.proration?.sourcePlanCode ?? 'the previous plan'} returned on moving to ${plan.name}`,
              referenceType: 'subscription',
              referenceId: subscription._id,
              performedBy: actor.id,
              performedByName: actor.name,
            },
            'refund',
          )
          .catch((error) => {
            // Money owed to a customer: loud, and recorded on the payment for follow-up.
            logger.error('Returning unused plan credit to the wallet failed', {
              tenantId: String(request.tenantId),
              upgradeRequestId: String(request._id),
              amountMinor: walletRefundMinor,
              error: error instanceof Error ? error.message : 'unknown',
            });
            return PaymentModel.updateOne({ _id: payment._id }, { $set: { 'metadata.unreturnedCreditMinor': walletRefundMinor } });
          });
      }

      await subscriptionService.recordEvent(
        request.tenantId,
        subscription._id,
        'plan_changed',
        `Upgraded to ${plan.name} (manual ${request.paymentMethod} payment approved)`,
        actor,
        { transactionId: request.transactionId, amountMinor: request.amountMinor },
      );

      return { request: request.toObject(), subscription: subscription.toObject() };
    } catch (error) {
      // Nothing was activated: undo the claim so the request can be reviewed again
      // (and a wallet purchase, which calls this, refunds the customer).
      if (!request.resultingSubscriptionId) {
        if (paymentId) await PaymentModel.deleteOne({ _id: paymentId, subscriptionId: null });
        await UpgradeRequestModel.updateOne(
          { _id: request._id, status: 'approved', resultingSubscriptionId: null },
          { $set: { status: 'pending', reviewedBy: null, reviewedByNameSnapshot: '', reviewedAt: null, reviewNote: '' } },
        );
      }
      throw error;
    }
  }

  async reject(id: Types.ObjectId, actor: Actor, reviewNote: string) {
    const request = await UpgradeRequestModel.findById(id);
    if (!request) throw ApiError.notFound('Request not found');
    if (request.status !== 'pending') throw ApiError.badRequest(`This request is already ${request.status}`);

    request.status = 'rejected';
    request.reviewedBy = actor.id;
    request.reviewedByNameSnapshot = actor.name;
    request.reviewedAt = new Date();
    request.reviewNote = reviewNote;
    await request.save();

    if (request.couponId) await couponService.release(request.couponId, request.tenantId, request._id);
    return request.toObject();
  }
}

export const upgradeService = new UpgradeService();
