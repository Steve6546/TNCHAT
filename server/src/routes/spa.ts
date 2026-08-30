import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';

/**
 * Serves the built dashboard from the gateway process.
 *
 * This is what makes `node scripts/acc.mjs start` a single command on a single
 * port: there is no second server to run and no dev proxy to configure. When
 * `web/dist` is absent (a fresh clone before the first build) the API still
 * works and this module simply does nothing.
 *
 * Two details that matter:
 *   - Hashed build assets under `/assets/` are immutable and cached hard.
 *   - `index.html` is never cached, so a redeploy is picked up on reload.
 */

const IMMUTABLE_MAX_AGE = 31_536_000; // one year, in seconds

export async function registerSpaRoutes(app: FastifyInstance): Promise<void> {
  const indexFile = path.join(config.webDistDir, 'index.html');

  if (!existsSync(indexFile)) {
    app.log.warn(
      'web/dist/index.html not found — run `node scripts/acc.mjs build` to serve the dashboard.',
    );
    registerApiNotFoundHandler(app);
    return;
  }

  await app.register(fastifyStatic, {
    root: config.webDistDir,
    prefix: '/',
    wildcard: true,
    maxAge: IMMUTABLE_MAX_AGE,
    immutable: true,
    setHeaders(response, filePath) {
      // A new build produces new hashed filenames, so everything except the
      // entry document can be cached forever.
      if (filePath.endsWith('index.html')) {
        response.setHeader('cache-control', 'no-cache, must-revalidate');
      }
    },
  });

  /**
   * Single-page application fallback: any GET that is not an API call and not
   * a real file is answered with the app shell, so deep links and browser
   * refreshes work. API 404s stay JSON — a client parsing an error response
   * must never receive HTML.
   */
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !isApi(request.url)) {
      return reply.sendFile('index.html');
    }
    return notFound(reply, `${request.method} ${request.url}`);
  });
}

function isApi(url: string): boolean {
  return url.startsWith('/api/') || url.startsWith('/v1/') || url === '/health';
}

function notFound(reply: { code(status: number): { send(body: unknown): unknown } }, what: string) {
  return reply.code(404).send({
    error: {
      message: `Route ${what} not found`,
      type: 'invalid_request_error',
      code: 'not_found_error',
    },
  });
}

/** Used when the dashboard has not been built: API-only 404s, still JSON. */
function registerApiNotFoundHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => notFound(reply, `${request.method} ${request.url}`));
}
