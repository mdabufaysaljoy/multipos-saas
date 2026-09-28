import { Router } from 'express';
import multer from 'multer';
import { PERMISSIONS } from '../../config/permissions';
import { authenticate } from '../../middleware/auth';
import { requireAnyPermission, requirePermission } from '../../middleware/rbac';
import { requireSubscribedAccess } from '../../middleware/subscription';
import { resolveTenant } from '../../middleware/tenant';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created } from '../../utils/apiResponse';
import { storage } from '../../services/storage';
import { StorageObjectModel } from '../../models/StorageObject';
import { inspectImage, optimizeToWebp } from '../../services/storage/imageOptimizer';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/**
 * Hard ceiling on what the server will even read into memory.
 *
 * Every subscribed workspace is optimised down to WebP before anything is
 * stored, so a full-resolution camera image is accepted. The cap still exists
 * because an unbounded upload is a denial-of-service regardless of plan.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Memory storage keeps the storage driver in charge of where bytes finally land.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      cb(ApiError.badRequest('Only JPEG, PNG, WebP and AVIF images are allowed'));
      return;
    }
    cb(null, true);
  },
});

const router = Router();
// An unsubscribed workspace can reach only its wallet and subscription;
// this module is locked entirely until a plan is active.
router.use(authenticate, resolveTenant, requireSubscribedAccess);

/** Shared handler - only the destination folder differs between routes. */
const uploadTo = (folder: string) =>
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file was uploaded');
    const ctx = req.ctx!;

    // The declared content type comes from the client and can say anything, so
    // the bytes are inspected before we agree this is an image at all.
    const inspected = await inspectImage(req.file.buffer);
    if (!inspected.ok) throw ApiError.badRequest(inspected.reason ?? 'That file is not a valid image');

    // Optimise before saving so only the final WebP bytes reach the provider.
    const result = await optimizeToWebp(req.file.buffer, req.file.size);
    const originalName = `${req.file.originalname.replace(/\.[^.]+$/, '')}${result.extension}`;
    const optimisation = {
      fromBytes: req.file.size,
      toBytes: result.buffer.byteLength,
      width: result.width,
      height: result.height,
    };

    // Namespacing by tenant keeps one workspace's assets out of another's path.
    const stored = await storage.save({
      buffer: result.buffer,
      originalName,
      mimeType: result.mimeType,
      folder: `tenants/${ctx.tenantId}/${folder}`,
    });

    // Record ownership so later cleanup can prove that this workspace owns the
    // file before deleting it. If the registry write fails, remove the orphan.
    try {
      await StorageObjectModel.create({
        tenantId: ctx.tenantId,
        storeId: ctx.storeId,
        key: stored.key,
        url: stored.url,
        bytes: stored.size,
        mimeType: stored.mimeType,
        folder,
        uploadedBy: ctx.userId,
      });
    } catch (error) {
      await storage.delete(stored.key).catch(() => undefined);
      throw error;
    }

    created(res, { ...stored, optimisation });
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
