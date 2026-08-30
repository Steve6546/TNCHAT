import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  candidateBaseUrls,
  getAdaptor,
  listAdaptors,
  normalizeBaseUrl,
} from '../adapters/index.js';
import { CHANNEL_TYPES } from '../adapters/types.js';
import type { AdaptorContext, AuthStyle, ChannelType } from '../adapters/types.js';
import { config } from '../config.js';
import { GatewayError } from '../core/errors.js';
import { db } from '../db/index.js';
import { channels } from '../db/schema.js';
import { rebuildRoutingIndex } from '../gateway/ability-index.js';
import { parseModelMapping, resolveModelMapping } from '../gateway/model-mapping.js';
import { callUpstream, readUpstreamError } from '../gateway/upstream.js';
import { parseStringList, parseStringRecord } from '../lib/json.js';
import { decryptKeyList, encryptKeyList } from '../lib/secrets.js';
import * as v from '../lib/validate.js';

/**
 * Channel management.
 *
 * Upstream keys are encrypted before they touch the database and are never
 * returned to the client. The UI receives a mask only, which is enough to tell
 * two keys apart without disclosing either.
 */

const MAX_TEST_TOKENS = 16;

/** How the key is presented to a `custom` upstream. Built-ins ignore this. */
const AUTH_STYLES: readonly AuthStyle[] = ['bearer', 'x-api-key', 'none'];

function maskKey(key: string): string {
  if (key.length <= 12) return '•'.repeat(key.length);
  return `${key.slice(0, 6)}${'•'.repeat(Math.min(8, key.length - 10))}${key.slice(-4)}`;
}

function serialize(row: typeof channels.$inferSelect) {
  const keys = decryptKeyList(row.keys);

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.baseUrl,
    keyPreviews: keys.map(maskKey),
    keyCount: keys.length,
    models: parseStringList(row.models),
    modelMapping: parseModelMapping(row.modelMapping),
    authStyle: row.authStyle as AuthStyle,
    extraHeaders: parseStringRecord(row.extraHeaders),
    group: row.group,
    priority: row.priority,
    weight: row.weight,
    enabled: row.enabled,
    status: row.status,
    lastLatencyMs: row.lastLatencyMs,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

interface ChannelInput {
  name: string;
  type: ChannelType;
  baseUrl: string;
  keys: string[];
  models: string[];
  modelMapping: Record<string, string>;
  authStyle: AuthStyle;
  extraHeaders: Record<string, string>;
  group: string;
  priority: number;
  weight: number;
  enabled: boolean;
}

/**
 * Build the per-call context an adaptor receives, straight from a stored row.
 *
 * Shared by the probe and the relay so both send byte-identical headers — a
 * probe that authenticated differently from real traffic would be worthless.
 */
function adaptorContextOf(row: { authStyle: string; extraHeaders: string }): AdaptorContext {
  const style = row.authStyle;
  return {
    authStyle: (AUTH_STYLES as readonly string[]).includes(style) ? (style as AuthStyle) : 'bearer',
    extraHeaders: parseStringRecord(row.extraHeaders),
  };
}

function parseChannelInput(
  body: unknown,
  partial: boolean,
  currentType?: ChannelType,
): Partial<ChannelInput> {
  const source = (body ?? {}) as Record<string, unknown>;
  const out: Partial<ChannelInput> = {};

  if (!partial || source['name'] !== undefined) out.name = v.str(source['name'], 'name', { min: 1, max: 120 });
  if (!partial || source['type'] !== undefined) out.type = v.oneOf(source['type'], 'type', CHANNEL_TYPES);
  if (!partial || source['baseUrl'] !== undefined) {
    const raw = v.requireUrl(source['baseUrl'], 'baseUrl');
    // `custom` keeps the URL exactly as typed — the operator is telling us the
    // endpoint, and rewriting it is how working channels get broken.
    // Every other kind is normalised, on the way in as well as on the way out,
    // so the field shows the root the gateway will actually call rather than
    // the endpoint that was pasted.
    out.baseUrl = (out.type ?? currentType) === 'custom' ? raw : normalizeBaseUrl(raw);
  }

  if (!partial || source['authStyle'] !== undefined) {
    out.authStyle = v.oneOf(source['authStyle'] ?? 'bearer', 'authStyle', AUTH_STYLES);
  }
  if (!partial || source['extraHeaders'] !== undefined) {
    out.extraHeaders = v.record(source['extraHeaders'], 'extraHeaders');
  }

  if (!partial || source['keys'] !== undefined) out.keys = v.strArray(source['keys'], 'keys', 50);
  if (!partial || source['models'] !== undefined) out.models = v.strArray(source['models'], 'models');
  if (!partial || source['modelMapping'] !== undefined) out.modelMapping = v.record(source['modelMapping'], 'modelMapping');
  if (!partial || source['group'] !== undefined) out.group = (v.optionalStr(source['group'], 'group', 120) ?? 'default') || 'default';
  if (!partial || source['priority'] !== undefined) out.priority = v.int(source['priority'] ?? 0, 'priority', { min: -1000, max: 1000 });
  if (!partial || source['weight'] !== undefined) out.weight = v.int(source['weight'] ?? 0, 'weight', { min: 0, max: 1_000_000 });
  if (!partial || source['enabled'] !== undefined) out.enabled = v.optionalBool(source['enabled'], 'enabled', true);

  return out;
}

export async function registerChannelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels', async (_request, reply) => {
    const rows = db.select().from(channels).orderBy(channels.id).all();
    return reply.send({ data: rows.map(serialize) });
  });

  app.get('/api/channel-types', async (_request, reply) => {
    return reply.send({
      data: listAdaptors().map((adaptor) => ({
        kind: adaptor.kind,
        label: adaptor.label,
        upstreamFormat: adaptor.upstreamFormat,
      })),
    });
  });

  app.post('/api/channels', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseChannelInput(request.body, false) as ChannelInput;

    if (input.keys.length === 0) {
      throw GatewayError.badRequest('At least one API key is required', 'keys');
    }
    if (input.models.length === 0) {
      throw GatewayError.badRequest('At least one model is required', 'models');
    }

    const now = Date.now();

    const inserted = db
      .insert(channels)
      .values({
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        keys: encryptKeyList(input.keys),
        models: JSON.stringify(input.models),
        modelMapping: JSON.stringify(input.modelMapping),
        authStyle: input.authStyle,
        extraHeaders: JSON.stringify(input.extraHeaders),
        group: input.group,
        priority: input.priority,
        weight: input.weight,
        enabled: input.enabled,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();

    rebuildRoutingIndex();
    return reply.code(201).send({ data: serialize(inserted) });
  });

  app.patch('/api/channels/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = v.int((request.params as Record<string, unknown>)['id'], 'id');
    const existing = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!existing) throw GatewayError.notFound('Channel not found');

    const input = parseChannelInput(request.body, true, existing.type as ChannelType);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };

    if (input.name !== undefined) patch['name'] = input.name;
    if (input.type !== undefined) patch['type'] = input.type;
    if (input.baseUrl !== undefined) patch['base_url'] = input.baseUrl;
    if (input.models !== undefined) patch['models'] = JSON.stringify(input.models);
    if (input.modelMapping !== undefined) patch['model_mapping'] = JSON.stringify(input.modelMapping);
    if (input.authStyle !== undefined) patch['auth_style'] = input.authStyle;
    if (input.extraHeaders !== undefined) patch['extra_headers'] = JSON.stringify(input.extraHeaders);
    if (input.group !== undefined) patch['group'] = input.group;
    if (input.priority !== undefined) patch['priority'] = input.priority;
    if (input.weight !== undefined) patch['weight'] = input.weight;
    if (input.enabled !== undefined) patch['enabled'] = input.enabled;

    // An empty `keys` array means "leave the stored keys alone", so a partial
    // update that only renames a channel cannot wipe its credentials.
    if (input.keys !== undefined && input.keys.length > 0) {
      patch['keys'] = encryptKeyList(input.keys);
    }

    db.update(channels).set(patch).where(eq(channels.id, id)).run();
    rebuildRoutingIndex();

    const updated = db.select().from(channels).where(eq(channels.id, id)).get();
    return reply.send({ data: serialize(updated!) });
  });

  app.delete('/api/channels/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = v.int((request.params as Record<string, unknown>)['id'], 'id');
    const existing = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!existing) throw GatewayError.notFound('Channel not found');

    db.delete(channels).where(eq(channels.id, id)).run();
    rebuildRoutingIndex();
    return reply.send({ ok: true });
  });

  /**
   * Live probe. Sends a genuine minimal request to the provider and reports the
   * measured latency. A green tick here means traffic really flowed.
   *
   * On a 404 the probe does not give up immediately. It retries the same
   * request against the version-prefixed variants of the configured root (see
   * `candidateBaseUrls`, which is empty for `custom`), and when one of them
   * answers it **persists that root** so every later relay call goes straight
   * to the working endpoint. This is what turns a bare host such as
   * `https://api.example.com` into `https://api.example.com/v1` without the
   * operator having to know the prefix in advance.
   *
   * Only 404 triggers a retry. A 401/403 is a real answer from the right path,
   * so trying another path there would hide a credential problem behind a
   * confusing series of guesses.
   */
  app.post('/api/channels/:id/test', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = v.int((request.params as Record<string, unknown>)['id'], 'id');
    const row = db.select().from(channels).where(eq(channels.id, id)).get();
    if (!row) throw GatewayError.notFound('Channel not found');

    const keys = decryptKeyList(row.keys);
    if (keys.length === 0) {
      return reply.send({ ok: false, message: 'No usable API key configured', latencyMs: null });
    }

    const models = parseStringList(row.models);
    if (models.length === 0) {
      return reply.send({ ok: false, message: 'No models configured', latencyMs: null });
    }

    const kind = row.type as ChannelType;
    const adaptor = getAdaptor(kind);
    const context = adaptorContextOf(row);
    const mapped = resolveModelMapping(models[0]!, parseModelMapping(row.modelMapping));
    const targetModel = adaptor.normalizeUpstreamModel
      ? adaptor.normalizeUpstreamModel(mapped.upstreamModel)
      : mapped.upstreamModel;

    // Both wire formats accept this minimal request, so the probe is the same
    // call for every adaptor.
    const payload = {
      model: targetModel,
      max_tokens: MAX_TEST_TOKENS,
      messages: [{ role: 'user', content: 'ping' }],
    };

    interface Failure {
      statusCode: number | null;
      message: string;
      latencyMs: number | null;
    }
    let failure: Failure | null = null;

    for (const baseUrl of [row.baseUrl, ...candidateBaseUrls(kind, row.baseUrl)]) {
      const startedAt = Date.now();
      try {
        const response = await callUpstream({
          url: adaptor.buildUrl(baseUrl),
          headers: adaptor.buildHeaders(keys[0]!, context),
          body: payload,
          timeoutMs: Math.min(config.requestTimeoutMs, 60_000),
        });

        const latencyMs = Date.now() - startedAt;

        if (response.ok) {
          // Drain the body so the socket is released.
          await response.text().catch(() => '');

          if (baseUrl !== row.baseUrl) {
            // Remember the root that worked. The relay re-reads the row on
            // every request, so the fix applies immediately with no restart.
            db.update(channels).set({ baseUrl }).where(eq(channels.id, id)).run();
          }

          db.update(channels)
            .set({ status: 'healthy', lastError: null, lastLatencyMs: latencyMs, lastTestedAt: Date.now() })
            .where(eq(channels.id, id))
            .run();

          return reply.send({ ok: true, message: 'Connected', latencyMs, model: targetModel, baseUrl });
        }

        failure = {
          statusCode: response.status,
          message: await readUpstreamError(response),
          latencyMs,
        };
        if (response.status !== 404) break;
      } catch (error) {
        failure = {
          statusCode: null,
          message: error instanceof Error ? error.message : 'Connection failed',
          latencyMs: null,
        };
        break;
      }
    }

    const final: Failure = failure ?? { statusCode: null, message: 'Connection failed', latencyMs: null };

    db.update(channels)
      .set({
        status: 'failing',
        lastError: final.message.slice(0, 500),
        lastLatencyMs: final.latencyMs,
        lastTestedAt: Date.now(),
      })
      .where(eq(channels.id, id))
      .run();

    return reply.send({
      ok: false,
      message: final.message,
      latencyMs: final.latencyMs,
      statusCode: final.statusCode,
      // Shown alongside the upstream's own error so a wrong path reads as "fix
      // the endpoint" rather than as an inexplicable 404.
      hint:
        final.statusCode === 404
          ? 'Upstream returned 404: the endpoint path is wrong for this provider. Open the channel and set the exact Endpoint URL, or switch its type to Custom.'
          : undefined,
    });
  });
}
