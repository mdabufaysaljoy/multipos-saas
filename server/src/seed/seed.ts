import { withLedgerMaintenance } from '../utils/ledgerMaintenance';
import mongoose, { Types } from 'mongoose';
import dayjs from 'dayjs';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import { PERMISSION_CATALOG } from '../config/permissions';
import { ROLES, SUBSCRIPTION_STATUS } from '../config/constants';
import {
  CategoryModel,
  CounterModel,
  CustomerModel,
  InventoryTransactionModel,
  PaymentModel,
  PermissionModel,
  PlatformSettingsModel,
  ProductModel,
  ProductVariantModel,
  RefreshTokenModel,
  ReturnModel,
  RoleModel,
  SaleModel,
  StorageObjectModel,
  StoreModel,
  SubscriptionEventModel,
  SubscriptionModel,
  SubscriptionPlanModel,
  TenantModel,
  TopUpRequestModel,
  UpgradeRequestModel,
  WalletModel,
  WalletTransactionModel,
  CouponModel,
  CouponRedemptionModel,
  UserModel,
  hashPassword,
} from '../models';
import { codeFromName, slugify, uniqueSlug } from '../utils/slug';
import { buildPlanSnapshot } from '../services/subscription/provisioning.service';
import { verticalOfTenant } from '../services/subscription/planEntitlements';
import { promoteToPrimary } from '../services/subscription/primarySubscription';
import { PRIMARY_FIRST } from '../models/Subscription';
import { createSystemRoles } from '../modules/roles/roles.defaults';
import { seedPlans } from './plans.seed';
import { AccountModel } from '../models/Account';
import { DEFAULT_POS_VERTICAL } from '../config/verticals';
import { ensureAccountForOwner } from '../services/account/account.service';
import { SEED_CATEGORIES, SEED_CUSTOMERS, SEED_PRODUCTS } from './catalog.seed';
import { issueInvoiceSafely } from '../services/billing/invoice.service';

const RESET = process.argv.includes('--reset') || process.argv.includes('--fresh');

async function clearAll() {
  console.log('  Clearing existing collections...');
  await Promise.all([
    CategoryModel.deleteMany({}),
    CounterModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    InventoryTransactionModel.deleteMany({}),
    PaymentModel.deleteMany({}),
    PermissionModel.deleteMany({}),
    PlatformSettingsModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    RefreshTokenModel.deleteMany({}),
    ReturnModel.deleteMany({}),
    RoleModel.deleteMany({}),
    SaleModel.deleteMany({}),
    StoreModel.deleteMany({}),
    SubscriptionEventModel.deleteMany({}),
    SubscriptionModel.deleteMany({}),
    SubscriptionPlanModel.deleteMany({}),
    TenantModel.deleteMany({}),
    AccountModel.deleteMany({}),
    UpgradeRequestModel.deleteMany({}),
    TopUpRequestModel.deleteMany({}),
    WalletModel.deleteMany({}),
    // A development reset is the one sanctioned removal of ledger history.
    withLedgerMaintenance('development seed reset', () => WalletTransactionModel.deleteMany({}).exec()),
    CouponModel.deleteMany({}),
    CouponRedemptionModel.deleteMany({}),
    // Without this a reseeded database reports phantom storage usage: the
    // tenants are gone but their ledger rows are not.
    StorageObjectModel.deleteMany({}),
    UserModel.deleteMany({}),
  ]);
}

/**
 * Gives the demo tenant the subscription the seed intends: an ACTIVE monthly
 * Showroom plan.
 *
 * Idempotent. A workspace already on an active, unexpired Showroom subscription
 * is left exactly as it is; anything else is replaced with a fresh one, which
 * is what makes `npm run seed` a reliable way to undo experimentation.
 */
const DEMO_PLAN_CODE = 'showroom-monthly';
/** The demo workspace's name; its branch codes derive from this. */
const BUSINESS_NAME = 'Denim Republic';

async function ensureDemoSubscription(tenantId: Types.ObjectId, adminId: Types.ObjectId | null) {
  const plan = await SubscriptionPlanModel.findOne({ code: DEMO_PLAN_CODE });
  if (!plan) {
    console.log(`  Demo subscription skipped: plan "${DEMO_PLAN_CODE}" is not seeded.`);
    return;
  }

  const current = await SubscriptionModel.findOne({ tenantId }).sort(PRIMARY_FIRST).lean();
  const healthy =
    current?.planSnapshot?.code === DEMO_PLAN_CODE &&
    current.status === SUBSCRIPTION_STATUS.ACTIVE &&
    current.currentPeriodEnd > new Date();

  if (healthy) {
    console.log(`  Subscription: already on ${plan.name}, left unchanged`);
    return;
  }

  const start = dayjs().subtract(3, 'day').toDate();
  const end = dayjs(start).add(1, 'month').toDate();

  // Close anything running so only one subscription is ever live.
  await SubscriptionModel.updateMany(
    { tenantId, status: { $nin: [SUBSCRIPTION_STATUS.EXPIRED, SUBSCRIPTION_STATUS.CANCELLED] } },
    { $set: { status: SUBSCRIPTION_STATUS.EXPIRED, autoRenew: false } },
  );

  const subscription = await SubscriptionModel.create({
    tenantId,
    planId: plan._id,
    planSnapshot: buildPlanSnapshot(plan, await verticalOfTenant(tenantId)),
    status: SUBSCRIPTION_STATUS.ACTIVE,
    startedAt: start,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    autoRenew: false,
    provider: 'manual',
    isManual: true,
    notes: 'Seeded development subscription',
  });
  await promoteToPrimary(tenantId, subscription._id);

  await SubscriptionEventModel.create({
    tenantId,
    subscriptionId: subscription._id,
    type: 'activated',
    message: `Seeded "${plan.name}" subscription`,
    actorNameSnapshot: 'seed',
  });

  if (adminId) {
    const seededPayment = await PaymentModel.create({
      tenantId,
      userId: adminId,
      subscriptionId: subscription._id,
      planId: plan._id,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      provider: 'manual',
      providerReference: `SEED-${subscription._id.toString().slice(-6).toUpperCase()}`,
      status: 'paid',
      paidAt: start,
      metadata: { seeded: true },
    });
    await issueInvoiceSafely(seededPayment._id);
  }

  await TenantModel.updateOne(
    { _id: tenantId },
    { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE, currentSubscriptionId: subscription._id, subscriptionEndsAt: end } },
  );
  console.log(`  Subscription: ${plan.name} until ${dayjs(end).format('D MMM YYYY')}`);
}

/**
 * Keeps the demo workspace at exactly the two branches the seed creates.
 *
 * Anything beyond those two is development leftovers, so it is soft-deleted -
 * the same mechanism the app uses, which preserves the sales history attached
 * to those branches rather than orphaning it.
 *
 * Idempotent: a workspace already on the seeded two is untouched, so repeated
 * seeding never accumulates branches.
 */
async function ensureDemoBranches(tenantId: Types.ObjectId) {
  const seeded = [codeFromName(BUSINESS_NAME), `${codeFromName(BUSINESS_NAME)}2`];

  const extras = await StoreModel.find({
    tenantId,
    deletedAt: null,
    code: { $nin: seeded },
  })
    .select('_id name')
    .lean();

  if (extras.length === 0) return;

  await StoreModel.updateMany(
    { _id: { $in: extras.map((s) => s._id) } },
    { $set: { deletedAt: new Date(), isActive: false, isDefault: false } },
  );
  console.log(`  Branches: removed ${extras.length} left over from development`);
}

/** Mirrors the in-code permission catalogue into the database. */
async function seedPermissions() {
  for (const group of PERMISSION_CATALOG) {
    for (const permission of group.permissions) {
      await PermissionModel.updateOne(
        { key: permission.key },
        { $set: { group: group.group, label: permission.label, description: permission.description } },
        { upsert: true },
      );
    }
  }
}

async function main() {
  console.log('\nSeeding the Clothing POS database\n');
  await connectDatabase();

  if (RESET) await clearAll();

  // -------------------------------------------------------------- platform
  const planCount = await seedPlans();
  console.log(`  ${planCount} subscription plans`);

  // Manual-payment instructions are data, editable by a platform admin.
  await PlatformSettingsModel.updateOne(
    { key: 'platform' },
    {
      $set: {
        supportEmail: 'support@pos.dev',
        supportPhone: '+880 1700-111222',
        smsCostMinor: 50,
        // Carried over from the environment so an existing deployment keeps
        // working after credentials moved into the database. A platform admin
        // edits them in the UI from here on.
        sms: {
          provider: 'alpha',
          apiKey: process.env.ALPHA_SMS_API_KEY ?? '',
          baseUrl: process.env.ALPHA_SMS_BASE_URL || 'https://api.sms.net.bd',
          senderId: process.env.ALPHA_SMS_SENDER_ID ?? '',
          enabled: Boolean(process.env.ALPHA_SMS_API_KEY),
        },
        paymentInstructions: [
          {
            method: 'bkash',
            label: 'bKash',
            accountNumber: '01700-111222',
            accountName: 'Clothing POS Ltd',
            steps: [
              'Open the bKash app and choose Send Money.',
              'Send the exact plan amount to the number above.',
              'Copy the Transaction ID from the confirmation message.',
              'Enter it below - we verify before activating your plan.',
            ],
            isActive: true,
          },
          {
            method: 'nagad',
            label: 'Nagad',
            accountNumber: '01800-333444',
            accountName: 'Clothing POS Ltd',
            steps: ['Open Nagad and choose Send Money.', 'Send the plan amount.', 'Enter the Transaction ID below.'],
            isActive: true,
          },
          {
            method: 'bank',
            label: 'Bank transfer',
            accountNumber: '1234 5678 9012',
            accountName: 'Clothing POS Ltd — City Bank',
            steps: ['Transfer the plan amount to the account above.', 'Enter the bank reference number below.'],
            isActive: true,
          },
        ],
      },
    },
    { upsert: true },
  );
  console.log('  Platform payment instructions');

  // A demo coupon so the discount path is exercisable out of the box.
  await CouponModel.updateOne(
    { code: 'LAUNCH20' },
    {
      $set: {
        code: 'LAUNCH20',
        description: '20% off any plan, capped at BDT 1,000',
        discountType: 'percent',
        discountValue: 2000,
        maxDiscountMinor: 100_000,
        usageLimit: 100,
        perTenantLimit: 1,
        isActive: true,
      },
    },
    { upsert: true },
  );
  console.log('  Demo coupon LAUNCH20');

  await seedPermissions();
  console.log(`  Permission catalogue mirrored`);

  const platformAdminEmail = env.SEED_PLATFORM_ADMIN_EMAIL;
  await UserModel.updateOne(
    { email: platformAdminEmail, tenantId: null },
    {
      $set: {
        name: 'Platform Administrator',
        role: ROLES.PLATFORM_ADMIN,
        passwordHash: await hashPassword(env.SEED_PLATFORM_ADMIN_PASSWORD),
        isActive: true,
        tenantId: null,
        storeId: null,
      },
    },
    { upsert: true },
  );
  console.log(`  Platform admin: ${platformAdminEmail}`);

  // ---------------------------------------------------------------- tenant
  const existingTenant = await TenantModel.findOne({ contactEmail: env.SEED_TENANT_ADMIN_EMAIL });
  if (existingTenant && !RESET) {
    // The demo subscription drifts whenever someone changes plans while trying
    // the app out, so every seed run puts it back. Scoped strictly to the demo
    // tenant - matched on the seed admin's email - so no customer workspace is
    // ever touched by the seed.
    const admin = await UserModel.findOne({ email: env.SEED_TENANT_ADMIN_EMAIL }).select('_id').lean();
    await ensureDemoSubscription(existingTenant._id, admin?._id ?? null);
    await ensureDemoBranches(existingTenant._id);
    // A demo tenant from before the account layer gets linked; an existing link
    // is left as it is.
    if (!existingTenant.accountId) {
      const accountId = await ensureAccountForOwner(existingTenant.ownerUserId, {
        name: existingTenant.name,
        contactEmail: existingTenant.contactEmail,
      });
      await TenantModel.updateOne(
        { _id: existingTenant._id, accountId: null },
        { $set: { accountId, vertical: existingTenant.vertical ?? DEFAULT_POS_VERTICAL } },
      );
    }

    console.log('\n  A demo tenant already exists; its subscription was restored.');
    console.log('  Re-run with --reset to rebuild everything.\n');
    await disconnectDatabase();
    return;
  }

  const tenantId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const businessName = BUSINESS_NAME;

  const admin = await UserModel.create({
    _id: adminId,
    tenantId,
    name: 'Ayesha Rahman',
    email: env.SEED_TENANT_ADMIN_EMAIL,
    phone: '01700000000',
    passwordHash: await hashPassword(env.SEED_TENANT_ADMIN_PASSWORD),
    role: ROLES.ADMIN,
    isActive: true,
  });

  const accountId = await ensureAccountForOwner(adminId, {
    name: businessName,
    contactEmail: env.SEED_TENANT_ADMIN_EMAIL,
  });

  await TenantModel.create({
    _id: tenantId,
    accountId,
    vertical: DEFAULT_POS_VERTICAL,
    name: businessName,
    slug: uniqueSlug(businessName),
    ownerUserId: adminId,
    status: 'active',
    contactEmail: env.SEED_TENANT_ADMIN_EMAIL,
    contactPhone: '01700000000',
  });

  const store = await StoreModel.create({
    tenantId,
    name: `${businessName} - Dhanmondi`,
    code: codeFromName(businessName),
    phone: '+880 1700-000000',
    email: env.SEED_TENANT_ADMIN_EMAIL,
    address: 'House 42, Road 27, Dhanmondi, Dhaka 1209',
    currency: env.DEFAULT_CURRENCY,
    invoicePrefix: 'INV-',
    returnPrefix: 'RET-',
    lowStockThreshold: 5,
    isDefault: true,
    receipt: {
      headerText: 'Denim Republic',
      footerText: 'Thank you for shopping with us!',
      returnPolicy: 'Exchange within 7 days with the original receipt. Sale items are final.',
      showLogo: true,
      showCashier: true,
      paperWidthMm: 58,
    },
  });

  await UserModel.updateOne({ _id: adminId }, { $set: { storeId: store._id } });

  // The demo plan (Showroom) allows two branches, and a second one is what
  // makes the multi-branch features worth looking at.
  await StoreModel.create({
    tenantId,
    name: `${businessName} - Gulshan`,
    code: `${codeFromName(businessName)}2`,
    phone: '+880 1700-000001',
    email: env.SEED_TENANT_ADMIN_EMAIL,
    address: 'Plot 9, Road 11, Gulshan 1, Dhaka 1212',
    currency: env.DEFAULT_CURRENCY,
    invoicePrefix: 'INV-',
    returnPrefix: 'RET-',
    lowStockThreshold: 5,
    isDefault: false,
    receipt: {
      headerText: 'Denim Republic',
      footerText: 'Thank you for shopping with us!',
      returnPolicy: 'Exchange within 7 days with the original receipt. Sale items are final.',
      showLogo: true,
      showCashier: true,
      paperWidthMm: 58,
    },
  });

  const roles = await createSystemRoles(tenantId);
  const cashierRole = roles.find((r) => r.name === 'Cashier')!;
  const seniorRole = roles.find((r) => r.name === 'Senior Cashier')!;
  console.log(`  Tenant "${businessName}" with ${roles.length} roles`);

  await ensureDemoSubscription(tenantId, adminId);

  // ----------------------------------------------------------------- staff
  // Deliberately WITHOUT sales.changePrice, so the permission gate is testable.
  await UserModel.create({
    tenantId,
    storeId: store._id,
    name: 'Sabbir Ahmed',
    email: env.SEED_STAFF_EMAIL,
    phone: '01700000001',
    passwordHash: await hashPassword(env.SEED_STAFF_PASSWORD),
    role: ROLES.STAFF,
    roleId: cashierRole._id,
    extraPermissions: [],
    deniedPermissions: [],
    isActive: true,
  });

  // A second cashier who CAN override prices, for comparison.
  await UserModel.create({
    tenantId,
    storeId: store._id,
    name: 'Mitu Chowdhury',
    email: 'senior@demostore.dev',
    phone: '01700000002',
    passwordHash: await hashPassword(env.SEED_STAFF_PASSWORD),
    role: ROLES.STAFF,
    roleId: seniorRole._id,
    isActive: true,
  });
  console.log('  2 staff accounts');

  // ------------------------------------------------------------ categories
  const categoryByName = new Map<string, Types.ObjectId>();
  for (const category of SEED_CATEGORIES) {
    const doc = await CategoryModel.create({
      tenantId,
      storeId: store._id,
      name: category.name,
      slug: slugify(category.name),
      description: category.description,
      isActive: true,
    });
    categoryByName.set(category.name, doc._id);
  }
  console.log(`  ${SEED_CATEGORIES.length} categories`);

  // -------------------------------------------------------------- products
  let variantCount = 0;
  for (const [productIndex, seed] of SEED_PRODUCTS.entries()) {
    const baseSku = codeFromName(`${seed.brand}${seed.name}`, 6);
    const categoryId = categoryByName.get(seed.category) ?? null;

    const options: { name: string; values: string[] }[] = [];
    if (seed.colors.length) options.push({ name: 'Color', values: seed.colors });
    if (seed.sizes.length) options.push({ name: 'Size', values: seed.sizes });

    const product = await ProductModel.create({
      tenantId,
      storeId: store._id,
      name: seed.name,
      // The position in the seed list, not a random number: two products whose
      // names share a 6-letter prefix got the same random suffix often enough to
      // fail a seed run on the unique SKU index. Positions never repeat.
      sku: `${baseSku}${String(productIndex + 1).padStart(2, '0')}`,
      categoryId,
      categoryNameSnapshot: seed.category,
      description: seed.description,
      brand: seed.brand,
      options,
      hasVariants: options.length > 0,
      isActive: true,
      createdBy: adminId,
    });

    // Cartesian product of the option axes -> one sellable variant each.
    const combos: { name: string; value: string }[][] = [];
    if (seed.colors.length && seed.sizes.length) {
      for (const color of seed.colors) {
        for (const size of seed.sizes) {
          combos.push([{ name: 'Color', value: color }, { name: 'Size', value: size }]);
        }
      }
    } else if (seed.colors.length) {
      for (const color of seed.colors) combos.push([{ name: 'Color', value: color }]);
    } else if (seed.sizes.length) {
      for (const size of seed.sizes) combos.push([{ name: 'Size', value: size }]);
    } else {
      combos.push([]);
    }

    for (const [index, attributes] of combos.entries()) {
      const label = attributes.length ? attributes.map((a) => a.value).join(' / ') : 'Default';
      const suffix = attributes.length ? attributes.map((a) => codeFromName(a.value, 3)).join('-') : 'STD';

      const variant = await ProductVariantModel.create({
        tenantId,
        storeId: store._id,
        productId: product._id,
        productNameSnapshot: product.name,
        name: label,
        attributes,
        sku: `${product.sku}-${suffix}-${index + 1}`,
        sellingPriceMinor: seed.basePriceMinor,
        costPriceMinor: seed.costPriceMinor,
        stock: seed.stockPerVariant,
        lowStockThreshold: 4,
        isActive: true,
      });

      await InventoryTransactionModel.create({
        tenantId,
        storeId: store._id,
        productId: product._id,
        variantId: variant._id,
        productNameSnapshot: product.name,
        variantNameSnapshot: variant.name,
        skuSnapshot: variant.sku,
        type: 'INITIAL_STOCK',
        quantityChange: variant.stock,
        previousStock: 0,
        newStock: variant.stock,
        reason: 'Seeded opening stock',
        referenceType: 'product',
        referenceId: product._id,
        performedBy: adminId,
        performedByNameSnapshot: admin.name,
      });

      variantCount += 1;
    }
  }
  console.log(`  ${SEED_PRODUCTS.length} products / ${variantCount} variants with opening stock`);

  // ------------------------------------------------------------- customers
  for (const customer of SEED_CUSTOMERS) {
    await CustomerModel.create({ tenantId, storeId: store._id, ...customer });
  }
  console.log(`  ${SEED_CUSTOMERS.length} customers`);

  console.log(`
------------------------------------------------------------------
 Seed complete. Development sign-in details:
------------------------------------------------------------------
 Platform admin   ${env.SEED_PLATFORM_ADMIN_EMAIL} / ${env.SEED_PLATFORM_ADMIN_PASSWORD}
 Tenant admin     ${env.SEED_TENANT_ADMIN_EMAIL} / ${env.SEED_TENANT_ADMIN_PASSWORD}
 Cashier          ${env.SEED_STAFF_EMAIL} / ${env.SEED_STAFF_PASSWORD}
   - role "Cashier": CANNOT change prices at checkout
 Senior cashier   senior@demostore.dev / ${env.SEED_STAFF_PASSWORD}
   - role "Senior Cashier": CAN change prices at checkout

 These credentials are for local development only.
------------------------------------------------------------------
`);

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('\nSeeding failed:\n', error);
  await mongoose.connection.close().catch(() => undefined);
  process.exit(1);
});
