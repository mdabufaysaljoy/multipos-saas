import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { PERMISSIONS } from '../../config/permissions';
import { isProd } from '../../config/env';
import { requireAccess } from '../../middleware/access';
import { authenticate } from '../../middleware/auth';
import { requireActiveSubscription, requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { validate } from '../../middleware/validate';
import { requireVertical } from '../../middleware/vertical';
import { ApiError } from '../../utils/ApiError';
import { idParam } from '../common/common.validators';
import * as controller from './import.controller';
import { IMPORTS_PER_MINUTE, MAX_IMPORT_BYTES } from './import.limits';
import { commitImportSchema, listImportsSchema } from './import.validators';

/**
 * Bulk product import (Clothing POS).
 *
 * Every route: signed in -> workspace + branch -> Clothing -> usable
 * subscription -> the `productImport` entitlement -> the `products.import`
 * permission.
 *
 * The entitlement is deliberately ITS OWN: `productImport` is part of every
 * plan, while `dataExport` (Data export) is not. Neither can turn the other on
 * or off.
 */
const router = Router();

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'application/csv',
  'text/plain', // some browsers label a .csv this way
  'application/vnd.ms-excel', // and some label a .csv this way too
  'application/octet-stream', // and some send nothing useful at all
]);

/**
 * The upload is held in memory and parsed there; it is never written to disk,
 * so there is no uploaded file at rest. A macro-enabled workbook (.xlsm) fails
 * the extension check below - and nothing in a workbook is executed regardless,
 * because only cell values are read.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(xlsx|csv)$/i.test(file.originalname)) {
      cb(ApiError.badRequest('Only Excel (.xlsx) and CSV (.csv) files are supported.'));
      return;
    }
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(ApiError.badRequest('That file type is not supported. Upload an Excel (.xlsx) or CSV (.csv) file.'));
      return;
    }
    cb(null, true);
  },
});

router.use(
  authenticate,
  resolveTenant,
  requireVertical('clothing'),
  requireSubscribedAccess,
  requireAccess({ entitlement: 'productImport', permission: PERMISSIONS.PRODUCTS_IMPORT }),
);

// Parsing a file and creating thousands of records are both expensive.
const importLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? IMPORTS_PER_MINUTE : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many imports. Wait a minute and try again.' } },
});

router.get('/columns', controller.columns);
router.get('/', validate({ query: listImportsSchema }), controller.history);

router.post('/preview', requireActiveSubscription, importLimiter, upload.single('file'), controller.preview);
router.post('/:id/commit', requireActiveSubscription, importLimiter, validate({ params: idParam, body: commitImportSchema }), controller.commit);
router.post('/:id/cancel', validate({ params: idParam }), controller.cancel);

export default router;
