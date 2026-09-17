import { requireEntitlement } from '../../middleware/access';
import { Router } from 'express';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { requireVertical } from '../../middleware/vertical';
import { requireSubscribedAccess } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import * as controller from './reports.controller';
import { breakdownSchema, inventoryReportSchema, reportRangeSchema } from './reports.validators';

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
// Clothing POS reports: they read Clothing sales and inventory.
router.use(authenticate, resolveTenant, requireVertical('clothing'), requireSubscribedAccess);

// Final access to any report is: the PLAN includes it AND the USER's role grants
// `reports.view`. Both gates run on every route below.
const canView = requirePermission(PERMISSIONS.REPORTS_VIEW);

// ---------------------------------------------------------------- Dashboard
// The quick business overview. Available on every plan, including Starter.
router.get('/overview', canView, validate({ query: reportRangeSchema }), controller.overview);

// ------------------------------------------------------- Advanced Analytics
// Everything else is detailed analysis, sold on Showroom and Brand only. The
// gate sits on EVERY analytics route, not just the page the UI links to, so a
// Starter workspace cannot obtain the data by calling the API directly.
const advanced = requireEntitlement('advancedAnalytics');
// Branch comparison is meaningless on a single-branch plan, and is sold as part
// of multi-store. Reusing that flag beats inventing a second one for it.
const multiBranch = requireEntitlement('multiBranch');

// Legacy combined endpoint: carries staff, category and variant breakdowns.
router.get('/dashboard', advanced, canView, validate({ query: reportRangeSchema }), controller.dashboard);
router.get('/sales', advanced, canView, validate({ query: reportRangeSchema }), controller.salesAndProfit);
router.get('/breakdown', advanced, canView, validate({ query: breakdownSchema }), controller.breakdown);
router.get('/payments', advanced, canView, validate({ query: reportRangeSchema }), controller.payments);
router.get('/returns', advanced, canView, validate({ query: reportRangeSchema }), controller.returns);
router.get('/staff', advanced, canView, validate({ query: reportRangeSchema }), controller.staff);
router.get('/inventory', advanced, canView, validate({ query: inventoryReportSchema }), controller.inventory);
router.get('/customers', advanced, canView, validate({ query: reportRangeSchema }), controller.customers);
router.get('/branches', advanced, multiBranch, canView, validate({ query: reportRangeSchema }), controller.branches);

export default router;
