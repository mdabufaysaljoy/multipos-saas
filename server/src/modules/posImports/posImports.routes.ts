import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { PERMISSIONS } from '../../config/permissions';
import { isProd } from '../../config/env';
import { requireAccess } from '../../middleware/access';
import { requireActiveSubscription } from '../../middleware/subscription';
import { validate } from '../../middleware/validate';
import { ApiError } from '../../utils/ApiError';
import { idParam } from '../common/common.validators';
import { IMPORTS_PER_MINUTE, MAX_IMPORT_BYTES } from '../productImports/import.limits';
import { commitImportSchema, listImportsSchema } from '../productImports/import.validators';
import * as controller from './posImports.controller';

/**
 * The import routes a POS module mounts at `/imports`.
 *
 * The module has already established who is asking, which workspace and branch
 * they are in, and that its own vertical is the right one; this adds the
 * `productImport` entitlement, the `products.import` permission, the upload
 * rules and the rate limit - the same ones Clothing has used since the feature
 * was built.
 */

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'application/csv',
  'text/plain', // some browsers label a .csv this way
  'application/vnd.ms-excel', // and some label a .csv this way too
  'application/octet-stream', // and some send nothing useful at all
]);

/**
 * The upload is held in memory and parsed there; it is never written to disk.
 * A macro-enabled workbook fails the extension check - and nothing in a
 * workbook is executed regardless, because only cell values are read.
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

const importLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? IMPORTS_PER_MINUTE : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many imports. Wait a minute and try again.' } },
});

export function posImportRouter(): Router {
  const router = Router();
  router.use(requireAccess({ entitlement: 'productImport', permission: PERMISSIONS.PRODUCTS_IMPORT }));

  router.get('/columns', controller.importColumns);
  router.get('/', validate({ query: listImportsSchema }), controller.importHistory);
  router.post('/preview', requireActiveSubscription, importLimiter, upload.single('file'), controller.previewImport);
  router.post('/:id/commit', requireActiveSubscription, importLimiter, validate({ params: idParam, body: commitImportSchema }), controller.commitImport);
  router.post('/:id/cancel', validate({ params: idParam }), controller.cancelImport);

  return router;
}
