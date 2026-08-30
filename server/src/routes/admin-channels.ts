import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { getAdaptor, listAdaptors } from '../adapters/index.js';
import { CHANNEL_TYPES } from '../adapters/types.js';
import type { ChannelType } from '../adapters/types.js';
import { config } from '../config.js';
import { GatewayError } from '../core/errors.js';
import { db } from '../db/index.js';
import { channels } from '../db/schema.js';
import { rebuildRoutingIndex } from '../gateway/ability-index.js';
import { parseModelMapping, resolveModelMapping } from '../gateway/model-mapping.js';
import { callUpstream, readUpstreamError } from '../gateway/upstream.js';
import { parseStringList } from '../lib/json.js';
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
  group: string;
  priority: number;
  weight: number;
  enabled: boolean;
}

function parseChannelInput(body: unknown, partial: boolean): Partial<ChannelInput> {
  const source = (body ?? {}) as Record<string, unknown>;
  const out: Partial<ChannelInput> = {};

  if (!partial || source['name'] !== undefined) out.name = v.str(source['name'], 'name', { min: 1, max: 120 });
  if (!partial || source['type'] !== undefined) out.type = v.oneOf(source['type'], 'type', CHANNEL_TYPES);
  if (!partial || source['baseUrl'] !== undefined) out.baseUrl = v.requireUrl(source['baseUrl'], 'baseUrl');
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

    const input = parseChannelInput(request.body, true);
    const patch: Record<string, unknown> = { updatedAt: Date.now() };

    if (input.name !== undefined) patch['name'] = input.name;
    if (input.type !== undefined) patch['type'] = input.type;
    if (input.baseUrl !== undefined) patch['base_url'] = input.baseUrl;
    if (input.models !== undefined) patch['models'] = JSON.stringify(input.models);
    if (input.modelMapping !== undefined) patch['model_mapping'] = JSON.stringify(input.modelMapping);
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

    const adaptor = getAdaptor(row.type as ChannelType);
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

    const startedAt = Date.now();
    try {
      const response = await callUpstream({
        url: adaptor.buildUrl(row.baseUrl),
        headers: adaptor.buildHeaders(keys[0]!),
        body: payload,
        timeoutMs: Math.min(config.requestTimeoutMs, 60_000),
      });

      const latencyMs = Date.now() - startedAt;

      if (!response.ok) {
        const message = await readUpstreamError(response);
        db.update(channels)
          .set({ status: 'failing', lastError: message.slice(0, 500), lastLatencyMs: latencyMs, lastTestedAt: Date.now() })
          .where(eq(channels.id, id))
          .run();
        return reply.send({ ok: false, message, latencyMs, statusCode: response.status });
      }

      // Drain the body so the socket is released.
      await response.text().catch(() => '');

      db.update(channels)
        .set({ status: 'healthy', lastError: null, lastLatencyMs: latencyMs, lastTestedAt: Date.now() })
        .where(eq(channels.id, id))
        .run();

      return reply.send({ ok: true, message: 'Connected', latencyMs, model: targetModel });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed';
      db.update(channels)
        .set({ status: 'failing', lastError: message.slice(0, 500), lastTestedAt: Date.now() })
        .where(eq(channels.id, id))
        .run();
      return reply.send({ ok: false, message, latencyMs: null });
    }
  });
}
