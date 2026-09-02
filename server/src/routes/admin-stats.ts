import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { GatewayError } from '../core/errors.js';
import { db, pg } from '../db/index.js';
import { requestLogs } from '../db/schema.js';
import * as v from '../lib/validate.js';

/**
 * Dashboard statistics.
 *
 * Every number is aggregated from `request_logs` at query time. There is no
 * counter table to drift, and there is no fallback value: when nothing has
 * happened yet, the API reports zeros and the UI renders an honest empty state.
 */

interface TotalsRow {
  requests: number;
  tokens: number;
  avg_latency: number;
  successes: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
}

interface SeriesRow {
  day: string;
  requests: number;
  tokens: number;
  successes: number;
}

interface BreakdownRow {
  name: string;
  requests: number;
  tokens: number;
  avg_latency: number;
  errors: number;
}

interface RecentRow {
  id: number;
  model: string;
  upstream_model: string;
  channel_name: string;
  client_format: string;
  upstream_format: string;
  total_tokens: number;
  status_code: number;
  ok: boolean;
  latency_ms: number;
  is_stream: boolean;
  error_message: string | null;
  created_at: number;
}

export const LOG_SCOPES = ['errors', 'all'] as const;

/** `?ok=1` keeps successful rows only, `?ok=0` keeps failures. Absent = both. */
export function parseOkFilter(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw GatewayError.badRequest('Query "ok" must be 1 or 0', 'ok');
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function round(value: number): number {
  return Math.round(value);
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    const okFilter = parseOkFilter((request.query as Record<string, unknown> | null)?.['ok']);
    const today = startOfToday();
    const since = today - 13 * 24 * 60 * 60 * 1000;

    // Raw queries go through the postgres client directly: these are
    // aggregations, not table-mapped operations, and Postgres answers them
    // with bigint SUM/AVG columns that map cleanly onto the row types below.
    const totalsRows = (await pg`
      SELECT
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency,
        COALESCE(SUM(CASE WHEN ok THEN 1 ELSE 0 END), 0)::int AS successes,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens
      FROM request_logs
      WHERE created_at >= ${today}
    `) as unknown as TotalsRow[];
    const totals = totalsRows[0];

    const lifetimeRows = (await pg`
      SELECT
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency,
        COALESCE(SUM(CASE WHEN ok THEN 1 ELSE 0 END), 0)::int AS successes,
        COALESCE(SUM(prompt_tokens), 0)::bigint AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0)::bigint AS completion_tokens,
        COALESCE(SUM(cached_tokens), 0)::bigint AS cached_tokens
      FROM request_logs
    `) as unknown as TotalsRow[];
    const lifetime = lifetimeRows[0];

    const seriesRows = (await pg`
      SELECT
        to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COALESCE(SUM(CASE WHEN ok THEN 1 ELSE 0 END), 0)::int AS successes
      FROM request_logs
      WHERE created_at >= ${since}
      GROUP BY day
      ORDER BY day
    `) as unknown as SeriesRow[];

    const byModelRows = (await pg`
      SELECT
        model AS name,
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency,
        COALESCE(SUM(CASE WHEN ok = false THEN 1 ELSE 0 END), 0)::int AS errors
      FROM request_logs
      GROUP BY model
      ORDER BY requests DESC
      LIMIT 20
    `) as unknown as BreakdownRow[];

    const byChannelRows = (await pg`
      SELECT
        COALESCE(NULLIF(channel_name, ''), 'unknown') AS name,
        COUNT(*)::int AS requests,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COALESCE(AVG(latency_ms), 0)::float8 AS avg_latency,
        COALESCE(SUM(CASE WHEN ok = false THEN 1 ELSE 0 END), 0)::int AS errors
      FROM request_logs
      GROUP BY name
      ORDER BY requests DESC
      LIMIT 20
    `) as unknown as BreakdownRow[];

    // Only the recent-requests table is filtered. The headline metrics stay
    // unfiltered so "requests today" never changes when someone toggles a view.
    const recentRows =
      okFilter === undefined
        ? ((await pg`
            SELECT id, model, upstream_model, channel_name, client_format, upstream_format,
                   total_tokens, status_code, ok, latency_ms, is_stream, error_message, created_at
            FROM request_logs
            ORDER BY id DESC LIMIT 25
          `) as unknown as RecentRow[])
        : ((await pg`
            SELECT id, model, upstream_model, channel_name, client_format, upstream_format,
                   total_tokens, status_code, ok, latency_ms, is_stream, error_message, created_at
            FROM request_logs
            WHERE ok = ${okFilter}
            ORDER BY id DESC LIMIT 25
          `) as unknown as RecentRow[]);

    const todayRequests = totals?.requests ?? 0;
    const todaySuccesses = totals?.successes ?? 0;

    return reply.send({
      data: {
        today: {
          requests: todayRequests,
          tokens: round(totals?.tokens ?? 0),
          promptTokens: round(totals?.prompt_tokens ?? 0),
          completionTokens: round(totals?.completion_tokens ?? 0),
          cachedTokens: round(totals?.cached_tokens ?? 0),
          avgLatencyMs: round(totals?.avg_latency ?? 0),
          successRate: todayRequests === 0 ? null : todaySuccesses / todayRequests,
        },
        lifetime: {
          requests: lifetime?.requests ?? 0,
          tokens: round(lifetime?.tokens ?? 0),
          avgLatencyMs: round(lifetime?.avg_latency ?? 0),
          successRate:
            (lifetime?.requests ?? 0) === 0
              ? null
              : (lifetime?.successes ?? 0) / (lifetime?.requests ?? 1),
        },
        series: seriesRows.map((row) => ({
          day: row.day,
          requests: row.requests,
          tokens: round(row.tokens),
          successes: row.successes,
        })),
        byModel: byModelRows.map((row) => ({
          name: row.name,
          requests: row.requests,
          tokens: round(row.tokens),
          avgLatencyMs: round(row.avg_latency),
          errors: row.errors,
        })),
        byChannel: byChannelRows.map((row) => ({
          name: row.name,
          requests: row.requests,
          tokens: round(row.tokens),
          avgLatencyMs: round(row.avg_latency),
          errors: row.errors,
        })),
        recent: recentRows.map((row) => ({
          id: row.id,
          model: row.model,
          upstreamModel: row.upstream_model,
          channelName: row.channel_name,
          clientFormat: row.client_format,
          upstreamFormat: row.upstream_format,
          totalTokens: row.total_tokens,
          statusCode: row.status_code,
          ok: row.ok === true,
          latencyMs: row.latency_ms,
          isStream: row.is_stream === true,
          errorMessage: row.error_message,
          createdAt: Number(row.created_at),
        })),
      },
    });
  });

  /**
   * Log housekeeping.
   *
   * `scope=errors` is the default because that is the only case anyone asks
   * for: a run of 502/503 from one bad channel buries the useful rows, and the
   * successes are what you actually want to keep reading. `scope=all` resets
   * the dashboard's history entirely.
   *
   * Deleting rows does not affect routing — abilities are built from channels,
   * not from logs.
   */
  app.delete('/api/stats/logs', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const scope = query['scope'] === undefined ? 'errors' : v.oneOf(query['scope'], 'scope', LOG_SCOPES);

    const deletedRows =
      scope === 'all'
        ? await db.delete(requestLogs).returning({ id: requestLogs.id })
        : await db.delete(requestLogs).where(eq(requestLogs.ok, false)).returning({ id: requestLogs.id });

    return reply.send({ ok: true, deleted: deletedRows.length });
  });
}
