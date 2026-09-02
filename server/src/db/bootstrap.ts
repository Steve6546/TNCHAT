import { config } from '../config.js';
import { rebuildRoutingIndex } from '../gateway/ability-index.js';
import { migrate } from './migrate.js';
import { pg } from './index.js';

/**
 * First-run bootstrap.
 *
 *   tsx src/db/bootstrap.ts
 *
 * Does two things, in order:
 *   1. applies the schema to the Supabase Postgres database;
 *   2. builds the routing index so the first request is already warm.
 *
 * Dashboard accounts live in Supabase Auth — there is no local admin password
 * to promote, and no seed data of any kind.
 */

async function main(): Promise<void> {
  await migrate();
  console.log('[bootstrap] schema up to date on the Supabase database');

  await rebuildRoutingIndex();

  let latencyMs: number | null = null;
  const startedAt = Date.now();
  try {
    await pg`SELECT 1`;
    latencyMs = Date.now() - startedAt;
  } catch {
    latencyMs = null;
  }
  console.log(
    latencyMs === null
      ? '[bootstrap] WARNING: database did not answer a probe query'
      : `[bootstrap] database reachable (${latencyMs} ms)`,
  );

  await pg.end();
}

main().catch((error) => {
  console.error('[bootstrap] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
