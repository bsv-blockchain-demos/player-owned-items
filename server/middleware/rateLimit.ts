import { isIP } from 'node:net';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { config } from '../config';

/** Requests per client per minute. In-memory counters: correct because the API runs as one instance. */
export const LIMITS = { api: 120, login: 10 };

// No tighter tier for the wallet routes: each one receives a payment the client has already
// broadcast, so a 429 there would strand it. They only get the general limit.

// Behind a proxy (the Cloudflare tunnel) every request comes from the proxy, so the client IP is
// read from the header it sets. Opt-in: where clients can reach the app directly, they could set
// the header themselves. Anything but a single IP (e.g. an X-Forwarded-For chain) is ignored.
function clientKey(req: Request): string {
  const header = config.clientIpHeader;
  const forwarded = header ? req.get(header)?.trim() : undefined;
  return ipKeyGenerator(forwarded && isIP(forwarded) ? forwarded : req.ip || '');
}

function limiter(limit: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: clientKey,
    message: { error: 'Too many requests, try again shortly' },
  });
}

/** Fresh limiters (and counters) per app instance. */
export function rateLimiters() {
  return { api: limiter(LIMITS.api), login: limiter(LIMITS.login) };
}
