/* eslint-disable no-console */
import mongoose, { Types } from 'mongoose';
import dayjs from 'dayjs';
import { connectDatabase, disconnectDatabase } from '../config/db';
import { env } from '../config/env';
import { PERMISSIONS, PERMISSION_CATALOG, DEFAULT_CASHIER_PERMISSIONS } from '../config/permissions';
import { ROLES, SUBSCRIPTION_STATUS } from '../config/constants';
import {
  CategoryModel,
  CounterModel,
  CustomerModel,
  InventoryTransactionModel,
  PaymentModel,
  PermissionModel,
  ProductModel,
  ProductVariantModel,
  RefreshTokenModel,
  ReturnModel,
  RoleModel,
  SaleModel,
  StoreModel,
  SubscriptionEventModel,
  SubscriptionModel,
  SubscriptionPlanModel,
  TenantModel,
  UserModel,
  hashPassword,
} from '../models';
import { codeFromName, slugify, uniqueSlug } from '../utils/slug';
import { buildPlanSnapshot } from '../services/subscription/provisioning.service';
import { createSystemRoles } from '../modules/roles/roles.defaults';
import { seedPlans } from './plans.seed';
import { SEED_CATEGORIES, SEED_CUSTOMERS, SEED_PRODUCTS } from './catalog.seed';

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
    UserModel.deleteMany({}),
  ]);
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
    console.log('\n  A demo tenant already exists. Re-run with --reset to rebuild it.\n');
    await disconnectDatabase();
    return;
  }

  const tenantId = new Types.ObjectId();
  const adminId = new Types.ObjectId();
  const businessName = 'Denim Republic';

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

  await TenantModel.create({
    _id: tenantId,
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

  const roles = await createSystemRoles(tenantId);
  const cashierRole = roles.find((r) => r.name === 'Cashier')!;
  const seniorRole = roles.find((r) => r.name === 'Senior Cashier')!;
  console.log(`  Tenant "${businessName}" with ${roles.length} roles`);

  // Active paid subscription, so the demo workspace is immediately usable.
  const plan = await SubscriptionPlanModel.findOne({ code: 'showroom-monthly' });
  if (plan) {
    const start = dayjs().subtract(3, 'day').toDate();
    const end = dayjs(start).add(1, 'month').toDate();
    const subscription = await SubscriptionModel.create({
      tenantId,
      planId: plan._id,
      planSnapshot: buildPlanSnapshot(plan),
      status: SUBSCRIPTION_STATUS.ACTIVE,
      startedAt: start,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      autoRenew: false,
      provider: 'manual',
      isManual: true,
      notes: 'Seeded development subscription',
    });

    await SubscriptionEventModel.create({
      tenantId,
      subscriptionId: subscription._id,
      type: 'activated',
      message: `Seeded "${plan.name}" subscription`,
      actorNameSnapshot: 'seed',
    });

    await PaymentModel.create({
      tenantId,
      userId: adminId,
      subscriptionId: subscription._id,
      planId: plan._id,
      amountMinor: plan.priceMinor,
      currency: plan.currency,
      provider: 'manual',
      providerReference: 'SEED-0001',
      status: 'paid',
      paidAt: start,
      metadata: { seeded: true },
    });

    await TenantModel.updateOne(
      { _id: tenantId },
      { $set: { subscriptionStatus: SUBSCRIPTION_STATUS.ACTIVE, currentSubscriptionId: subscription._id, subscriptionEndsAt: end } },
    );
    console.log(`  Subscription: ${plan.name} until ${dayjs(end).format('D MMM YYYY')}`);
  }

  // ----------------------------------------------------------------- staff
  // Deliberately WITHOUT sales.changePrice, so the permission gate is testable.
  const cashier = await UserModel.create({
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
  for (const seed of SEED_PRODUCTS) {
    const baseSku = codeFromName(`${seed.brand}${seed.name}`, 6);
    const categoryId = categoryByName.get(seed.category) ?? null;

    const options: { name: string; values: string[] }[] = [];
    if (seed.colors.length) options.push({ name: 'Color', values: seed.colors });
    if (seed.sizes.length) options.push({ name: 'Size', values: seed.sizes });

    const product = await ProductModel.create({
      tenantId,
      storeId: store._id,
      name: seed.name,
      sku: `${baseSku}${Math.floor(Math.random() * 90 + 10)}`,
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
