import { useAuthStore } from '../stores/auth-store';
import type {
  ApiKeyItem,
  Channel,
  ChannelPayload,
  ChannelTestResult,
  ChannelTypeOption,
  HealthInfo,
  SessionPayload,
  StatsOverview,
} from './types';

interface ApiErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/** Pulls the server's own message out of an error body, if there is one. */
function errorTextOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { error } = body as ApiErrorBody;
  return error?.message ?? null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every dashboard request goes through here.
 *
 * It does three things a bare `fetch` would not: attaches the session token,
 * logs the user out when the session expires, and turns a non-2xx response
 * into an `ApiError` carrying the server's own message so the UI can show it
 * verbatim instead of a generic failure.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useAuthStore.getState().token;
  const headers = new Headers(init?.headers);
  headers.set('Accept', 'application/json');
  if (init?.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      useAuthStore.getState().logout();
    }
    throw new ApiError(errorTextOf(body) ?? `فشل الطلب (${response.status})`, response.status);
  }

  return body as T;
}

/* ── Typed endpoints ─────────────────────────────────────────── */

const json = (body: unknown) => JSON.stringify(body);

export const endpoints = {
  health: () => api<HealthInfo>('/health'),

  authStatus: () => api<{ data: { configured: boolean; serverTime: string } }>('/api/auth/status'),
  login: (password: string) =>
    api<{ data: SessionPayload }>('/api/auth/login', {
      method: 'POST',
      body: json({ password }),
    }),
  setup: (password: string) =>
    api<{ data: SessionPayload }>('/api/auth/setup', {
      method: 'POST',
      body: json({ password }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: json({ currentPassword, newPassword }),
    }),

  channels: () => api<{ data: Channel[] }>('/api/channels'),
  channelTypes: () => api<{ data: ChannelTypeOption[] }>('/api/channel-types'),
  createChannel: (payload: ChannelPayload) =>
    api<{ data: Channel }>('/api/channels', { method: 'POST', body: json(payload) }),
  updateChannel: (id: number, payload: Partial<ChannelPayload>) =>
    api<{ data: Channel }>(`/api/channels/${id}`, { method: 'PATCH', body: json(payload) }),
  deleteChannel: (id: number) => api<{ ok: boolean }>(`/api/channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: number) =>
    api<ChannelTestResult>(`/api/channels/${id}/test`, { method: 'POST', body: json({}) }),

  keys: () => api<{ data: ApiKeyItem[] }>('/api/keys'),
  createKey: (payload: { name: string; group: string; modelLimit: string[]; expiresAt: number | null }) =>
    api<{ data: ApiKeyItem; key: string }>('/api/keys', { method: 'POST', body: json(payload) }),
  updateKey: (id: number, payload: Record<string, unknown>) =>
    api<{ data: ApiKeyItem }>(`/api/keys/${id}`, { method: 'PATCH', body: json(payload) }),
  deleteKey: (id: number) => api<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),

  statsOverview: (filter: LogFilter = {}) =>
    api<{ data: StatsOverview }>(`/api/stats/overview${queryString(filter)}`),
  clearLogs: (scope: LogScope) =>
    api<{ ok: boolean; deleted: number }>(`/api/stats/logs?scope=${scope}`, { method: 'DELETE' }),
};

/** `all` is every request ever logged; `errors` is only the failed ones. */
export type LogScope = 'errors' | 'all';

export interface LogFilter {
  /** `true` keeps 200 OK rows only, `false` keeps failures only. Omit for both. */
  ok?: boolean;
}

function queryString(filter: LogFilter): string {
  if (filter.ok === undefined) return '';
  return `?ok=${filter.ok ? '1' : '0'}`;
}

/**
 * The relay base URL a client application needs.
 *
 * Taken from the page's own origin so it always matches the host and port the
 * gateway is actually served from; the literal fallback only applies when the
 * bundle is opened outside a browser context.
 */
export function relayEndpoint(): string {
  const fallback = 'http://127.0.0.1:8787';
  if (typeof window === 'undefined') return `${fallback}/v1`;
  const { origin, protocol } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return `${fallback}/v1`;
  return `${origin}/v1`;
}

/** Query keys, centralised so invalidation cannot drift from the fetcher. */
export const queryKeys = {
  health: ['health'] as const,
  channels: ['channels'] as const,
  channelTypes: ['channel-types'] as const,
  keys: ['keys'] as const,
  stats: ['stats-overview'] as const,
  authStatus: ['auth-status'] as const,
};
