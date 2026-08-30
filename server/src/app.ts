import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { config } from './config.js';
import { GatewayError, toGatewayError } from './core/errors.js';
import { extractDashboardToken, verifyToken } from './gateway/dashboard-auth.js';
import { registerAuthRoutes } from './routes/admin-auth.js';
import { registerChannelRoutes } from './routes/admin-channels.js';
import { registerKeyRoutes } from './routes/admin-keys.js';
import { registerStatsRoutes } from './routes/admin-stats.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerRelayRoutes } from './routes/relay.js';
import { registerSpaRoutes } from './routes/spa.js';

/** Management endpoints that must stay reachable without a dashboard session. */
const PUBLIC_API_PATHS = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup']);

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.isProduction
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
    },
    // Upstream prompts with large images can exceed Fastify's 1 MB default.
    bodyLimit: config.maxRequestBodyMb * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  /**
   * Clients reasonably send `content-type: application/json` with an empty body
   * (a DELETE, or a POST that takes no parameters). Fastify rejects that with a
   * framework-level 400 before the route runs, so treat an empty body as `{}`
   * and let the route produce a meaningful validation error instead.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    if (raw === undefined || raw === null || raw.trim() === '') {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  await app.register(cors, {
    origin: config.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version'],
  });

  /**
   * Baseline response headers.
   *
   * These are the ones that carry real weight for this app rather than a
   * generic checklist: the dashboard is a single-page app that should never be
   * framed, never be sniffed into a different content type, and should not leak
   * a cross-origin referrer.
   */
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('x-acc-gateway', 'ai-command-center');
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const gateway = toGatewayError(error);
    const statusCode = gateway.statusCode ?? 500;

    // 5xx means a bug or an upstream failure worth a stack trace; 4xx is the
    // caller's problem and does not need one.
    if (statusCode >= 500) {
      app.log.error({ err: error }, 'Unhandled error');
    }

    return reply.code(statusCode).send({
      error: {
        message: gateway.message,
        type: gateway.type,
        code: gateway.code,
      },
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    // Relay endpoints authenticate with their own API keys, not the dashboard.
    if (!path.startsWith('/api/')) return;
    if (PUBLIC_API_PATHS.has(path)) return;

    if (!verifyToken(extractDashboardToken(request.headers.authorization))) {
      return reply.code(401).send({
        error: {
          message: 'Dashboard session missing or expired',
          type: 'authentication_error',
          code: 'invalid_api_key',
        },
      });
    }
  });

  // Relay and management first: they own concrete paths, so registering them
  // before the SPA keeps a wildcard from ever shadowing an endpoint.
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerChannelRoutes(app);
  await registerKeyRoutes(app);
  await registerStatsRoutes(app);
  await registerRelayRoutes(app);
  await registerSpaRoutes(app);

  return app;
}

export { GatewayError };
