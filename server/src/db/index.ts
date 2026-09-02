import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

/**
 * Supabase Postgres — the only data store.
 *
 * The connection is the standard `postgres` client wrapped in Drizzle. Two
 * settings matter on Supabase specifically:
 *
 *   - `prepare: false` — Supabase sits behind PgBouncer in transaction mode on
 *     the pooler port, and prepared statements are bound to a session there.
 *     Disabling them keeps the same URL working over every pool mode.
 *   - a bounded pool — the gateway is a single process; ten connections are
 *     ample for relay traffic plus the dashboard, and staying small avoids
 *     exhausting the project's connection pool.
 */
export const pg = postgres(config.databaseUrl, {
  prepare: false,
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
});

export const db = drizzle(pg, { schema });
export { schema };
