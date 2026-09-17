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
import { entitlementService } from '../../services/subscription/entitlement.service';
import { inspectImage, optimizeToWebp } from '../../services/storage/imageOptimizer';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

/**
 * Hard ceiling on what the server will even read into memory.
 *
 * Brand plans are optimised down to WebP before anything is stored, so they can
 * send a full-resolution camera image; the cap still exists because an
 * unbounded upload is a denial-of-service regardless of plan. Plans without
 * optimisation keep the smaller limit, since whatever they send is what gets
 * stored against their quota.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UNOPTIMISED_BYTES = 4 * 1024 * 1024;

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

    const entitlement = await entitlementService.forTenant(ctx.tenantId);
    const optimises = entitlement.features.imageOptimization === true;

    // The declared content type comes from the client and can say anything, so
    // the bytes are inspected before we agree this is an image at all.
    const inspected = await inspectImage(req.file.buffer);
    if (!inspected.ok) throw ApiError.badRequest(inspected.reason ?? 'That file is not a valid image');

    if (!optimises && req.file.size > MAX_UNOPTIMISED_BYTES) {
      throw ApiError.badRequest(
        `Images must be ${Math.round(MAX_UNOPTIMISED_BYTES / 1024 / 1024)} MB or smaller on your plan. ` +
          'Enterprise optimises large images automatically.',
        { maxBytes: MAX_UNOPTIMISED_BYTES, uploadedBytes: req.file.size },
      );
    }

    // Optimise BEFORE the quota check, so Brand is charged for what is actually
    // stored rather than what was sent.
    let bytes = req.file.buffer;
    let mimeType = req.file.mimetype;
    let originalName = req.file.originalname;
    let optimisation: { fromBytes: number; toBytes: number; width: number; height: number } | null = null;

    if (optimises) {
      const result = await optimizeToWebp(req.file.buffer, req.file.size);
      bytes = result.buffer;
      mimeType = result.mimeType;
      originalName = `${originalName.replace(/\.[^.]+$/, '')}${result.extension}`;
      optimisation = {
        fromBytes: req.file.size,
        toBytes: result.buffer.byteLength,
        width: result.width,
        height: result.height,
      };
    }

    // Quota against the FINAL size, before writing, so a rejected upload leaves
    // nothing on disk to clean up.
    await entitlementService.assertCanStore(ctx.tenantId, entitlement, bytes.byteLength);

    // Namespacing by tenant keeps one workspace's assets out of another's path.
    const stored = await storage.save({
      buffer: bytes,
      originalName,
      mimeType,
      folder: `tenants/${ctx.tenantId}/${folder}`,
    });

    // Record the bytes against the workspace. If this fails the file is
    // orphaned on disk rather than counted, so we remove it instead of letting
    // storage grow untracked.
    let ledgerRow;
    try {
      ledgerRow = await StorageObjectModel.create({
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

    // Same non-atomic gap as the count-based limits: two uploads can pass the
    // quota check at once. Re-check now the row exists and undo this one if the
    // workspace ended up over. Cheap, because the file is already ours to
    // delete.
    const max = entitlement.limits?.maxStorageBytes ?? -1;
    if (max !== -1) {
      // Only this file and the ones before it. Summing everything would make
      // every concurrent upload see the same over-quota total and roll back,
      // rejecting files that actually fitted.
      const used = await entitlementService.storageBytesUpTo(ctx.tenantId, ledgerRow._id);
      if (used > max) {
        await StorageObjectModel.deleteOne({ tenantId: ctx.tenantId, key: stored.key });
        await storage.delete(stored.key).catch(() => undefined);
        throw ApiError.limitExceeded(
          'This file would take your workspace over its storage limit. Upgrade or remove some files.',
          { limit: 'maxStorageBytes', max, current: used - req.file.size },
        );
      }
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
