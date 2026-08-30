import type { RelayFormat } from '../core/formats.js';

/**
 * Adaptor contract.
 *
 * Deliberately narrower than new-api's `relay/channel.Adaptor`: protocol
 * conversion lives in `src/convert/` (shared by every provider), so an adaptor
 * here is only responsible for what is genuinely provider-specific — the URL,
 * the auth header, and name quirks.
 */
export type ChannelType = 'openai' | 'anthropic' | 'minimax' | 'generic';

export interface Adaptor {
  readonly kind: ChannelType;
  readonly label: string;
  /** Wire format this provider endpoint speaks. */
  readonly upstreamFormat: RelayFormat;
  /** Append to the channel base URL. */
  buildUrl(baseUrl: string): string;
  buildHeaders(apiKey: string): Record<string, string>;
  /** Provider-specific rewrite applied after user-defined model mapping. */
  normalizeUpstreamModel?(model: string): string;
}

export const CHANNEL_TYPES: ChannelType[] = ['openai', 'anthropic', 'minimax', 'generic'];

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === 'string' && (CHANNEL_TYPES as string[]).includes(value);
}
