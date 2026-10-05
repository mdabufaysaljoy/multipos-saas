import assert from 'node:assert/strict';
import { Types } from 'mongoose';
import { POS_VERTICALS } from './verticals';
import { PRODUCT_LIMITS } from './productLimits';
import { ALL_PLAN_SEEDS, PLAN_SEEDS } from '../seed/plans.seed';
import { resolvePlanForVertical } from '../services/subscription/planEntitlements';
import { entitlementService, type Entitlement } from '../services/subscription/entitlement.service';
import { ApiError } from '../utils/ApiError';

const [starter, professional, enterprise] = PLAN_SEEDS;

assert.equal(starter.limits.maxProducts, PRODUCT_LIMITS.starter);
assert.equal(professional.limits.maxProducts, PRODUCT_LIMITS.professional);
assert.equal(enterprise.limits.maxProducts, PRODUCT_LIMITS.enterprise);

for (const plan of ALL_PLAN_SEEDS) {
  const expected = plan.code.startsWith('starter-')
    ? PRODUCT_LIMITS.starter
    : plan.code.startsWith('showroom-')
      ? PRODUCT_LIMITS.professional
      : PRODUCT_LIMITS.enterprise;

  assert.equal(plan.limits.maxProducts, expected, `${plan.code} has the wrong product limit`);
  for (const vertical of POS_VERTICALS) {
    assert.equal(
      resolvePlanForVertical(plan, vertical).limits.maxProducts,
      expected,
      `${plan.code} must resolve the same product limit for ${vertical}`,
    );
  }
}

const entitlementFor = (plan: (typeof PLAN_SEEDS)[number]): Entitlement => ({
  tenantId: new Types.ObjectId(),
  status: 'active',
  planCode: plan.code,
  planName: plan.name,
  vertical: 'clothing',
  interval: plan.interval,
  features: plan.features,
  limits: plan.limits,
  currentPeriodEnd: new Date(Date.now() + 86_400_000),
  daysRemaining: 1,
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  isUsable: true,
  isReadOnly: false,
});

const expectProductLimit = (run: () => void, expected: number) => {
  assert.throws(run, (error: unknown) => {
    if (!(error instanceof ApiError) || error.code !== 'LIMIT_EXCEEDED') return false;
    const details = error.details as { limit?: string; max?: number; current?: number } | undefined;
    return details?.limit === 'maxProducts' && details.max === expected;
  });
};

const starterEntitlement = entitlementFor(starter);
entitlementService.assertWithinLimit(starterEntitlement, 'maxProducts', 2_999, 'products');
expectProductLimit(
  () => entitlementService.assertWithinLimit(starterEntitlement, 'maxProducts', 3_000, 'products'),
  PRODUCT_LIMITS.starter,
);
entitlementService.assertOrdinalWithinLimit(starterEntitlement, 'maxProducts', 3_000, 'products');
expectProductLimit(
  () => entitlementService.assertOrdinalWithinLimit(starterEntitlement, 'maxProducts', 3_001, 'products'),
  PRODUCT_LIMITS.starter,
);

const professionalEntitlement = entitlementFor(professional);
entitlementService.assertWithinLimit(professionalEntitlement, 'maxProducts', 29_999, 'products');
expectProductLimit(
  () => entitlementService.assertWithinLimit(professionalEntitlement, 'maxProducts', 30_000, 'products'),
  PRODUCT_LIMITS.professional,
);
entitlementService.assertOrdinalWithinLimit(professionalEntitlement, 'maxProducts', 30_000, 'products');
expectProductLimit(
  () => entitlementService.assertOrdinalWithinLimit(professionalEntitlement, 'maxProducts', 30_001, 'products'),
  PRODUCT_LIMITS.professional,
);

const enterpriseEntitlement = entitlementFor(enterprise);
entitlementService.assertWithinLimit(enterpriseEntitlement, 'maxProducts', Number.MAX_SAFE_INTEGER, 'products');
entitlementService.assertOrdinalWithinLimit(enterpriseEntitlement, 'maxProducts', Number.MAX_SAFE_INTEGER, 'products');

console.log('Universal product limits: catalogue, vertical resolution and boundaries passed.');
