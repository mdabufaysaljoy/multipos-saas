import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requireAnyPermission, requirePermission } from '../../middleware/rbac';
import { resolveTenant } from '../../middleware/tenant';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created } from '../../utils/apiResponse';
import { storage } from '../../services/storage';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

// Memory storage keeps the storage driver in charge of where bytes finally land.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      cb(ApiError.badRequest('Only JPEG, PNG, WebP and AVIF images are allowed'));
      return;
    }
    cb(null, true);
  },
});

const router = Router();
router.use(authenticate, resolveTenant);

/** Shared handler - only the destination folder differs between routes. */
const uploadTo = (folder: string) =>
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file was uploaded');
    const ctx = req.ctx!;

    // Namespacing by tenant keeps one workspace's assets out of another's path.
    const stored = await storage.save({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      folder: `tenants/${ctx.tenantId}/${folder}`,
    });

    created(res, stored);
  });

// Product imagery: anyone who may create or edit a product.
router.post(
  '/image',
  requireAnyPermission(PERMISSIONS.PRODUCTS_CREATE, PERMISSIONS.PRODUCTS_EDIT),
  upload.single('file'),
  uploadTo('products'),
);

// Store branding (receipt logo) is a settings-level action, not a catalogue one.
router.post(
  '/logo',
  requirePermission(PERMISSIONS.SETTINGS_EDIT),
  upload.single('file'),
  uploadTo('branding'),
);

export default router;
