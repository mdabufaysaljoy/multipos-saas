import type { Request, Response } from 'express';
import multer from 'multer';
import { PlatformSettingsModel, getPlatformSettings } from '../../models/PlatformSettings';
import { ApiError } from '../../utils/ApiError';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/apiResponse';
import { body } from '../../middleware/validate';
import { storage } from '../../services/storage';
import { inspectImage, optimizeToWebp } from '../../services/storage/imageOptimizer';
import { siteService } from '../../services/site/site.service';
import { recordAudit } from '../../services/audit/audit.service';
import type { UpdateSiteInput } from './site.validators';

/**
 * The platform admin's view of the public website, and the writes that change
 * it. The read here is the ADMIN read: it returns the stored values, blanks
 * and all, because an admin editing the site needs to see which fields are
 * actually set and which are falling back to the deployment's configuration.
 * `GET /public/site` returns the resolved version visitors see.
 */

export const getSite = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettings();
  ok(res, {
    stored: settings.site ?? {},
    // So the screen can show "falling back to X" beside an empty field rather
    // than leaving the admin to guess what a blank will produce.
    effective: await siteService.publicSite(),
  });
});

/**
 * Saves one or more sections.
 *
 * `$set` with dotted paths, so sending only `contact` leaves the SEO block and
 * the policy text exactly as they were - the screen saves a section at a time
 * and must never blank the others.
 */
export const updateSite = asyncHandler(async (req: Request, res: Response) => {
  const input = body<UpdateSiteInput>(req);

  const $set: Record<string, unknown> = {};
  const walk = (value: unknown, path: string) => {
    if (value === undefined) return;
    // Arrays and scalars are replaced wholesale; only plain objects recurse,
    // so `seo.pages` is set as a list rather than merged element by element.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`);
      return;
    }
    $set[path] = value;
  };
  walk(input, 'site');

  if (Object.keys($set).length === 0) throw ApiError.badRequest('Nothing to save');

  const before = await getPlatformSettings();
  await PlatformSettingsModel.updateOne({ key: 'platform' }, { $set }, { upsert: true });
  siteService.invalidate();

  await recordAudit(req, {
    action: 'platform.site_settings_updated',
    targetLabel: 'Public website',
    oldValue: { fields: Object.keys($set) },
    newValue: { fields: Object.keys($set) },
  });

  const settings = await getPlatformSettings();
  ok(res, { stored: settings.site ?? {}, effective: await siteService.publicSite(), changed: Object.keys($set).length, previouslySet: Boolean(before.site) });
});

// ----------------------------------------------------------------- uploads

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/svg+xml'];
/** Branding art is small. A 5 MB ceiling is generous for a logo and a favicon. */
const MAX_BYTES = 5 * 1024 * 1024;

export const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      cb(ApiError.badRequest('Only JPEG, PNG, WebP, AVIF or SVG images are allowed'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Stores a logo, favicon or social image.
 *
 * Separate from the tenant upload route, which is mounted behind
 * `resolveTenant` and so refuses a platform admin outright. Raster art is
 * optimised to WebP exactly as product imagery is; SVG is stored as-is because
 * converting a vector logo to a bitmap would be the wrong thing to do to it.
 */
export const uploadBrandingImage = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw ApiError.badRequest('Choose an image to upload');

  const isVector = req.file.mimetype === 'image/svg+xml';

  // A vector logo is stored as it was drawn - rasterising it to WebP would be
  // the wrong thing to do to the one asset that should stay sharp at any size.
  if (isVector) {
    const stored = await storage.save({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: 'image/svg+xml',
      folder: 'platform/branding',
    });
    created(res, { ...stored, optimisation: null });
    return;
  }

  // The declared content type comes from the client and can say anything, so
  // the bytes are inspected before we agree this is an image at all.
  const inspected = await inspectImage(req.file.buffer);
  if (!inspected.ok) throw ApiError.badRequest(inspected.reason ?? 'That file is not a valid image');

  const result = await optimizeToWebp(req.file.buffer, req.file.size);
  const stored = await storage.save({
    buffer: result.buffer,
    originalName: `${req.file.originalname.replace(/\.[^.]+$/, '')}${result.extension}`,
    mimeType: result.mimeType,
    folder: 'platform/branding',
  });

  // No `StorageObject` row: that registry is tenant-scoped (its `tenantId` is
  // required) and exists so a workspace's storage can be metered and cleaned
  // up against its plan. Platform branding belongs to the deployment, not to
  // any workspace, and must not be counted against one.
  created(res, { ...stored, optimisation: { fromBytes: req.file.size, toBytes: result.buffer.byteLength, width: result.width, height: result.height } });
});
