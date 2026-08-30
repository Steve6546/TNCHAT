import { RelayFormat } from '../core/formats.js';
import type { Adaptor, ChannelType } from './types.js';

/**
 * Adaptors translate "which provider is this" into two concrete things:
 * the upstream URL and the auth headers. Everything else about a request —
 * body shape, streaming, error mapping — is handled by the format converters.
 */

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * The endpoint names that may show up at the end of a pasted "Base URL".
 *
 * Operators paste whatever the provider's docs show on the sample request —
 * `https://api.anthropic.com/v1/messages`, `https://api.openai.com/v1/chat/completions`
 * — and the adaptor then appends the endpoint again, producing
 * `/v1/messages/messages`. The provider answers 404 `{"detail":"Not Found"}`
 * and the channel looks dead even though credentials and model are fine.
 *
 * Longest first, so `/v1/chat/completions` is not half-matched as `/completions`
 * and leave `/v1` alone: stripping it would turn a working OpenAI base into
 * `https://api.openai.com/chat/completions`, which does not exist.
 */
const ENDPOINT_SUFFIXES = ['/chat/completions', '/messages', '/completions'] as const;

/**
 * Reduce a pasted base URL to the provider root the adaptors expect.
 *
 * Repeated suffixes are peeled in a loop because a URL can carry the same
 * mistake twice (`/v1/messages/messages`). Idempotent: feeding the output back
 * in changes nothing, so it is safe to apply on save and again on every call.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  // A query string or fragment has no meaning on a base URL and would be
  // appended to the endpoint path, so it is dropped rather than escaped.
  let url = (baseUrl.trim().split(/[?#]/, 1)[0] ?? '').replace(/\/+$/, '');

  for (;;) {
    const lower = url.toLowerCase();
    const hit = ENDPOINT_SUFFIXES.find((suffix) => lower.endsWith(suffix));
    if (hit === undefined) return url;
    url = url.slice(0, -hit.length).replace(/\/+$/, '');
  }
}

/**
 * Most providers in practice expose an OpenAI-compatible chat endpoint, so they
 * share one definition. They stay distinct kinds because the operator picks
 * them by name and the label is what shows up in the UI.
 *
 * Provider quirks are only added here once observed on a real request. A
 * previous revision stripped the `MiniMaxAI/` vendor prefix when talking to
 * MiniMax's Anthropic endpoint, based on their documentation; the live
 * `api.gmi-serving.com` endpoint answers 404 "No matching target server found
 * for model MiniMax-M3" and only accepts the fully-qualified
 * `MiniMaxAI/MiniMax-M3`. The rewrite was removed rather than kept on a guess.
 */
function openaiCompatible(kind: ChannelType, label: string): Adaptor {
  return {
    kind,
    label,
    upstreamFormat: RelayFormat.OpenAI,
    buildUrl: (baseUrl) => joinUrl(normalizeBaseUrl(baseUrl), '/chat/completions'),
    buildHeaders: (apiKey) => ({
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }),
  };
}

const anthropicAdaptor: Adaptor = {
  kind: 'anthropic',
  label: 'Anthropic',
  upstreamFormat: RelayFormat.Claude,
  buildUrl: (baseUrl) => joinUrl(normalizeBaseUrl(baseUrl), '/messages'),
  buildHeaders: (apiKey) => ({
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }),
};

const registry: Record<ChannelType, Adaptor> = {
  openai: openaiCompatible('openai', 'OpenAI'),
  anthropic: anthropicAdaptor,
  minimax: openaiCompatible('minimax', 'MiniMax'),
  generic: openaiCompatible('generic', 'OpenAI-compatible'),
};

export function getAdaptor(kind: ChannelType): Adaptor {
  const adaptor = registry[kind];
  if (!adaptor) {
    throw new Error(`Unknown channel type "${kind}"`);
  }
  return adaptor;
}

/** Drives the channel-type dropdown in the dashboard. */
export function listAdaptors(): Adaptor[] {
  return Object.values(registry);
}
