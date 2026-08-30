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
    buildUrl: (baseUrl) => joinUrl(baseUrl, '/chat/completions'),
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
  buildUrl: (baseUrl) => joinUrl(baseUrl, '/messages'),
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
