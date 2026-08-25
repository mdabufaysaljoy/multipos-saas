import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes';
import storeRoutes from '../modules/stores/stores.routes';
import categoryRoutes from '../modules/categories/categories.routes';
import productRoutes from '../modules/products/products.routes';
import inventoryRoutes from '../modules/inventory/inventory.routes';
import customerRoutes from '../modules/customers/customers.routes';
import saleRoutes from '../modules/sales/sales.routes';
import returnRoutes from '../modules/returns/returns.routes';
import staffRoutes from '../modules/staff/staff.routes';
import roleRoutes from '../modules/roles/roles.routes';
import reportRoutes from '../modules/reports/reports.routes';
import planRoutes from '../modules/plans/plans.routes';
import subscriptionRoutes from '../modules/subscriptions/subscriptions.routes';
import paymentRoutes from '../modules/payments/payments.routes';
import platformRoutes from '../modules/platform/platform.routes';
import uploadRoutes from '../modules/uploads/uploads.routes';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } });
});

// Tenant-facing POS API
router.use('/auth', authRoutes);
router.use('/stores', storeRoutes);
router.use('/categories', categoryRoutes);
router.use('/products', productRoutes);
router.use('/inventory', inventoryRoutes);
router.use('/customers', customerRoutes);
router.use('/sales', saleRoutes);
router.use('/returns', returnRoutes);
router.use('/staff', staffRoutes);
router.use('/roles', roleRoutes);
router.use('/reports', reportRoutes);
router.use('/uploads', uploadRoutes);

// Billing
router.use('/plans', planRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/payments', paymentRoutes);

// Platform administration, kept separate from the tenant surface
router.use('/platform', platformRoutes);

export default router;
