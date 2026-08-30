import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { configSummary } from '../config.js';
import { db } from '../db/index.js';
import { abilityIndex } from '../gateway/ability-index.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply: FastifyReply) => {
    let database: 'ok' | 'error' = 'ok';
    try {
      db.all(sql`SELECT 1 AS ok`);
    } catch {
      database = 'error';
    }

    const stats = abilityIndex.stats();

    return reply.send({
      ok: database === 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      database,
      routingPairs: stats.pairs,
      abilityRows: stats.rows,
      config: configSummary(),
    });
  });
}
