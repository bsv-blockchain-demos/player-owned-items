import 'express-async-errors';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { mountRoutes } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { config } from './config';
import { rateLimiters } from './middleware/rateLimit';

/**
 * Build the Express app: JSON + cookies, health, feature routers, and a
 * terminal error handler. API-only — the SPA is deployed separately.
 * `express-async-errors` (imported for its side effect above) forwards
 * async-handler rejections to it.
 */
export function buildApp(): Express {
  const app = express();

  // Request logger: method + path on arrival, then status + duration on finish.
  app.use((req, res, next) => {
    const start = Date.now();
    console.log(`[server] --> ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      console.log(`[server] <-- ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  });

  // Credentialed CORS: echo the request Origin only if it's in the allowlist.
  if (config.allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && config.allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        res.header('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });
  }

  // After CORS so a 429 still carries CORS headers; before the body parser so a limited
  // request's body is never parsed.
  const limiters = rateLimiters();
  app.use('/api', limiters.api);
  app.use('/api/login', limiters.login);

  app.use(express.json());
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  mountRoutes(app);

  app.use(errorHandler);

  return app;
}
