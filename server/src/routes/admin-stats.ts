import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { db } from '../db/index.js';

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

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function round(value: number): number {
  return Math.round(value);
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/overview', async (_request, reply: FastifyReply) => {
    const today = startOfToday();
    const since = today - 13 * 24 * 60 * 60 * 1000;

    const totals = db
      .all<TotalsRow>(sql`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(AVG(latency_ms), 0) AS avg_latency,
          COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS successes,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens
        FROM request_logs
        WHERE created_at >= ${today}
      `)
      .at(0);

    const lifetime = db
      .all<TotalsRow>(sql`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(total_tokens), 0) AS tokens,
          COALESCE(AVG(latency_ms), 0) AS avg_latency,
          COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS successes,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens
        FROM request_logs
      `)
      .at(0);

    const series = db.all<SeriesRow>(sql`
      SELECT
        date(created_at / 1000, 'unixepoch', 'localtime') AS day,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END), 0) AS successes
      FROM request_logs
      WHERE created_at >= ${since}
      GROUP BY day
      ORDER BY day
    `);

    const byModel = db.all<BreakdownRow>(sql`
      SELECT
        model AS name,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
      FROM request_logs
      GROUP BY model
      ORDER BY requests DESC
      LIMIT 20
    `);

    const byChannel = db.all<BreakdownRow>(sql`
      SELECT
        COALESCE(NULLIF(channel_name, ''), 'unknown') AS name,
        COUNT(*) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
      FROM request_logs
      GROUP BY name
      ORDER BY requests DESC
      LIMIT 20
    `);

    const recent = db.all<{
      id: number;
      model: string;
      upstream_model: string;
      channel_name: string;
      client_format: string;
      upstream_format: string;
      total_tokens: number;
      status_code: number;
      ok: number;
      latency_ms: number;
      is_stream: number;
      error_message: string | null;
      created_at: number;
    }>(sql`
      SELECT id, model, upstream_model, channel_name, client_format, upstream_format,
             total_tokens, status_code, ok, latency_ms, is_stream, error_message, created_at
      FROM request_logs
      ORDER BY id DESC
      LIMIT 25
    `);

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
        series: series.map((row) => ({
          day: row.day,
          requests: row.requests,
          tokens: round(row.tokens),
          successes: row.successes,
        })),
        byModel: byModel.map((row) => ({
          name: row.name,
          requests: row.requests,
          tokens: round(row.tokens),
          avgLatencyMs: round(row.avg_latency),
          errors: row.errors,
        })),
        byChannel: byChannel.map((row) => ({
          name: row.name,
          requests: row.requests,
          tokens: round(row.tokens),
          avgLatencyMs: round(row.avg_latency),
          errors: row.errors,
        })),
        recent: recent.map((row) => ({
          id: row.id,
          model: row.model,
          upstreamModel: row.upstream_model,
          channelName: row.channel_name,
          clientFormat: row.client_format,
          upstreamFormat: row.upstream_format,
          totalTokens: row.total_tokens,
          statusCode: row.status_code,
          ok: row.ok === 1,
          latencyMs: row.latency_ms,
          isStream: row.is_stream === 1,
          errorMessage: row.error_message,
          createdAt: row.created_at,
        })),
      },
    });
  });
}
