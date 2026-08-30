import { GatewayError } from '../core/errors.js';
import { RelayFormat } from '../core/formats.js';

/**
 * Client headers that are replayed to the provider, by upstream wire format.
 *
 * `anthropic-beta` is how a client opts into gated abilities — Claude Code
 * sends `interleaved-thinking-2025-05-14` and friends on every request.
 * Dropping it silently downgrades the call: the request still succeeds, but
 * extended thinking and the tool versions behind the beta flag are refused or
 * ignored upstream.
 *
 * The list is an allow-list rather than a block-list on purpose. Blindly
 * replaying client headers would leak the caller's `authorization` to the
 * provider and forward hop-by-hop headers that Node manages itself.
 *
 * Anthropic-only: an OpenAI-compatible endpoint has no `anthropic-version`
 * contract, and several providers reject requests carrying unknown headers.
 */
const ANTHROPIC_PASSTHROUGH_HEADERS = ['anthropic-version', 'anthropic-beta'] as const;

/**
 * Pick the client headers worth forwarding for this upstream.
 *
 * Returns an empty object whenever nothing applies, so callers can spread the
 * result without a conditional.
 */
export function clientPassthroughHeaders(
  clientHeaders: Record<string, unknown> | undefined,
  upstreamFormat: RelayFormat,
): Record<string, string> {
  if (upstreamFormat !== RelayFormat.Claude) return {};

  const forwarded: Record<string, string> = {};
  for (const name of ANTHROPIC_PASSTHROUGH_HEADERS) {
    const value = clientHeaders?.[name.toLowerCase()];
    if (typeof value === 'string' && value.trim() !== '') forwarded[name] = value;
  }
  return forwarded;
}

/**
 * Outbound HTTP + SSE reading.
 *
 * Details that are easy to get wrong and are handled here:
 *   - SSE frames are separated by a blank line and may use CRLF.
 *   - A provider may stream a 200 and still deliver an error event mid-stream;
 *     those surface as `error` events and are converted, not swallowed.
 *   - A non-2xx response body may be JSON *or* plain text; both are preserved
 *     so the dashboard shows the provider's own message.
 */

export interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function callUpstream(call: UpstreamCall): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), call.timeoutMs);

  const onAbort = () => controller.abort();
  if (call.signal) {
    if (call.signal.aborted) controller.abort();
    else call.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: JSON.stringify(call.body),
      signal: controller.signal,
      // Never follow a redirect with a Bearer token: credentials would be
      // replayed to an unrelated host.
      redirect: 'manual',
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const abortedByClient = call.signal?.aborted === true;
      throw new GatewayError(
        abortedByClient ? 'Client closed the connection' : `Upstream timed out after ${call.timeoutMs}ms`,
        { statusCode: abortedByClient ? 499 : 504, code: 'upstream_error' },
      );
    }
    throw new GatewayError(
      `Failed to reach upstream: ${error instanceof Error ? error.message : String(error)}`,
      { statusCode: 502, code: 'upstream_error', cause: error },
    );
  } finally {
    clearTimeout(timer);
    if (call.signal) call.signal.removeEventListener('abort', onAbort);
  }
}

/** Reads `data:` payloads from an SSE body. Yields one string per frame. */
export async function* readSSE(
  body: ReadableStream<Uint8Array>,
  maxBufferBytes: number,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = extractData(frame);
        if (payload !== null) yield payload;
        boundary = buffer.indexOf('\n\n');
      }

      // Guard against an upstream that never emits a blank line.
      if (buffer.length > maxBufferBytes) {
        throw new GatewayError('Upstream SSE line exceeded the maximum buffer size', {
          statusCode: 502,
          code: 'upstream_error',
        });
      }
    }

    const trailing = extractData(buffer);
    if (trailing !== null) yield trailing;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or errored; nothing to do.
    }
  }
}

function extractData(frame: string): string | null {
  if (frame.trim() === '') return null;
  const lines = frame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/** Best-effort extraction of an error message from an upstream error body. */
export async function readUpstreamError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (text === '') return `Upstream returned HTTP ${response.status}`;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const error = parsed['error'];
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    const message = parsed['message'];
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }

  return text.slice(0, 500);
}

export async function upstreamError(response: Response): Promise<GatewayError> {
  const message = await readUpstreamError(response);
  // 413 must not be retried on another channel: the body is too big there too.
  if (response.status === 413) {
    return GatewayError.tooLarge(message);
  }
  return GatewayError.upstream(message, response.status === 429 ? 429 : 502);
}
