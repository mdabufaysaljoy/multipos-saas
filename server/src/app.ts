import path from 'path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { createRateLimiter } from './middleware/rateLimit';
import { env, isProd } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import routes from './routes';

export function createApp(): Express {
  const app = express();

  // Behind a proxy in production, so `req.ip` reflects the real client rather
  // than the proxy. The hop count is configuration (`TRUST_PROXY_HOPS`) because
  // it must match the deployment exactly: it decides the identity every rate
  // limiter counts against, and both guessing too high and too low are
  // exploitable. See the note on the variable in `config/env.ts`.
  app.set('trust proxy', isProd ? env.TRUST_PROXY_HOPS : false);

  app.use(
    helmet({
      // Uploaded images are served from this origin and embedded by the SPA.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()),
      credentials: true,
      exposedHeaders: ['x-store-id'],
    }),
  );

  app.use(compression());
  app.use(cookieParser());

  app.use(
    express.json({
      limit: '1mb',
      // Keep the raw bytes so webhook signatures can be verified over the exact
      // payload the provider signed.
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  if (!isProd) app.use(morgan('dev'));

  app.use(
    '/api',
    createRateLimiter({
      name: 'api',
      windowMs: 60_000,
      limit: 600,
      // Relaxed in development so the end-to-end suite - which makes several
      // thousand calls per run - is not throttled. Production stays strict.
      devLimit: 20_000,
      // The whole API: a Redis outage must not stop the tills trading, and a
      // per-process 600/minute is still a ceiling.
      fallback: 'memory',
      message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Slow down a moment and try again.' } },
    }),
  );

  // Locally stored uploads.
  app.use(
    `/${env.STORAGE_LOCAL_DIR}`,
    express.static(path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR), { maxAge: '7d', fallthrough: true }),
  );

  app.use('/api', routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
