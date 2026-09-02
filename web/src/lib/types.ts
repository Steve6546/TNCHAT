export type ChannelType = 'openai' | 'anthropic' | 'minimax' | 'generic' | 'custom';

/** The channel kinds the gateway can actually route to. Mirrors `CHANNEL_TYPES`. */
export const CHANNEL_TYPES = ['openai', 'anthropic', 'minimax', 'generic', 'custom'] as const;

/** How the key is presented upstream. Only `custom` reads it; built-ins ignore it. */
export type AuthStyle = 'bearer' | 'x-api-key' | 'none';

/**
 * The channel kinds, with labels, for the channel-type dropdown.
 *
 * The dropdown is fixed to these: a kind that is not one of them cannot be
 * typed, and the server rejects it too. The server's own list is preferred when
 * it loads, so a future adaptor appears without a dashboard change.
 *
 * `custom` is last because it is the escape hatch, not the default: it takes
 * the endpoint exactly as typed and asks for the auth style and any extra
 * headers, which is everything a provider that is none of the above needs.
 */
export const CHANNEL_TYPE_OPTIONS: ChannelTypeOption[] = [
  { kind: 'openai', label: 'OpenAI', upstreamFormat: 'openai' },
  { kind: 'anthropic', label: 'Anthropic', upstreamFormat: 'claude' },
  { kind: 'minimax', label: 'MiniMax', upstreamFormat: 'openai' },
  { kind: 'generic', label: 'OpenAI-compatible', upstreamFormat: 'openai' },
  { kind: 'custom', label: 'مخصّص (أي API خارجي)', upstreamFormat: 'openai' },
];

/**
 * The dashboard session issued after Supabase sign-in or sign-up.
 *
 * `token` authorises `/api/*`. There is no expiry field by design: the session
 * lasts until the user signs out or the browser tab closes.
 * `supabaseAccessToken` lets the settings page manage the account (password
 * change) directly with Supabase.
 */
export interface AuthSession {
  token: string;
  email: string;
  supabaseAccessToken: string;
  supabaseRefreshToken: string;
}

/** Response of a sign-up attempt when the project confirms emails first. */
export interface SignupNeedsConfirmation {
  needsConfirmation: true;
  email: string;
  message: string;
}

export type SignupResponse = ({ needsConfirmation: false } & AuthSession) | SignupNeedsConfirmation;

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
    database: string;
    supabaseHost: string;
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
  authStyle: AuthStyle;
  extraHeaders: Record<string, string>;
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
  authStyle: AuthStyle;
  extraHeaders: Record<string, string>;
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
  /** The base URL that answered — differs from the stored one when a probe resolved it. */
  baseUrl?: string;
  /** Operator-facing explanation shown alongside an upstream error. */
  hint?: string;
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
