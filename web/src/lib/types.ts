export type ChannelType = 'openai' | 'anthropic' | 'minimax' | 'generic';

/** The channel kinds the gateway can actually route to. Mirrors `CHANNEL_TYPES`. */
export const CHANNEL_TYPES = ['openai', 'anthropic', 'minimax', 'generic'] as const;

/**
 * The same four kinds, with labels, for the channel-type dropdown.
 *
 * The dropdown is fixed to these: a kind that is not one of them cannot be
 * typed, and the server rejects it too. The server's own list is preferred when
 * it loads, so a future adaptor appears without a dashboard change.
 */
export const CHANNEL_TYPE_OPTIONS: ChannelTypeOption[] = [
  { kind: 'openai', label: 'OpenAI', upstreamFormat: 'openai' },
  { kind: 'anthropic', label: 'Anthropic', upstreamFormat: 'claude' },
  { kind: 'minimax', label: 'MiniMax', upstreamFormat: 'openai' },
  { kind: 'generic', label: 'OpenAI-compatible', upstreamFormat: 'openai' },
];

/** What the server returns when it issues a dashboard session. */
export interface SessionPayload {
  token: string;
  /** ISO-8601 instant — when the server stops accepting this token. */
  expiresAt: string;
  /** ISO-8601 instant — the server's own clock at issue time, for skew correction. */
  serverTime: string;
  expiresInHours: number;
}

/** Mirrors `safeConfigSummary()` on the server — safe to display anywhere. */
export interface HealthInfo {
  ok: boolean;
  uptimeSeconds: number;
  database: 'ok' | 'error';
  routingPairs: number;
  abilityRows: number;
  config: {
    environment: string;
    host: string;
    port: number;
    retryTimes: number;
    requestTimeoutMs: number;
    streamingTimeoutMs: number;
    masterKeySource: string;
    sessionSecretSource: string;
    cors: string | string[];
    trustProxy: boolean;
    servingDashboard: boolean;
  };
}

export interface Channel {
  id: number;
  name: string;
  type: ChannelType;
  baseUrl: string;
  keyPreviews: string[];
  keyCount: number;
  models: string[];
  modelMapping: Record<string, string>;
  group: string;
  priority: number;
  weight: number;
  enabled: boolean;
  status: 'unknown' | 'healthy' | 'failing' | string;
  lastLatencyMs: number | null;
  lastTestedAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelTypeOption {
  kind: ChannelType;
  label: string;
  upstreamFormat: string;
}

export interface ChannelPayload {
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

export interface ChannelTestResult {
  ok: boolean;
  message: string;
  latencyMs: number | null;
  statusCode?: number;
  model?: string;
}

export interface ApiKeyItem {
  id: number;
  name: string;
  keyPreview: string;
  group: string;
  modelLimit: string[];
  status: 'active' | 'disabled' | string;
  expiresAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface StatsOverview {
  today: {
    requests: number;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    avgLatencyMs: number;
    successRate: number | null;
  };
  lifetime: {
    requests: number;
    tokens: number;
    avgLatencyMs: number;
    successRate: number | null;
  };
  series: Array<{ day: string; requests: number; tokens: number; successes: number }>;
  byModel: Array<{ name: string; requests: number; tokens: number; avgLatencyMs: number; errors: number }>;
  byChannel: Array<{ name: string; requests: number; tokens: number; avgLatencyMs: number; errors: number }>;
  recent: Array<{
    id: number;
    model: string;
    upstreamModel: string;
    channelName: string;
    clientFormat: string;
    upstreamFormat: string;
    totalTokens: number;
    statusCode: number;
    ok: boolean;
    latencyMs: number;
    isStream: boolean;
    errorMessage: string | null;
    createdAt: number;
  }>;
}
