import sharp from 'sharp';
import { logger } from '../../utils/logger';

/**
 * Automatic Image Optimization & WebP Conversion — a Brand-plan feature.
 *
 * Large photographs are resized and re-encoded as WebP before anything is
 * stored, so a 9 MB camera image becomes a few hundred kilobytes and the
 * workspace's quota goes much further.
 *
 * Everything here runs on the SERVER. The browser is never asked what the final
 * size is, because a client can claim anything.
 */

/** Long edge, in pixels. Beyond this adds bytes without adding useful detail. */
const MAX_EDGE = 2000;

/** Refuse absurd dimensions before decoding: a small file can decompress into gigabytes. */
const MAX_INPUT_PIXELS = 50_000_000;

export interface OptimizedImage {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  /** Bytes saved against the original upload. */
  savedBytes: number;
}

/**
 * Validates that a buffer really is a decodable image of a supported type.
 *
 * The MIME type on a multipart upload is supplied by the client and can say
 * anything; this reads the actual bytes.
 */
export async function inspectImage(buffer: Buffer): Promise<{
  ok: boolean;
  format?: string;
  width?: number;
  height?: number;
  reason?: string;
}> {
  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    if (!meta.format) return { ok: false, reason: 'The file is not a readable image' };
    if (!['jpeg', 'png', 'webp', 'avif'].includes(meta.format)) {
      return { ok: false, reason: `${meta.format.toUpperCase()} images are not supported` };
    }
    if (!meta.width || !meta.height) return { ok: false, reason: 'The image has no readable dimensions' };
    return { ok: true, format: meta.format, width: meta.width, height: meta.height };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error && /pixel/i.test(error.message)
        ? 'The image dimensions are too large to process'
        : 'The file is corrupt or not a valid image',
    };
  }
}

/**
 * Resizes and converts to WebP.
 *
 * `withoutEnlargement` means a small image is never upscaled - that would add
 * bytes for no benefit. The original buffer is discarded by the caller once
 * this returns, so only the optimised bytes are ever written to storage.
 */
export async function optimizeToWebp(buffer: Buffer, originalSize: number): Promise<OptimizedImage> {
  const pipeline = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    // Honours EXIF orientation, then drops the metadata with it.
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  logger.info('Image optimised', {
    fromBytes: originalSize,
    toBytes: data.byteLength,
    dimensions: `${info.width}x${info.height}`,
  });

  return {
    buffer: data,
    mimeType: 'image/webp',
    extension: '.webp',
    width: info.width,
    height: info.height,
    savedBytes: Math.max(0, originalSize - data.byteLength),
  };
}
