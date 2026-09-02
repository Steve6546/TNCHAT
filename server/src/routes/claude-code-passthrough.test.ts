import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { after, before, describe, test } from 'node:test';

/**
 * Claude Code compatibility, exercised end to end.
 *
 * The database is Supabase Postgres, so these tests run against the configured
 * `DATABASE_URL`. They only ever touch rows they seeded themselves — the
 * channel named "Simulation Anthropic" and the API key named "simulation" —
 * so a database holding real channels is never disturbed.
 */

process.env.MASTER_KEY = process.env.MASTER_KEY ?? 'simulation-master-key-0123456789abcdef';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'simulation-session-secret-0123456789abcdef';
process.env.LOG_LEVEL = 'silent';

const { buildApp } = await import('../app.js');
const { migrate } = await import('../db/migrate.js');
const { db, pg } = await import('../db/index.js');
const { apiKeys, channels } = await import('../db/schema.js');
const { rebuildRoutingIndex } = await import('../gateway/ability-index.js');
const { normalizeBaseUrl } = await import('../adapters/index.js');
const { clientPassthroughHeaders } = await import('../gateway/upstream.js');
const { convertClaudeRequestToOpenAI } = await import('../convert/claude-to-openai.js');
const { hashApiKey, normalizeApiKey } = await import('../lib/crypto.js');
const { encryptKeyList } = await import('../lib/secrets.js');
const { RelayFormat } = await import('../core/formats.js');

// Distinct from every other suite's client key: suites run in parallel
// against the same database, and api_keys.key_hash is unique.
const CLIENT_KEY = 'sk-sim-cc-client-key-00000000000001';
const UPSTREAM_KEY = 'sk-ant-upstream-key-simulation';

/**
 * What Claude Code actually puts on the wire: gated beta flags, interleaved
 * thinking, an effort level, and a mix of a provider built-in tool
 * (computer use) with an ordinary function tool.
 */
const CLAUDE_CODE_HEADERS = {
  'content-type': 'application/json',
  'x-api-key': CLIENT_KEY,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20',
};

function claudeCodeBody(): Record<string, unknown> {
  return {
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    thinking: { type: 'enabled', budget_tokens: 10000 },
    output_config: { effort: 'high' },
    system: [
      {
        type: 'text',
        text: 'You are Claude Code.',
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      { role: 'user', content: 'افتح الملف واقرأه' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'سأستخدم الأداة', signature: 'ZhA=' },
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'computer',
            input: { action: 'screenshot' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: 'done',
          },
        ],
      },
    ],
    tools: [
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: 1024,
        display_height_px: 768,
        display_number: 1,
      },
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: false },
    top_k: 40,
    stop_sequences: ['</end>'],
    service_tier: 'standard',
    metadata: { user_id: 'sim' },
  };
}

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let captured: CapturedCall[] = [];
let upstreamResponseBody: unknown;

const realFetch = globalThis.fetch;

/** Anthropic-shaped 200, so the relay treats the round trip as a success. */
function anthropicOk(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_simulation',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 4 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function installFetchStub(): void {
  globalThis.fetch = (async (input: unknown, init: { headers: Record<string, string>; body: string }) => {
    captured.push({
      url: String(input),
      headers: { ...init.headers },
      body: JSON.parse(init.body) as Record<string, unknown>,
    });
    const model = typeof (upstreamResponseBody as { model?: unknown })?.model === 'string'
      ? (upstreamResponseBody as { model: string }).model
      : 'claude-sonnet-5';
    return anthropicOk(model);
  }) as unknown as typeof fetch;
}

/** Insert a channel + a client key, then make them routable. */
async function seedChannel(options: { baseUrl?: string; mapping?: Record<string, string> } = {}): Promise<void> {
  const now = Date.now();

  await db.insert(channels)
    .values({
      name: 'Simulation Anthropic',
      type: 'anthropic',
      baseUrl: options.baseUrl ?? 'https://upstream.test/v1',
      keys: encryptKeyList([UPSTREAM_KEY]),
      models: JSON.stringify(['claude-sonnet-5']),
      modelMapping: JSON.stringify(options.mapping ?? {}),
      group: 'default',
      priority: 0,
      weight: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

  await db.insert(apiKeys)
    .values({
      name: 'simulation',
      keyHash: hashApiKey(normalizeApiKey(CLIENT_KEY)),
      keyPreview: 'sk-sim…0000',
      group: 'default',
      modelLimit: '[]',
      status: 'active',
      expiresAt: null,
      createdAt: now,
    });

  await rebuildRoutingIndex();
}

/** Remove exactly the rows this suite seeds — nothing else. */
async function cleanSimulationRows(): Promise<void> {
  await db.delete(channels).where(eq(channels.name, 'Simulation Anthropic'));
  await db.delete(apiKeys).where(eq(apiKeys.name, 'simulation'));
}

let app: Awaited<ReturnType<typeof buildApp>>;

before(async () => {
  await migrate();
  installFetchStub();
  app = await buildApp();
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  await app.close().catch(() => undefined);
  await cleanSimulationRows().catch(() => undefined);
  await pg.end();
});

describe('Claude Code reaches the provider untouched', () => {
  test('thinking, effort, tools and beta headers all arrive upstream', async () => {
    await cleanSimulationRows();
    await seedChannel();
    captured = [];

    const body = claudeCodeBody();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: CLAUDE_CODE_HEADERS,
      payload: body,
    });

    assert.equal(response.statusCode, 200, response.body);

    const [call] = captured;
    assert.ok(call, 'the gateway never called the provider');
    assert.equal(call.url, 'https://upstream.test/v1/messages');

    // Beta opt-ins survive: this is what unlocks interleaved thinking and the
    // Claude Code tool versions on the provider side.
    assert.equal(
      call.headers['anthropic-beta'],
      'claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20',
    );
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    // The client's own key must never be replayed; the channel's key is used.
    assert.equal(call.headers['x-api-key'], UPSTREAM_KEY);

    // Byte-for-byte passthrough: nothing filtered, nothing rewritten.
    assert.deepEqual(call.body, body);
  });

  test('model mapping rewrites the model and nothing else', async () => {
    await cleanSimulationRows();
    await seedChannel({ mapping: { 'claude-sonnet-5': 'MiniMaxAI/MiniMax-M3' } });
    captured = [];

    const body = claudeCodeBody();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: CLAUDE_CODE_HEADERS,
      payload: body,
    });

    assert.equal(response.statusCode, 200, response.body);

    const [call] = captured;
    assert.ok(call);
    assert.equal(call.body['model'], 'MiniMaxAI/MiniMax-M3');
    assert.deepEqual(call.body['thinking'], { type: 'enabled', budget_tokens: 10000 });
    assert.deepEqual(call.body['output_config'], { effort: 'high' });
    assert.deepEqual(call.body['tools'], body['tools']);
  });

  test('a pasted endpoint URL does not get the endpoint appended twice', async () => {
    await cleanSimulationRows();
    await seedChannel({ baseUrl: 'https://upstream.test/v1/messages' });
    captured = [];

    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: CLAUDE_CODE_HEADERS,
      payload: claudeCodeBody(),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(captured[0]?.url, 'https://upstream.test/v1/messages');
  });
});

describe('base URL normalisation', () => {
  test('known endpoint suffixes are peeled off', () => {
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com/v1');
    assert.equal(
      normalizeBaseUrl('https://api.openai.com/v1/chat/completions'),
      'https://api.openai.com/v1',
    );
  });

  test('the mistake can be repeated and is still cleaned', () => {
    assert.equal(
      normalizeBaseUrl('https://api.anthropic.com/v1/messages/messages'),
      'https://api.anthropic.com/v1',
    );
  });

  test('trailing slashes, query strings and fragments are dropped', () => {
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1/'), 'https://api.anthropic.com/v1');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1?beta=true'), 'https://api.anthropic.com/v1');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1#docs'), 'https://api.anthropic.com/v1');
  });

  test('a correct base URL is left alone — /v1 must survive', () => {
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1');
    assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1');
    assert.equal(normalizeBaseUrl('https://gateway.example.com/api/v3'), 'https://gateway.example.com/api/v3');
  });

  test('it is idempotent', () => {
    const once = normalizeBaseUrl('https://api.anthropic.com/v1/messages');
    assert.equal(normalizeBaseUrl(once), once);
  });
});

describe('client header passthrough is scoped', () => {
  test('beta headers go to an Anthropic upstream', () => {
    const forwarded = clientPassthroughHeaders(
      { 'anthropic-beta': 'interleaved-thinking-2025-05-14', 'anthropic-version': '2023-06-01' },
      RelayFormat.Claude,
    );
    assert.deepEqual(forwarded, {
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
    });
  });

  test('nothing is forwarded to an OpenAI-compatible upstream', () => {
    const forwarded = clientPassthroughHeaders(
      { 'anthropic-beta': 'interleaved-thinking-2025-05-14', authorization: 'Bearer sk-leak' },
      RelayFormat.OpenAI,
    );
    assert.deepEqual(forwarded, {});
  });

  test('credentials are never among the forwarded headers', () => {
    const forwarded = clientPassthroughHeaders(
      { authorization: 'Bearer sk-leak', 'x-api-key': 'sk-leak', 'anthropic-beta': 'beta-x' },
      RelayFormat.Claude,
    );
    assert.deepEqual(forwarded, { 'anthropic-beta': 'beta-x' });
  });
});

describe('Claude -> OpenAI keeps what an OpenAI endpoint can honour', () => {
  test('computer-use tools survive with their display fields', () => {
    const converted = convertClaudeRequestToOpenAI(
      claudeCodeBody() as never,
    ) as unknown as { tools: unknown[] };

    const computer = converted.tools.find(
      (tool) => (tool as { name?: string }).name === 'computer',
    ) as Record<string, unknown>;

    assert.equal(computer['type'], 'computer_20250124');
    assert.equal(computer['display_width_px'], 1024);
    assert.equal(computer['display_height_px'], 768);
    assert.equal(computer['display_number'], 1);
  });

  test('a plain tool is still rewritten into an OpenAI function tool', () => {
    const converted = convertClaudeRequestToOpenAI(claudeCodeBody() as never) as unknown as {
      tools: { type: string; function: { name: string; parameters: unknown } }[];
    };

    const read = converted.tools.find((tool) => tool.function?.name === 'Read');
    assert.ok(read);
    assert.equal(read.type, 'function');
    assert.deepEqual(read.function.parameters, {
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });

  test('effort becomes reasoning_effort, and the budget is the fallback', () => {
    const fromEffort = convertClaudeRequestToOpenAI(claudeCodeBody() as never) as unknown as {
      reasoning_effort: string;
    };
    assert.equal(fromEffort.reasoning_effort, 'high');

    const withoutEffort = claudeCodeBody() as Record<string, unknown>;
    delete withoutEffort['output_config'];
    const fromBudget = convertClaudeRequestToOpenAI(withoutEffort as never) as unknown as {
      reasoning_effort: string;
    };
    // 10000 tokens is above the "high" threshold.
    assert.equal(fromBudget.reasoning_effort, 'high');
  });
});
