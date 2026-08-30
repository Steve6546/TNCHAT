import { config } from '../config.js';
import { rebuildRoutingIndex } from '../gateway/ability-index.js';
import {
  getStoredPasswordHash,
  isPasswordConfigured,
  setAdminPassword,
} from '../gateway/dashboard-auth.js';
import { migrate } from './migrate.js';

/**
 * First-run bootstrap.
 *
 *   tsx src/db/bootstrap.ts
 *
 * Does three things, in order:
 *   1. applies the schema;
 *   2. builds the routing index so the first request is already warm;
 *   3. promotes ADMIN_PASSWORD from the environment into the database, once.
 *
 * Step 3 is what lets you delete the plaintext password from `.env` afterwards:
 * `login()` prefers the stored hash and ignores the environment value as soon
 * as one exists. This is not a seed of demo data — if no password is configured
 * the dashboard simply asks you to choose one on first visit.
 */

function main(): void {
  migrate();
  console.log(`[bootstrap] schema up to date at ${config.dbPath}`);

  rebuildRoutingIndex();

  if (getStoredPasswordHash() === null && config.adminPassword !== '') {
    setAdminPassword(config.adminPassword);
    console.log(
      '[bootstrap] Stored a hash of ADMIN_PASSWORD in the database.\n' +
        '[bootstrap] You can now remove ADMIN_PASSWORD from .env — it is ignored from here on.',
    );
  } else if (isPasswordConfigured()) {
    console.log('[bootstrap] A dashboard password is already configured.');
  } else {
    console.log(
      '[bootstrap] No dashboard password yet — the dashboard will ask you to create one.',
    );
  }
}

main();
