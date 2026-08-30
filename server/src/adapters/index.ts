import { RelayFormat } from '../core/formats.js';
import type { Adaptor, AdaptorContext, ChannelType } from './types.js';

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
 * API version prefixes providers commonly sit their endpoint behind.
 */
const API_PREFIXES = ['/v1', '/api/v1'] as const;

/**
 * Alternative base URLs worth trying when the configured one answers 404.
 *
 * This covers the mirror image of the mistake `normalizeBaseUrl()` fixes.
 * There the operator pasted the *endpoint*; here they pasted the bare host —
 * `https://api.example.com` — because that is what a browser bar and most
 * provider dashboards show, while the provider actually serves chat under
 * `/v1`. The adaptor appends its path to the bare host and the provider
 * answers 404 `{"detail":"Not Found"}`, which reads like a dead channel even
 * though the key and model are fine.
 *
 * Consumed by the channel probe, which retries only on 404: a 401/403 is a
 * real answer from the right path, so guessing a different path there would
 * mask a credential problem.
 *
 * `custom` returns nothing. That adaptor exists precisely so the operator can
 * dictate the exact endpoint, and second-guessing it would defeat the point.
 */
export function candidateBaseUrls(kind: ChannelType, baseUrl: string): string[] {
  if (kind === 'custom') return [];

  const root = normalizeBaseUrl(baseUrl);
  const lower = root.toLowerCase();

  const out: string[] = [];
  for (const prefix of API_PREFIXES) {
    // Already carries a version segment; adding another cannot help.
    if (lower.endsWith(prefix)) return [];
    out.push(`${root}${prefix}`);
  }
  return out;
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

/**
 * The fully-flexible adaptor.
 *
 * The URL is used as written — no path is appended, no suffix is peeled —
 * because an operator who reaches for "Custom" is the one who already knows
 * the exact endpoint their provider exposes, and second-guessing them is how
 * a working channel gets broken. Auth style and any extra headers come from
 * the channel row, so a single `custom` channel can talk to APIs that want
 * `Authorization: Bearer`, `x-api-key:`, or no auth header at all.
 *
 * The upstream speaks OpenAI Chat Completions by default; the format
 * converters handle Claude->OpenAI translation the same way they do for
 * `openai`/`generic`/`minimax`.
 */
const customAdaptor: Adaptor = {
  kind: 'custom',
  label: 'مخصّص (أي API خارجي)',
  upstreamFormat: RelayFormat.OpenAI,
  buildUrl: (baseUrl) => {
    const cleaned = baseUrl.trim().split(/[?#]/, 1)[0] ?? '';
    // Trailing slashes are stripped (most providers 404 on them); the rest is
    // left to the operator exactly as they typed it.
    return cleaned.replace(/\/+$/, '');
  },
  buildHeaders: (apiKey, context?: AdaptorContext) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const style = context?.authStyle ?? 'bearer';
    if (style === 'bearer' && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`;
    else if (style === 'x-api-key' && apiKey !== '') headers['x-api-key'] = apiKey;
    // The operator's headers go in last so they win — same rule as client
    // header passthrough, applied to channel config for symmetry.
    for (const [name, value] of Object.entries(context?.extraHeaders ?? {})) {
      if (name.trim() === '' || typeof value !== 'string') continue;
      headers[name.toLowerCase()] = value;
    }
    return headers;
  },
};

const registry: Record<ChannelType, Adaptor> = {
  openai: openaiCompatible('openai', 'OpenAI'),
  anthropic: anthropicAdaptor,
  minimax: openaiCompatible('minimax', 'MiniMax'),
  generic: openaiCompatible('generic', 'OpenAI-compatible'),
  custom: customAdaptor,
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
