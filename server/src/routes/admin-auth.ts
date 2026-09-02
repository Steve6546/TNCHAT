import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import {
  extractDashboardToken,
  issueDashboardToken,
  verifyToken,
} from '../gateway/dashboard-auth.js';
import { GatewayError } from '../core/errors.js';
import {
  sendPasswordReset,
  signInWithPassword,
  signOut,
  signUp,
} from '../auth/supabase.js';
import { RateLimiter } from '../lib/rate-limit.js';
import * as v from '../lib/validate.js';

/**
 * Dashboard authentication, backed by Supabase Auth.
 *
 * Accounts live in Supabase (email + password). After a successful Supabase
 * sign-in the server issues its own short HMAC token — signature only, no
 * expiry — so every `/api/*` request is authorised locally without a network
 * round-trip to Supabase. Signing out invalidates the Supabase session and
 * the browser drops our token with the tab.
 *
 * Signup, login and password recovery are rate limited per IP: they are the
 * only endpoints an attacker can use against Supabase through this server.
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
    `محاولات كثيرة جداً — حاول مجدداً بعد ${Math.max(retryAfter, 1)} ثانية.`,
    { statusCode: 429, code: 'rate_limit_error', skipRetry: true },
  );
}

function dashboardSession(userId: string, email: string, supabase: { accessToken: string; refreshToken: string }) {
  return {
    token: issueDashboardToken({ sub: userId, email }),
    email,
    supabaseAccessToken: supabase.accessToken,
    supabaseRefreshToken: supabase.refreshToken,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public status endpoint: the dashboard pings it to tell "server reachable"
   * apart from "server down" before rendering the auth form.
   */
  app.get('/api/auth/status', async (_request, reply: FastifyReply) => {
    return reply.send({ data: { provider: 'supabase' } });
  });

  /**
   * Public project coordinates for direct Supabase Auth calls from the
   * browser (password change). The anon key is public by design — it can
   * never read data on its own.
   */
  app.get('/api/auth/config', async (_request, reply: FastifyReply) => {
    return reply.send({
      data: { supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey },
    });
  });

  app.post('/api/auth/signup', async (request: FastifyRequest, reply: FastifyReply) => {
    assertAllowed(request);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = v.email(body['email'], 'email');
    const password = v.password(body['password'], 'password');

    const session = await signUp(email, password);

    if (session === null) {
      // The Supabase project sends a confirmation email first.
      return reply.code(202).send({
        data: {
          needsConfirmation: true,
          email,
          message:
            'تم إنشاء الحساب. أُرسلت رسالة تأكيد إلى بريدك — افتحها ثم سجّل الدخول.',
        },
      });
    }

    authLimiter.reset(clientKey(request));
    return reply.code(201).send({
      data: { needsConfirmation: false, ...dashboardSession(session.userId, session.email, session) },
    });
  });

  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    assertAllowed(request);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = v.email(body['email'], 'email');
    const password = v.str(body['password'], 'password', { min: 1, max: 200 });

    const session = await signInWithPassword(email, password);
    authLimiter.reset(clientKey(request));

    return reply.send({
      data: dashboardSession(session.userId, session.email, session),
    });
  });

  /**
   * Password recovery. Always answers ok: revealing whether the address is
   * registered would turn this endpoint into an account enumerator.
   */
  app.post('/api/auth/recover', async (request: FastifyRequest, reply: FastifyReply) => {
    assertAllowed(request);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = v.email(body['email'], 'email');

    await sendPasswordReset(email);
    return reply.send({
      data: {
        message: 'إذا كان هذا البريد مسجَّلاً لدينا فستصل رسالة إعادة تعيين كلمة المرور خلال دقائق.',
      },
    });
  });

  /** Invalidate the Supabase session. Best-effort; always answers ok. */
  app.post('/api/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const accessToken = typeof body['supabaseAccessToken'] === 'string' ? body['supabaseAccessToken'] : undefined;

    // Authorization carries our dashboard token; the Supabase access token
    // arrives in the body and is what Supabase needs to revoke its session.
    if (!verifyToken(extractDashboardToken(request.headers.authorization))) {
      // Already signed out (or never signed in): treat as idempotent success.
      return reply.send({ ok: true });
    }

    await signOut(accessToken);
    return reply.send({ ok: true });
  });
}
