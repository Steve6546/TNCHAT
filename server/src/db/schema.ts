import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, pgTable, serial, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Schema notes.
 *
 * `abilities` is a materialised routing index, the same idea as
 * `model/ability.go` in new-api: a row per (group, model, channel) triple.
 * It is rebuilt whenever a channel changes so request-time selection is an
 * in-memory lookup instead of a scan over channel JSON.
 *
 * `apiKeys.keyHash` is SHA-256 of the key. The plaintext key is shown exactly
 * once, at creation time, and never persisted.
 *
 * `requestLogs` is the sole source of every number on the dashboard. There is
 * no aggregate table to drift out of sync with it.
 *
 * Timestamps stay in **epoch milliseconds** (the invariant the dashboard and
 * the old SQLite schema share) so every consumer keeps working unchanged.
 * They are `bigint` columns because epoch milliseconds exceed Postgres'
 * 32-bit integer range; Drizzle reads them back as JS numbers.
 */

const epochNow = sql`(extract(epoch from now()) * 1000)::bigint`;

export const channels = pgTable(
  'channels',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),

    /** Adaptor kind: openai | anthropic | minimax | generic | custom */
    type: text('type').notNull(),
    baseUrl: text('base_url').notNull(),

    /** JSON array of AES-256-GCM encrypted upstream keys. */
    keys: text('keys').notNull().default('[]'),

    /** JSON array of client-facing model names this channel can serve. */
    models: text('models').notNull().default('[]'),

    /** JSON object { "requested": "upstream" }. Supports chained redirects. */
    modelMapping: text('model_mapping').notNull().default('{}'),

    /** `group` is a reserved word in SQL — Drizzle quotes every identifier. */
    group: text('group').notNull().default('default'),
    priority: integer('priority').notNull().default(0),
    weight: integer('weight').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),

    /**
     * Only the `custom` adaptor reads these. They exist on every row so the
     * relay pipeline can pass a uniform context to every adaptor without a
     * `WHERE type = ?` branch — `bearer` / `{}` are the right defaults for the
     * built-in adaptors, which ignore both fields.
     */
    authStyle: text('auth_style').notNull().default('bearer'),
    extraHeaders: text('extra_headers').notNull().default('{}'),

    /** Last live probe result. Drives the model health column in the UI. */
    status: text('status').notNull().default('unknown'),
    lastLatencyMs: integer('last_latency_ms'),
    lastTestedAt: bigint('last_tested_at', { mode: 'number' }),
    lastError: text('last_error'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull().default(epochNow),
    updatedAt: bigint('updated_at', { mode: 'number' }).notNull().default(epochNow),
  },
  (table) => [index('idx_channels_enabled').on(table.enabled)],
);

export const abilities = pgTable(
  'abilities',
  {
    id: serial('id').primaryKey(),
    group: text('group').notNull(),
    model: text('model').notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(0),
    weight: integer('weight').notNull().default(0),
  },
  (table) => [
    index('idx_abilities_lookup').on(table.group, table.model),
    uniqueIndex('idx_abilities_unique').on(table.group, table.model, table.channelId),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),

    /** SHA-256 of the full key. Never store the key itself. */
    keyHash: text('key_hash').notNull().unique(),

    /** Display-only hint, e.g. "sk-a1b2…9z". Safe to render anywhere. */
    keyPreview: text('key_preview').notNull(),

    group: text('group').notNull().default('default'),

    /** JSON array of allowed models. Empty means unrestricted. */
    modelLimit: text('model_limit').notNull().default('[]'),

    status: text('status').notNull().default('active'),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    lastUsedAt: bigint('last_used_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull().default(epochNow),
  },
  (table) => [index('idx_api_keys_status').on(table.status)],
);

export const requestLogs = pgTable(
  'request_logs',
  {
    id: serial('id').primaryKey(),

    keyId: integer('key_id'),
    keyName: text('key_name').notNull().default(''),
    channelId: integer('channel_id'),
    channelName: text('channel_name').notNull().default(''),

    /** What the client asked for vs. what the upstream actually received. */
    model: text('model').notNull(),
    upstreamModel: text('upstream_model').notNull().default(''),
    clientFormat: text('client_format').notNull(),
    upstreamFormat: text('upstream_format').notNull().default(''),

    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),

    statusCode: integer('status_code').notNull().default(0),
    ok: boolean('ok').notNull().default(false),
    latencyMs: integer('latency_ms').notNull().default(0),
    isStream: boolean('is_stream').notNull().default(false),
    errorMessage: text('error_message'),

    createdAt: bigint('created_at', { mode: 'number' }).notNull().default(epochNow),
  },
  (table) => [
    index('idx_logs_created').on(table.createdAt),
    index('idx_logs_model').on(table.model),
    index('idx_logs_channel').on(table.channelId),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
export type AbilityRow = typeof abilities.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
