import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
 */

export const channels = sqliteTable(
  'channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),

    /** Adaptor kind: openai | anthropic | minimax | generic */
    type: text('type').notNull(),
    baseUrl: text('base_url').notNull(),

    /** JSON array of AES-256-GCM encrypted upstream keys. */
    keys: text('keys').notNull().default('[]'),

    /** JSON array of client-facing model names this channel can serve. */
    models: text('models').notNull().default('[]'),

    /** JSON object { "requested": "upstream" }. Supports chained redirects. */
    modelMapping: text('model_mapping').notNull().default('{}'),

    group: text('group').notNull().default('default'),
    priority: integer('priority').notNull().default(0),
    weight: integer('weight').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

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
    lastTestedAt: integer('last_tested_at'),
    lastError: text('last_error'),

    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('idx_channels_enabled').on(table.enabled)],
);

export const abilities = sqliteTable(
  'abilities',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    group: text('group').notNull(),
    model: text('model').notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    priority: integer('priority').notNull().default(0),
    weight: integer('weight').notNull().default(0),
  },
  (table) => [
    index('idx_abilities_lookup').on(table.group, table.model),
    uniqueIndex('idx_abilities_unique').on(table.group, table.model, table.channelId),
  ],
);

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),

    /** SHA-256 of the full key. Never store the key itself. */
    keyHash: text('key_hash').notNull().unique(),

    /** Display-only hint, e.g. "sk-a1b2…9z". Safe to render anywhere. */
    keyPreview: text('key_preview').notNull(),

    group: text('group').notNull().default('default'),

    /** JSON array of allowed models. Empty means unrestricted. */
    modelLimit: text('model_limit').notNull().default('[]'),

    status: text('status').notNull().default('active'),
    expiresAt: integer('expires_at'),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index('idx_api_keys_status').on(table.status)],
);

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

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
    ok: integer('ok', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms').notNull().default(0),
    isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
    errorMessage: text('error_message'),

    createdAt: integer('created_at').notNull().default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index('idx_logs_created').on(table.createdAt),
    index('idx_logs_model').on(table.model),
    index('idx_logs_channel').on(table.channelId),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type ChannelRow = typeof channels.$inferSelect;
export type NewChannelRow = typeof channels.$inferInsert;
export type AbilityRow = typeof abilities.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type RequestLogRow = typeof requestLogs.$inferSelect;
