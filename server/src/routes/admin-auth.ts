import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { GatewayError } from '../core/errors.js';
import {
  extractDashboardToken,
  isPasswordConfigured,
  login,
  setAdminPassword,
  verifyPassword,
  verifyToken,
  getStoredPasswordHash,
} from '../gateway/dashboard-auth.js';
import { RateLimiter } from '../lib/rate-limit.js';
import * as v from '../lib/validate.js';

/**
 * Dashboard authentication.
 *
 * `/api/auth/status` is public on purpose: the UI needs to know whether to
 * show first-run setup or a login form before it has a token.
 *
 * Login and setup are rate limited per IP. They are the only endpoints an
 * attacker can use to guess the dashboard password, and the password protects
 * every provider credential in the system.
 */

const authLimiter = new RateLimiter(config.authMaxAttempts, config.authWindowMs);

/** The client IP, honouring X-Forwarded-For only when the proxy is trusted. */
function clientKey(request: FastifyRequest): string {
  if (config.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded !== '') {
      return forwarded.split(',')[0]!.trim();
    }
  }
  return request.ip;
}

function assertAllowed(request: FastifyRequest): void {
  if (authLimiter.allow(clientKey(request))) return;

  const retryAfter = authLimiter.retryAfterSeconds(clientKey(request));
  throw new GatewayError(
    `Too many attempts. Try again in ${Math.max(retryAfter, 1)} seconds.`,
    { statusCode: 429, code: 'rate_limit_error', skipRetry: true },
  );
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/status', async (_request, reply: FastifyReply) => {
    return reply.send({ data: { configured: isPasswordConfigured() } });
  });

  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    assertAllowed(request);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const password = v.str(body['password'], 'password', { min: 1, max: 500 });

    const token = login(password);
    authLimiter.reset(clientKey(request));
    return reply.send({ data: { token, expiresInHours: 12 } });
  });

  app.post('/api/auth/setup', async (request: FastifyRequest, reply: FastifyReply) => {
    assertAllowed(request);

    // Gate on the same predicate /api/auth/status reports, so the UI can never
    // be told "already configured" while setup is still open — that mismatch
    // let a deployment keep a password nobody knowingly chose.
    if (isPasswordConfigured()) {
      throw GatewayError.forbidden('An admin password is already configured');
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const password = v.str(body['password'], 'password', { min: 8, max: 500 });

    setAdminPassword(password);
    authLimiter.reset(clientKey(request));

    const token = login(password);
    return reply.code(201).send({ data: { token, expiresInHours: 12 } });
  });

  app.post('/api/auth/password', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!verifyToken(extractDashboardToken(request.headers.authorization))) {
      throw GatewayError.unauthorized('Dashboard session expired');
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const current = v.str(body['currentPassword'], 'currentPassword', { min: 1, max: 500 });
    const next = v.str(body['newPassword'], 'newPassword', { min: 8, max: 500 });

    const stored = getStoredPasswordHash();
    if (stored !== null && !verifyPassword(current, stored)) {
      throw GatewayError.forbidden('Current password is incorrect');
    }

    setAdminPassword(next);
    return reply.send({ ok: true });
  });
}
