#!/usr/bin/env node
/**
 * AI Command Center — single entry point.
 *
 * Everything the project can do goes through this file, so there is exactly
 * one command to remember and exactly one place where platform differences
 * are handled.
 *
 *   node scripts/acc.mjs start    install → env → migrate → build → serve (one port)
 *   node scripts/acc.mjs dev      install → env → migrate → server + UI with hot reload
 *   node scripts/acc.mjs setup    install → env → migrate   (no build, no serve)
 *   node scripts/acc.mjs build    typecheck + build server + build UI
 *   node scripts/acc.mjs test     run the test suite
 *   node scripts/acc.mjs check    typecheck + test  (what CI runs)
 *   node scripts/acc.mjs db       migrate the database
 *   node scripts/acc.mjs reset    delete the local database (asks first)
 *
 * Why this exists instead of npm scripts chaining other npm scripts:
 *
 *   - No shell. Every child process is spawned with an explicit executable and
 *     an explicit argument array, so nothing depends on cmd.exe vs bash, on
 *     glob expansion, or on how a path containing spaces and `&` is quoted.
 *     (This workspace path contains both, which is exactly the case that
 *     breaks naive `pnpm -F ... && pnpm -F ...` chains on Windows.)
 *   - Node scripts are launched through `process.execPath` and a resolved
 *     module entry point, never through a `.cmd` shim.
 *   - `install` is the only step that needs a package manager, and it is the
 *     only step that goes through a shell — with a command string that
 *     contains no filesystem path at all.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const WEB_DIR = path.join(REPO_ROOT, 'web');

const MIN_NODE = [22, 5, 0];

const CYAN = '\u001b[36m';
const MAGENTA = '\u001b[35m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RESET = '\u001b[0m';

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (color, text) => (useColor ? `${color}${text}${RESET}` : text);

const isWindows = process.platform === 'win32';

/* ────────────────────────────────────────────────────────────
 * Small utilities
 * ──────────────────────────────────────────────────────────── */

function step(title) {
  console.log(`\n${paint(CYAN, '▸')} ${title}`);
}

function ok(message) {
  console.log(`  ${paint(GREEN, '✓')} ${message}`);
}

function warn(message) {
  console.log(`  ${paint(YELLOW, '!')} ${message}`);
}

function fail(message) {
  console.error(`\n${paint(RED, '✗')} ${message}\n`);
  process.exit(1);
}

/** Run a child process. Resolves on exit code 0, rejects otherwise. */
function run(file, args, { cwd = REPO_ROOT, env, stdio = 'inherit', prefix } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: prefix ? 'pipe' : stdio,
      windowsHide: true,
    });

    if (prefix) {
      const tag = paint(prefix.color, prefix.label);
      const forward = (stream, out) => {
        let buffered = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          buffered += chunk;
          const lines = buffered.split(/\r?\n/);
          buffered = lines.pop() ?? '';
          for (const line of lines) out.write(`${tag} ${line}\n`);
        });
        stream.on('end', () => {
          if (buffered !== '') out.write(`${tag} ${buffered}\n`);
        });
      };
      forward(child.stdout, process.stdout);
      forward(child.stderr, process.stderr);
    }

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} exited with ${signal ?? code}`));
    });
  });
}

/**
 * Resolve a package's JS entry point so we never spawn a `.cmd` shim.
 * Node is invoked with this file as its main module, which is the only form
 * that behaves identically on every platform.
 */
function bin(dir, ...segments) {
  const candidate = path.join(dir, 'node_modules', ...segments);
  if (!existsSync(candidate)) {
    fail(
      `Missing dependency: ${path.relative(REPO_ROOT, candidate)}\n` +
        `  Run \`node scripts/acc.mjs setup\` to install dependencies.`,
    );
  }
  return candidate;
}

const node = process.execPath;

/** `node <tsx> …` — runs TypeScript directly, in watch mode when asked. */
function tsx(args) {
  return [bin(SERVER_DIR, 'tsx', 'dist', 'cli.mjs'), ...args];
}

/* ────────────────────────────────────────────────────────────
 * Preflight
 * ──────────────────────────────────────────────────────────── */

function checkNodeVersion() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const [minMajor, minMinor, minPatch] = MIN_NODE;
  const tooOld =
    major < minMajor ||
    (major === minMajor && (minor < minMinor || (minor === minMinor && patch < minPatch)));

  if (tooOld) {
    fail(
      `Node ${process.versions.node} is too old. AI Command Center needs >= ${MIN_NODE.join('.')}.\n` +
        `  Download the LTS build from https://nodejs.org`,
    );
  }
}

/**
 * The package-manager command used only for `install`.
 * Runs through a shell on Windows because pnpm/npm ship as `.cmd` shims there.
 * The command string deliberately contains no filesystem path: this workspace
 * directory name contains `&`, which cmd.exe would otherwise parse as a
 * command separator.
 */
function packageManager() {
  const candidates = ['pnpm', 'npm'];
  for (const name of candidates) {
    const probe = isWindows
      ? spawnSync('cmd.exe', ['/d', '/c', `${name} --version`], { windowsHide: true })
      : spawnSync(name, ['--version'], { windowsHide: true });
    if (probe.status === 0) return name;
  }
  return null;
}

function install() {
  const pm = packageManager();
  if (pm === null) {
    fail(
      'No package manager found. Install pnpm (`npm i -g pnpm`) or use a Node\n' +
        '  distribution that bundles npm, then run this command again.',
    );
  }
  return isWindows
    ? run('cmd.exe', ['/d', '/c', `${pm} install`])
    : run(pm, ['install']);
}

function dependenciesPresent() {
  return (
    existsSync(path.join(REPO_ROOT, 'node_modules')) &&
    existsSync(path.join(SERVER_DIR, 'node_modules')) &&
    existsSync(path.join(WEB_DIR, 'node_modules'))
  );
}

async function ensureInstalled({ force = false } = {}) {
  if (force || !dependenciesPresent()) {
    step(force ? 'Reinstalling dependencies' : 'Installing dependencies');
    await install();
    ok('dependencies ready');
  } else {
    ok('dependencies already installed');
  }
}

function ensureEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  const examplePath = path.join(REPO_ROOT, '.env.example');

  if (existsSync(envPath)) return;

  if (!existsSync(examplePath)) {
    fail('Neither .env nor .env.example exists. Restore .env.example from the repository.');
  }

  copyFileSync(examplePath, envPath);
  ok('created .env from .env.example');
  warn('ADMIN_PASSWORD is empty by design — the dashboard will ask you to create one.');
}

/**
 * Full database preparation: schema, routing index, and the one-time promotion
 * of ADMIN_PASSWORD into the database when an operator has set one.
 *
 * `src/db/migrate.ts` remains the schema-only primitive (that is what
 * `acc.mjs db` runs); this is the entry point for everything that boots.
 */
async function migrate() {
  step('Preparing the database');
  await run(node, tsx(['src/db/bootstrap.ts']), { cwd: SERVER_DIR });
  ok('database ready');
}

/* ────────────────────────────────────────────────────────────
 * Build
 * ──────────────────────────────────────────────────────────── */

async function typecheck() {
  step('Type checking');
  await run(node, [bin(SERVER_DIR, 'typescript', 'bin', 'tsc'), '--noEmit'], { cwd: SERVER_DIR });
  await run(node, [bin(WEB_DIR, 'typescript', 'bin', 'tsc'), '-b', '--pretty', 'false'], { cwd: WEB_DIR });
  ok('no type errors');
}

async function buildServer() {
  step('Building the gateway server');
  await run(node, [bin(SERVER_DIR, 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
    cwd: SERVER_DIR,
  });
  ok('server built → server/dist');
}

async function buildWeb() {
  step('Building the dashboard');
  await run(node, [bin(WEB_DIR, 'vite', 'bin', 'vite.js'), 'build'], { cwd: WEB_DIR });
  ok('dashboard built → web/dist');
}

/* ────────────────────────────────────────────────────────────
 * Process supervision
 * ──────────────────────────────────────────────────────────── */

/**
 * Run several long-lived processes and keep them together.
 * When one exits, the others are stopped — a half-dead dev environment is
 * more confusing than a dead one.
 */
function runTogether(children) {
  const running = [];
  let stopping = false;

  const stopAll = (reason) => {
    if (stopping) return;
    stopping = true;

    for (const child of running) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      // On Windows `kill()` only reaches the direct child. The grandchild that
      // actually holds the port lives in the same process tree, so prune it too.
      if (isWindows && child.pid !== undefined) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      } else {
        try {
          child.kill('SIGTERM');
        } catch {
          // Already gone.
        }
      }
    }

    if (reason) console.log(`\n${paint(DIM, reason)}`);
    process.exit(0);
  };

  /** Prefix every output line so interleaved logs stay readable. */
  const pipe = (child, prefix) => {
    const tag = paint(prefix.color, prefix.label);
    const forward = (stream, out) => {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) out.write(`${tag} ${line}\n`);
      });
      stream.on('end', () => {
        if (buffered !== '') out.write(`${tag} ${buffered}\n`);
      });
    };
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
  };

  for (const config of children) {
    const child = spawn(node, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: 'pipe',
      windowsHide: true,
    });

    pipe(child, config.prefix);

    child.on('error', (error) => {
      if (!stopping) fail(`${config.prefix.label} failed to start: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      if (stopping) return;
      stopAll(`${config.prefix.label} stopped (${signal ?? code})`);
    });

    running.push(child);
  }

  process.on('SIGINT', () => stopAll('Interrupted — stopping all processes'));
  process.on('SIGTERM', () => stopAll('Terminated — stopping all processes'));
}

/* ────────────────────────────────────────────────────────────
 * Commands
 * ──────────────────────────────────────────────────────────── */

async function commandSetup({ force = false } = {}) {
  checkNodeVersion();
  await ensureInstalled({ force });
  ensureEnv();
  await migrate();
  console.log(`\n${paint(GREEN, '✔ Setup complete.')} Run \`${paint(CYAN, 'node scripts/acc.mjs start')}\` to launch.\n`);
}

async function commandBuild() {
  checkNodeVersion();
  await ensureInstalled();
  await typecheck();
  await buildServer();
  await buildWeb();
  console.log(`\n${paint(GREEN, '✔ Build complete.')}\n`);
}

async function commandDev() {
  checkNodeVersion();
  await ensureInstalled();
  ensureEnv();
  await migrate();

  console.log(`\n${paint(GREEN, 'Starting in development mode…')}`);
  console.log(`${paint(DIM, '  gateway   http://127.0.0.1:8787')}`);
  console.log(`${paint(DIM, '  dashboard http://127.0.0.1:5173')}\n`);

  runTogether([
    {
      cwd: SERVER_DIR,
      args: tsx(['watch', '--clear-screen=false', 'src/index.ts']),
      env: { NODE_ENV: 'development' },
      prefix: { label: 'server │', color: CYAN },
    },
    {
      cwd: WEB_DIR,
      args: [bin(WEB_DIR, 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1'],
      prefix: { label: 'web    │', color: MAGENTA },
    },
  ]);
}

async function commandStart() {
  checkNodeVersion();
  await ensureInstalled();
  ensureEnv();

  const serverEntry = path.join(SERVER_DIR, 'dist', 'index.js');

  if (!existsSync(serverEntry) || !existsSync(path.join(WEB_DIR, 'dist', 'index.html'))) {
    step('First run — building once');
    await migrate();
    await buildServer();
    await buildWeb();
  } else {
    await migrate();
  }

  const port = readEnvNumber('PORT') ?? 8787;
  const host = readEnvString('HOST') ?? '127.0.0.1';

  console.log(`\n${paint(GREEN, '✔ AI Command Center is running')}`);
  console.log(`${paint(DIM, '  dashboard + gateway  ')}${paint(CYAN, `http://${host}:${port}`)}`);
  console.log(`${paint(DIM, '  press CTRL+C to stop')}\n`);

  await run(node, [serverEntry], {
    cwd: REPO_ROOT,
    env: { NODE_ENV: 'production' },
  });
}

async function commandTest() {
  checkNodeVersion();
  await ensureInstalled();
  step('Running tests');
  await run(node, tsx(['--test', '--test-reporter=spec', 'src/**/*.test.ts']), { cwd: SERVER_DIR });
  ok('all tests passed');
}

async function commandCheck() {
  checkNodeVersion();
  await ensureInstalled();
  ensureEnv();
  await typecheck();
  await commandTest();
  console.log(`\n${paint(GREEN, '✔ All checks passed.')}\n`);
}

async function commandDb() {
  checkNodeVersion();
  await ensureInstalled();
  ensureEnv();
  // Schema only — no routing index, no password promotion.
  step('Applying the database schema');
  await run(node, tsx(['src/db/migrate.ts']), { cwd: SERVER_DIR });
  ok('schema up to date');
}

async function commandReset() {
  const dataDir = process.env.ACC_DATA_DIR ?? path.join(SERVER_DIR, 'data');
  if (!existsSync(dataDir)) {
    ok('nothing to reset');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Delete ${dataDir}? This erases all channels, keys and logs. [y/N] `))
    .trim()
    .toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    warn('cancelled — nothing was deleted');
    return;
  }

  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  ok('local database deleted');
}

/* ────────────────────────────────────────────────────────────
 * Tiny .env reader — enough to print the real URL before boot
 * ──────────────────────────────────────────────────────────── */

let envCache = null;

function readEnvFile() {
  if (envCache) return envCache;
  envCache = {};
  const envPath = path.join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return envCache;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    envCache[key] = rawValue.replace(/^["']|["']$/g, '');
  }
  return envCache;
}

function readEnvString(key) {
  return process.env[key] ?? readEnvFile()[key] ?? undefined;
}

function readEnvNumber(key) {
  const raw = readEnvString(key);
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ────────────────────────────────────────────────────────────
 * CLI
 * ──────────────────────────────────────────────────────────── */

const COMMANDS = {
  setup: { run: commandSetup, description: 'install dependencies, create .env, prepare the database' },
  dev: { run: commandDev, description: 'run gateway + dashboard with hot reload' },
  start: { run: commandStart, description: 'ONE command: install, build and serve everything on one port' },
  build: { run: commandBuild, description: 'typecheck and build both workspaces' },
  test: { run: commandTest, description: 'run the test suite' },
  check: { run: commandCheck, description: 'typecheck + tests (what CI runs)' },
  db: { run: commandDb, description: 'apply database migrations' },
  reset: { run: commandReset, description: 'delete the local database (asks first)' },
};

function usage() {
  console.log(`\n${paint(CYAN, 'AI Command Center')} — project runner\n`);
  console.log('  node scripts/acc.mjs <command>\n');
  for (const [name, command] of Object.entries(COMMANDS)) {
    console.log(`  ${paint(CYAN, name.padEnd(7))} ${command.description}`);
  }
  console.log(`\n  ${paint(DIM, 'Tip: with a package manager installed you can also run:')}`);
  console.log(`  ${paint(DIM, '  pnpm start   ·   pnpm dev   ·   pnpm check')}\n`);
}

async function main() {
  const [commandName, ...rest] = process.argv.slice(2);

  if (commandName === undefined || commandName === '--help' || commandName === '-h') {
    usage();
    return;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    usage();
    fail(`Unknown command "${commandName}"`);
  }

  await command.run({ force: rest.includes('--force') || rest.includes('-f') });
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
