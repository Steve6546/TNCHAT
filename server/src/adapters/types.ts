import type { RelayFormat } from '../core/formats.js';

/**
 * Adaptor contract.
 *
 * Deliberately narrower than new-api's `relay/channel.Adaptor`: protocol
 * conversion lives in `src/convert/` (shared by every provider), so an adaptor
 * here is only responsible for what is genuinely provider-specific — the URL,
 * the auth header, and name quirks.
 */
export type ChannelType = 'openai' | 'anthropic' | 'minimax' | 'generic' | 'custom';

export type AuthStyle = 'bearer' | 'x-api-key' | 'none';

/**
 * Per-call context passed to adaptors. Only `custom` reads anything beyond
 * the api key today; the others are documented to ignore it so a future
 * field can be added without touching every implementation.
 */
export interface AdaptorContext {
  authStyle?: AuthStyle;
  extraHeaders?: Record<string, string>;
}

export interface Adaptor {
  readonly kind: ChannelType;
  readonly label: string;
  /** Wire format this provider endpoint speaks. */
  readonly upstreamFormat: RelayFormat;
  /** Build the outbound URL from the channel base URL. */
  buildUrl(baseUrl: string): string;
  /** Build the outbound headers from the channel key + context. */
  buildHeaders(apiKey: string, context?: AdaptorContext): Record<string, string>;
  /** Provider-specific rewrite applied after user-defined model mapping. */
  normalizeUpstreamModel?(model: string): string;
}

export const CHANNEL_TYPES: ChannelType[] = ['openai', 'anthropic', 'minimax', 'generic', 'custom'];

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as string[]).includes(value);
}
