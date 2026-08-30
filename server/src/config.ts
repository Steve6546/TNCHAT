import { hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Paths and runtime configuration.
 *
 * The repository root is discovered by walking up until `pnpm-workspace.yaml`
 * is found, rather than by counting `..` segments. A compiled build runs from
 * `server/dist/`, one level deeper than `server/src/`, so any fixed number of
 * `..` segments puts the database and the `.env` file in a different place in
 * development than in production. Discovery makes both agree.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function findRepoRoot(startDir: string): string {
  let current = startDir;
  for (;;) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

export const REPO_ROOT = findRepoRoot(here);
export const SERVER_DIR = path.join(REPO_ROOT, 'server');
export const WEB_DIST_DIR = path.join(REPO_ROOT, 'web', 'dist');
export const DATA_DIR = process.env.ACC_DATA_DIR
  ? path.resolve(process.env.ACC_DATA_DIR)
  : path.join(SERVER_DIR, 'data');

/**
 * Loaded once, from the repository root — the only place `.env` is read from.
 *
 * A single location means one file to document, one file to back up, and no
 * argument about which value won.
 */
function loadEnvFile(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

loadEnvFile();

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

/**
 * MASTER_KEY encrypts upstream provider keys at rest.
 *
 * If absent we generate one and persist it next to the database, because a
 * rotated master key would make every stored provider key undecryptable.
 * Production deployments must set it explicitly and back it up.
 */
function resolveMasterKey(): string {
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  ensureDir(DATA_DIR);
  const keyPath = path.join(DATA_DIR, '.master-key');
  if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8').trim();

  const generated = randomBytes(32).toString('hex');
  writeFileSync(keyPath, generated, { mode: 0o600 });
  console.warn(
    `[config] No MASTER_KEY set. Generated a persistent one at ${keyPath}.\n` +
      '[config] Back it up: losing it makes every stored provider key undecryptable.',
  );
  return generated;
}

/**
 * Session signing key, deliberately separate from MASTER_KEY.
 *
 * Both are long-lived secrets, but they protect different things: MASTER_KEY
 * protects provider credentials at rest; this one only signs dashboard session
 * tokens. Deriving one from the other keeps a fresh install zero-config while
 * ensuring a leaked session token can never be turned into the ability to
 * decrypt stored provider keys.
 */
function resolveSessionSecret(masterKey: string): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const derived = hkdfSync(
    'sha256',
    Buffer.from(masterKey, 'utf8'),
    Buffer.from(''),
    Buffer.from('acc-dashboard-session'),
    32,
  );
  return Buffer.from(derived).toString('hex');
}

/**
 * CORS policy.
 *
 * Reflecting any origin is convenient for local development and wrong for a
 * deployment. In production an explicit allow-list is required, and `*` is
 * never used: the dashboard authenticates with a bearer token, so a wildcard
 * would let any page that can reach the server read everything behind it.
 */
function resolveCorsOrigin(isProduction: boolean): string[] | boolean {
  const raw = (process.env.CORS_ORIGIN ?? '').trim();

  if (raw === '' || raw === 'true') {
    if (isProduction) {
      console.warn(
        '[config] CORS_ORIGIN is unset in production; only same-origin requests are allowed.',
      );
      return false;
    }
    return true;
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

ensureDir(DATA_DIR);

const masterKey = resolveMasterKey();
const isProduction = process.env.NODE_ENV === 'production';

export const config = {
  isProduction,

  host: process.env.HOST ?? '127.0.0.1',
  port: int(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'app.db'),
  dataDir: DATA_DIR,
  webDistDir: WEB_DIST_DIR,

  masterKey,
  sessionSecret: resolveSessionSecret(masterKey),

  /** Dashboard password from the environment, used only until one is stored. */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',

  /** Relay behaviour. */
  retryTimes: int(process.env.RETRY_TIMES, 3),
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 120_000),
  streamingTimeoutMs: int(process.env.STREAMING_TIMEOUT_MS, 300_000),
  maxRequestBodyMb: int(process.env.MAX_REQUEST_BODY_MB, 32),

  /** Max per-line buffer while scanning SSE. Large image payloads need headroom. */
  streamScannerMaxBufferMb: int(process.env.STREAM_SCANNER_MAX_BUFFER_MB, 64),

  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigin: resolveCorsOrigin(isProduction),

  /** Only enable behind a reverse proxy that overwrites X-Forwarded-For. */
  trustProxy: bool(process.env.TRUST_PROXY, false),

  /** Failed dashboard login attempts allowed per IP within the window below. */
  authMaxAttempts: int(process.env.AUTH_MAX_ATTEMPTS, 8),
  authWindowMs: int(process.env.AUTH_WINDOW_MS, 10 * 60 * 1000),
} as const;

if (isProduction) {
  if (!process.env.MASTER_KEY) {
    console.warn('[config] Running in production without an explicit MASTER_KEY.');
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('[config] Running in production without an explicit SESSION_SECRET.');
  }
}

/** Exposed by the health endpoint so a deployment can assert its own config. */
export function configSummary(): Record<string, unknown> {
  return {
    environment: isProduction ? 'production' : 'development',
    host: config.host,
    port: config.port,
    retryTimes: config.retryTimes,
    requestTimeoutMs: config.requestTimeoutMs,
    streamingTimeoutMs: config.streamingTimeoutMs,
    masterKeySource: process.env.MASTER_KEY ? 'environment' : 'generated-file',
    sessionSecretSource: process.env.SESSION_SECRET ? 'environment' : 'derived',
    cors:
      config.corsOrigin === true
        ? 'any (development)'
        : Array.isArray(config.corsOrigin)
          ? config.corsOrigin
          : 'same-origin',
    trustProxy: config.trustProxy,
    servingDashboard: existsSync(path.join(WEB_DIST_DIR, 'index.html')),
  };
}
