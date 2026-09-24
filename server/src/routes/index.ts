import paymentProviderRoutes from '../modules/paymentProviders/paymentProviders.routes';
import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import storeRoutes from '../modules/stores/stores.routes';
import paymentMethodRoutes from '../modules/paymentMethods/paymentMethods.routes';
import categoryRoutes from '../modules/categories/categories.routes';
import productRoutes from '../modules/products/products.routes';
import productImportRoutes from '../modules/productImports/import.routes';
import supplierRoutes from '../modules/suppliers/suppliers.routes';
import inventoryRoutes from '../modules/inventory/inventory.routes';
import customerRoutes from '../modules/customers/customers.routes';
import loyaltyRoutes from '../modules/loyalty/loyalty.routes';
import printingRoutes from '../modules/printing/printing.routes';
import exportRoutes from '../modules/exports/export.routes';
import saleRoutes from '../modules/sales/sales.routes';
import returnRoutes from '../modules/returns/returns.routes';
import staffRoutes from '../modules/staff/staff.routes';
import memberRoutes from '../modules/staff/members.routes';
import roleRoutes from '../modules/roles/roles.routes';
import reportRoutes from '../modules/reports/reports.routes';
import planRoutes from '../modules/plans/plans.routes';
import pricingRoutes from '../modules/pricing/pricing.routes';
import subscriptionRoutes from '../modules/subscriptions/subscriptions.routes';
import paymentRoutes from '../modules/payments/payments.routes';
import platformRoutes from '../modules/platform/platform.routes';
import uploadRoutes from '../modules/uploads/uploads.routes';
import walletRoutes from '../modules/wallet/wallet.routes';
import messagingRoutes from '../modules/messaging/messaging.routes';
import workspaceRoutes from '../modules/workspaces/workspaces.routes';
import accountRoutes from '../modules/account/account.routes';
import restaurantRoutes from '../modules/restaurant/restaurant.routes';
import pharmacyRoutes from '../modules/pharmacy/pharmacy.routes';
import supershopRoutes from '../modules/supershop/supershop.routes';

const router = Router();

// Public marketing data - no authentication, no tenant data.
router.get('/public/contact', async (_req, res, next) => {
  try {
    const { getPlatformSettings } = await import('../models/PlatformSettings');
    const settings = await getPlatformSettings();
    res.json({
      success: true,
      data: { supportEmail: settings.supportEmail, supportPhone: settings.supportPhone },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
});

// Tenant-facing POS API
router.use('/auth', authRoutes);
// Account-level: the owner's account and its workspaces, not scoped to the active workspace.
router.use('/account', accountRoutes);
router.use('/workspaces', workspaceRoutes);
router.use('/stores', storeRoutes);
// The tenders a workspace takes, in every vertical.
router.use('/payment-methods', paymentMethodRoutes);
router.use('/categories', categoryRoutes);
// Before the product routes: "import" must not be parsed as a product id.
router.use('/products/import', productImportRoutes);
router.use('/products', productRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/customers', customerRoutes);
router.use('/loyalty', loyaltyRoutes);
router.use('/printing', printingRoutes);
router.use('/exports', exportRoutes);
router.use('/sales', saleRoutes);
router.use('/returns', returnRoutes);
// Registered before `/staff` so "members" is never read as a staff id.
router.use('/staff/members', memberRoutes);
router.use('/staff', staffRoutes);
router.use('/roles', roleRoutes);
router.use('/reports', reportRoutes);
router.use('/uploads', uploadRoutes);

// Restaurant POS vertical (guarded to Restaurant workspaces inside the router)
router.use('/restaurant', restaurantRoutes);
// Pharmacy POS vertical (guarded to Pharmacy workspaces inside the router)
router.use('/pharmacy', pharmacyRoutes);
// Supershop POS vertical (guarded to Supershop workspaces inside the router)
router.use('/supershop', supershopRoutes);

// Billing
router.use('/plans', planRoutes);
// Universal plan catalog + pricing engine (read-only here; managed under /platform/pricing)
router.use('/pricing', pricingRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/payments', paymentRoutes);
// Self-hosted payment-SMS relays report here; device-authenticated, never user-authenticated.
router.use('/payment-providers', paymentProviderRoutes);
router.use('/wallet', walletRoutes);
router.use('/messaging', messagingRoutes);

// Platform administration, kept separate from the tenant surface
router.use('/platform', platformRoutes);

export default router;
