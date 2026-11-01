import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/apiResponse';
import { siteService } from '../../services/site/site.service';
import { hardwareService } from '../../services/hardware/hardware.service';

/**
 * The public website's own settings.
 *
 * Deliberately unauthenticated and deliberately thin: it is read by anonymous
 * visitors on every page, and by the build step that pre-renders them. The
 * service assembles the payload field by field, so nothing secret on the
 * settings document can arrive here by accident.
 */
const router = Router();

router.get(
  '/site',
  asyncHandler(async (_req: Request, res: Response) => {
    const site = await siteService.publicSite();
    // A minute at the edge matches the service's own cache. Public, because
    // there is nothing here that differs between visitors.
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, site);
  }),
);

/**
 * The hardware the platform sells: active packages and active devices.
 *
 * Unauthenticated like the rest of the public surface, and deliberately a
 * whole-catalogue read: the page shows every package and every device at once,
 * and the catalogue is a few dozen rows that change a handful of times a year.
 * Only active rows leave the service, so a withdrawn device cannot reach a
 * visitor through a package that still lists it.
 */
router.get(
  '/hardware',
  asyncHandler(async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=60');
    ok(res, await hardwareService.publicCatalogue());
  }),
);

/**
 * `robots.txt`, served from the same settings.
 *
 * It is generated rather than shipped as a file because the one thing it must
 * get right - whether this deployment may be indexed at all - is a setting. A
 * staging site that out-ranks production is a real failure, and one an
 * operator has to be able to prevent without a deploy.
 */
router.get(
  '/robots.txt',
  asyncHandler(async (_req: Request, res: Response) => {
    const site = await siteService.publicSite();
    const base = site.seo.canonicalBaseUrl;
    const body = site.seo.indexable
      ? ['User-agent: *', 'Allow: /', '', '# The signed-in app is not content.', 'Disallow: /pos', 'Disallow: /platform', 'Disallow: /onboarding', '', base ? `Sitemap: ${base}/sitemap.xml` : '']
      : ['User-agent: *', 'Disallow: /'];
    res.type('text/plain').set('Cache-Control', 'public, max-age=300').send(body.filter((line) => line !== undefined).join('\n').trim() + '\n');
  }),
);

export default router;
