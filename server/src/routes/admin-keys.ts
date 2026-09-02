import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { GatewayError } from '../core/errors.js';
import { db } from '../db/index.js';
import { apiKeys } from '../db/schema.js';
import { generateApiKey, hashApiKey } from '../lib/crypto.js';
import { parseStringList } from '../lib/json.js';
import * as v from '../lib/validate.js';

/**
 * API key management.
 *
 * The plaintext key exists in exactly one place: the HTTP response body of the
 * create call. It is hashed before storage, so a later read can only ever
 * return the preview.
 */

function previewOf(key: string): string {
  return `${key.slice(0, 7)}${'•'.repeat(6)}${key.slice(-4)}`;
}

function serialize(row: typeof apiKeys.$inferSelect) {
  const modelLimit = parseStringList(row.modelLimit);

  return {
    id: row.id,
    name: row.name,
    keyPreview: row.keyPreview,
    group: row.group,
    modelLimit,
    status: row.status,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/keys', async (_request, reply) => {
    const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.id));
    return reply.send({ data: rows.map(serialize) });
  });

  app.post('/api/keys', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const name = v.str(body['name'] ?? 'Untitled key', 'name', { max: 120 });
    const group = v.optionalStr(body['group'], 'group', 120) ?? 'default';
    const modelLimit = v.strArray(body['modelLimit'], 'modelLimit');
    const expiresAtRaw = body['expiresAt'];
    const expiresAt =
      expiresAtRaw === null || expiresAtRaw === undefined ? null : v.int(expiresAtRaw, 'expiresAt');

    const key = generateApiKey();
    const now = Date.now();

    const insertedRows = await db
      .insert(apiKeys)
      .values({
        name,
        keyHash: hashApiKey(key.replace(/^sk-/, '')),
        keyPreview: previewOf(key),
        group: group === '' ? 'default' : group,
        modelLimit: JSON.stringify(modelLimit),
        status: 'active',
        expiresAt,
        createdAt: now,
      })
      .returning();
    const inserted = insertedRows[0]!;

    return reply.code(201).send({
      data: serialize(inserted),
      /** Returned once and never again. */
      key,
    });
  });

  app.patch('/api/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = v.int((request.params as Record<string, unknown>)['id'], 'id');
    const existingRows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const existing = existingRows[0];
    if (!existing) throw GatewayError.notFound('API key not found');

    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (body['name'] !== undefined) patch['name'] = v.str(body['name'], 'name', { max: 120 });
    if (body['group'] !== undefined) patch['group'] = v.str(body['group'], 'group', { max: 120 });
    if (body['modelLimit'] !== undefined) patch['model_limit'] = JSON.stringify(v.strArray(body['modelLimit'], 'modelLimit'));
    if (body['status'] !== undefined) patch['status'] = v.oneOf(body['status'], 'status', ['active', 'disabled'] as const);
    if (body['expiresAt'] !== undefined) {
      patch['expires_at'] = body['expiresAt'] === null ? null : v.int(body['expiresAt'], 'expiresAt');
    }

    if (Object.keys(patch).length > 0) {
      await db.update(apiKeys).set(patch).where(eq(apiKeys.id, id));
    }

    const updatedRows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return reply.send({ data: serialize(updatedRows[0]!) });
  });

  app.delete('/api/keys/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = v.int((request.params as Record<string, unknown>)['id'], 'id');
    const existingRows = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    const existing = existingRows[0];
    if (!existing) throw GatewayError.notFound('API key not found');

    await db.delete(apiKeys).where(eq(apiKeys.id, id));
    return reply.send({ ok: true });
  });
}
