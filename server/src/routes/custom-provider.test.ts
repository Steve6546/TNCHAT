import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

/**
 * The custom provider, and the 404 that motivated it.
 *
 * Two failures with the same symptom, `404 {"detail":"Not Found"}`:
 *
 *   1. The base URL was missing its version segment. The adaptor appended its
 *      endpoint path to a bare host and the provider had no such route. The
 *      probe now resolves this itself and remembers what answered.
 *   2. The provider is not one of the built-ins at all, and no amount of
 *      guessing its path is legitimate. `custom` stops guessing and hands the
 *      operator the endpoint, the auth style and the headers.
 *
 * Everything is exercised through the real HTTP surface — `app.inject()` for
 * the dashboard routes, a stubbed `fetch` standing in for the provider — so
 * what is asserted here is what a user pressing "Test" actually triggers.
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'acc-custom-provider-'));
process.env.ACC_DATA_DIR = dataDir;
process.env.MASTER_KEY = 'simulation-master-key-0123456789abcdef';
process.env.SESSION_SECRET = 'simulation-session-secret-0123456789abcdef';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../app.js');
const { migrate } = await import('../db/migrate.js');
const { db } = await import('../db/index.js');
const { apiKeys, channels } = await import('../db/schema.js');
const { rebuildRoutingIndex } = await import('../gateway/ability-index.js');
const { candidateBaseUrls } = await import('../adapters/index.js');
const { hashApiKey, normalizeApiKey } = await import('../lib/crypto.js');
const { eq } = await import('drizzle-orm');

const ADMIN_PASSWORD = 'simulation-password-123';
const CLIENT_KEY = 'sk-simulation-client-key-000000000000';
const UPSTREAM_KEY = 'sk-upstream-key-simulation';

interface UpstreamReply {
  status: number;
  body: string;
}

/**
 * Stands in for the provider. The test decides, per URL, whether it exists —
 * which is exactly the difference between a right and a wrong endpoint.
 */
let route: (url: string) => UpstreamReply = () => ({ status: 404, body: '{"detail":"Not Found"}' });
let calls: string[] = [];
let lastHeaders: Record<string, string> = {};
let lastBody: Record<string, unknown> = {};

const realFetch = globalThis.fetch;

function json(status: number, payload: unknown): UpstreamReply {
  return { status, body: JSON.stringify(payload) };
}

function installFetchStub(): void {
  globalThis.fetch = (async (
    input: unknown,
    init?: { headers?: Record<string, string>; body?: unknown },
  ) => {
    const url = String(input);
    calls.push(url);
    lastHeaders = { ...(init?.headers ?? {}) };
    lastBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    const reply = route(url);
    return new Response(reply.body, {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

/** OpenAI-shaped 200, so the relay treats the round trip as a success. */
function openaiOk(model: string): UpstreamReply {
  return json(200, {
    id: 'chatcmpl-simulation',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

let app: Awaited<ReturnType<typeof buildApp>>;
let authHeaders: Record<string, string>;

async function createChannel(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/channels',
    headers: authHeaders,
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data as Record<string, unknown>;
}

/** The stored row, bypassing the API's serialisation. */
function storedColumn(id: number, column: 'baseUrl' | 'authStyle' | 'extraHeaders'): unknown {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  assert.ok(row, `channel ${id} should exist`);
  return row[column];
}

/** A client key, so the relay route accepts a request. Idempotent. */
function seedClientKey(): void {
  const existing = db.select().from(apiKeys).all();
  if (existing.length > 0) return;

  db.insert(apiKeys)
    .values({
      name: 'simulation-client',
      keyHash: hashApiKey(normalizeApiKey(CLIENT_KEY)),
      keyPreview: 'sk-sim…0000',
      group: 'default',
      modelLimit: '[]',
      status: 'active',
      expiresAt: null,
      createdAt: Date.now(),
    })
    .run();
  rebuildRoutingIndex();
}

before(async () => {
  migrate();
  installFetchStub();
  app = await buildApp();
  await app.ready();

  const setup = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: ADMIN_PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  authHeaders = { authorization: `Bearer ${setup.json().data.token as string}` };
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close().catch(() => undefined);
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // A locked file on Windows is not worth failing the suite over.
  }
});

describe('endpoint candidates', () => {
  test('a bare host is offered the version prefixes', () => {
    assert.deepEqual(candidateBaseUrls('generic', 'https://api.example.com'), [
      'https://api.example.com/v1',
      'https://api.example.com/api/v1',
    ]);
  });

  test('a base that already carries /v1 gets no candidates', () => {
    assert.deepEqual(candidateBaseUrls('generic', 'https://api.example.com/v1'), []);
    assert.deepEqual(candidateBaseUrls('anthropic', 'https://api.example.com/api/v1'), []);
  });

  test('candidates are built on the cleaned root, not the pasted endpoint', () => {
    // The pasted endpoint is peeled first, then a version prefix is offered —
    // so the candidate is `/v1/chat/completions`, not
    // `/chat/completions/v1/chat/completions`.
    assert.deepEqual(candidateBaseUrls('generic', 'https://api.example.com/chat/completions'), [
      'https://api.example.com/v1',
      'https://api.example.com/api/v1',
    ]);
  });

  test('an endpoint whose root is already versioned needs no candidates', () => {
    assert.deepEqual(candidateBaseUrls('generic', 'https://api.example.com/v1/chat/completions'), []);
  });

  test('custom gets none — the operator dictates the endpoint', () => {
    assert.deepEqual(candidateBaseUrls('custom', 'https://api.example.com'), []);
  });
});

describe('the probe resolves a missing version segment', () => {
  test('a 404 on the bare host is retried under /v1 and the winner is kept', async () => {
    calls = [];
    route = (url) =>
      url === 'https://api.example.com/v1/chat/completions'
        ? openaiOk('gpt-4o-mini')
        : json(404, { detail: 'Not Found' });

    const created = await createChannel({
      name: 'Bare host',
      type: 'generic',
      baseUrl: 'https://api.example.com',
      keys: [UPSTREAM_KEY],
      models: ['gpt-4o-mini'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${String(created['id'])}/test`,
      headers: authHeaders,
    });

    assert.equal(response.statusCode, 200);
    const result = response.json() as Record<string, unknown>;
    assert.equal(result['ok'], true, `expected success, got ${JSON.stringify(result)}`);
    assert.equal(result['baseUrl'], 'https://api.example.com/v1');

    // The wrong path was tried first and the right one found after it.
    assert.deepEqual(calls, [
      'https://api.example.com/chat/completions',
      'https://api.example.com/v1/chat/completions',
    ]);

    // Persisted, so the next probe — and every relay call — goes straight there.
    assert.equal(storedColumn(created['id'] as number, 'baseUrl'), 'https://api.example.com/v1');
  });

  test('a 401 is not retried against a different path', async () => {
    calls = [];
    route = () => json(401, { detail: 'Invalid API key' });

    const created = await createChannel({
      name: 'Wrong key',
      type: 'generic',
      baseUrl: 'https://auth-required.example.com',
      keys: [UPSTREAM_KEY],
      models: ['gpt-4o-mini'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${String(created['id'])}/test`,
      headers: authHeaders,
    });

    const result = response.json() as Record<string, unknown>;
    assert.equal(result['ok'], false);
    assert.equal(result['statusCode'], 401);

    // One attempt only: the path was right, the credential was not, and
    // guessing further would hide that behind a confusing series of 404s.
    assert.equal(calls.length, 1);
    assert.equal(result['hint'], undefined);
  });

  test('an unresolvable 404 reports the upstream error plus a hint', async () => {
    route = () => json(404, { detail: 'Not Found' });

    const created = await createChannel({
      name: 'Wrong host',
      type: 'generic',
      baseUrl: 'https://nope.example.com/v1',
      keys: [UPSTREAM_KEY],
      models: ['gpt-4o-mini'],
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/channels/${String(created['id'])}/test`,
      headers: authHeaders,
    });

    const result = response.json() as Record<string, unknown>;
    assert.equal(result['ok'], false);
    assert.equal(result['statusCode'], 404);
    assert.equal(result['message'], 'Not Found');
    assert.equal(typeof result['hint'], 'string');
  });
});

describe('custom channels talk to any API', () => {
  test('the endpoint is called verbatim, with the chosen auth and headers', async () => {
    calls = [];
    lastHeaders = {};
    route = () => openaiOk('vendor/model-x');

    const created = await createChannel({
      name: 'Any provider',
      type: 'custom',
      baseUrl: 'https://api.example.com/v1/chat/completions',
      keys: [UPSTREAM_KEY],
      models: ['vendor/model-x'],
      authStyle: 'x-api-key',
      extraHeaders: { 'X-Title': 'TNCHAT', authorization: 'Bearer operator-wins' },
    });

    // Round-trips through the API, so the stored config is what was sent.
    assert.equal(created['authStyle'], 'x-api-key');
    assert.deepEqual(created['extraHeaders'], {
      'X-Title': 'TNCHAT',
      authorization: 'Bearer operator-wins',
    });
    // Not rewritten on the way in: no path appended, none peeled.
    assert.equal(created['baseUrl'], 'https://api.example.com/v1/chat/completions');

    seedClientKey();

    const relay = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
      payload: { model: 'vendor/model-x', messages: [{ role: 'user', content: 'ping' }] },
    });

    assert.equal(relay.statusCode, 200, relay.body);

    // Exactly the URL the operator typed — the endpoint is not doubled.
    assert.deepEqual(calls, ['https://api.example.com/v1/chat/completions']);
    assert.equal(lastBody['model'], 'vendor/model-x');
    assert.equal(lastHeaders['x-api-key'], UPSTREAM_KEY);
    assert.equal(lastHeaders['x-title'], 'TNCHAT');
    // An operator header wins over the adaptor's default.
    assert.equal(lastHeaders['authorization'], 'Bearer operator-wins');
  });

  test('no-auth providers send the key nowhere', async () => {
    calls = [];
    lastHeaders = {};
    route = () => openaiOk('local-model');

    const created = await createChannel({
      name: 'Free local API',
      type: 'custom',
      baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
      keys: ['unused'],
      models: ['local-model'],
      authStyle: 'none',
      extraHeaders: {},
    });

    seedClientKey();
    // The channel must be routable before the relay will pick it.
    await app.inject({
      method: 'POST',
      url: `/api/channels/${String(created['id'])}/test`,
      headers: authHeaders,
    });

    const relay = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
      payload: { model: 'local-model', messages: [{ role: 'user', content: 'ping' }] },
    });

    assert.equal(relay.statusCode, 200, relay.body);
    assert.equal(lastHeaders['authorization'], undefined);
    assert.equal(lastHeaders['x-api-key'], undefined);
  });

  test('a trailing slash or query string on the endpoint is harmless', async () => {
    calls = [];
    route = () => openaiOk('vendor/model-y');

    const created = await createChannel({
      name: 'Messy endpoint',
      type: 'custom',
      baseUrl: 'https://api.example.com/v1/chat/completions/?key=1',
      keys: [UPSTREAM_KEY],
      models: ['vendor/model-y'],
      authStyle: 'bearer',
    });

    seedClientKey();

    const relay = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CLIENT_KEY}` },
      payload: { model: 'vendor/model-y', messages: [{ role: 'user', content: 'ping' }] },
    });

    assert.equal(relay.statusCode, 200, relay.body);
    assert.deepEqual(calls, ['https://api.example.com/v1/chat/completions']);
    assert.equal(lastHeaders['authorization'], `Bearer ${UPSTREAM_KEY}`);
  });

  test('the type is accepted by the API and listed for the dashboard', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/channel-types',
      headers: authHeaders,
    });
    const kinds = (response.json().data as { kind: string }[]).map((entry) => entry.kind);
    assert.ok(kinds.includes('custom'), `expected custom among ${kinds.join(', ')}`);
  });
});
