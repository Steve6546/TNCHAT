import { eq } from 'drizzle-orm';

import { getAdaptor } from '../adapters/index.js';
import type { Adaptor, ChannelType } from '../adapters/types.js';
import { config } from '../config.js';
import { OpenAIToClaudeStream } from '../convert/claude-to-openai.js';
import type { ClaudeRequest, ClaudeResponse, ClaudeStreamEvent } from '../convert/dto/claude.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from '../convert/dto/openai.js';
import {
  ClaudeToOpenAIStream,
  convertClaudeResponseToOpenAI,
  convertOpenAIRequestToClaude,
  usageFromClaude,
} from '../convert/openai-to-claude.js';
import { convertClaudeRequestToOpenAI, convertOpenAIResponseToClaude, usageFromOpenAI } from '../convert/claude-to-openai.js';
import { db } from '../db/index.js';
import { channels, requestLogs } from '../db/schema.js';
import { GatewayError, toGatewayError } from '../core/errors.js';
import { RelayFormat, emptyUsage } from '../core/formats.js';
import type { Usage } from '../core/formats.js';
import { parseStringList, parseStringRecord } from '../lib/json.js';
import { decryptKeyList } from '../lib/secrets.js';
import { selectChannel, getPreferredChannel, recordChannelAffinity, clearChannelAffinity } from './distributor.js';
import { parseModelMapping, resolveModelMapping } from './model-mapping.js';
import { clientPassthroughHeaders, readSSE, callUpstream, upstreamError } from './upstream.js';
import type { AuthContext } from './token-auth.js';

/**
 * Relay orchestration, ported from `controller/relay.go`.
 *
 * Order of operations, which matters:
 *   1. select a channel using the *client's* model name (abilities are keyed on
 *      what clients ask for, not what providers call it);
 *   2. only then apply that channel's model mapping
 *      (new-api does the same: Distribute runs before ModelMappedHelper);
 *   3. convert to the channel's wire format;
 *   4. retry steps 1-3 with a lower priority tier on failure.
 */

export interface RelaySink {
  sendJson(statusCode: number, body: unknown): void | Promise<void>;
  beginStream(statusCode: number, headers: Record<string, string>): void;
  writeSSE(data: string, event?: string): void;
  endStream(): void;
}

export interface RelayRequest {
  clientFormat: RelayFormat;
  model: string;
  payload: OpenAIRequest | ClaudeRequest;
  isStream: boolean;
  auth: AuthContext;
  sink: RelaySink;
  signal?: AbortSignal;
  /** Raw inbound headers, so beta opt-ins can be replayed upstream. */
  clientHeaders?: Record<string, unknown>;
}

interface ChannelRecord {
  id: number;
  name: string;
  type: ChannelType;
  baseUrl: string;
  keys: string[];
  models: string[];
  modelMapping: string;
  group: string;
  priority: number;
  weight: number;
  enabled: boolean;
  status: string;
  /** Only meaningful for `custom`; ignored by every other adaptor. */
  authStyle: string;
  /** Only meaningful for `custom`; merged on top of the adaptor's headers. */
  extraHeaders: Record<string, string>;
}

/** Round-robin cursor per channel, mirroring MultiKeyPollingIndex. */
const keyCursor = new Map<number, number>();

async function loadChannel(id: number): Promise<ChannelRecord | null> {
  const rows = await db.select().from(channels).where(eq(channels.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    baseUrl: row.baseUrl,
    keys: decryptKeyList(row.keys),
    models: parseStringList(row.models),
    modelMapping: row.modelMapping,
    group: row.group,
    priority: row.priority,
    weight: row.weight,
    enabled: row.enabled,
    status: row.status,
    authStyle: row.authStyle,
    extraHeaders: parseStringRecord(row.extraHeaders),
  };
}

function nextKey(channel: ChannelRecord): string {
  if (channel.keys.length === 0) {
    throw new GatewayError(`Channel "${channel.name}" has no usable API key configured`, {
      statusCode: 500,
      code: 'channel_error',
    });
  }
  if (channel.keys.length === 1) return channel.keys[0]!;

  const cursor = (keyCursor.get(channel.id) ?? 0) + 1;
  keyCursor.set(channel.id, cursor);
  return channel.keys[cursor % channel.keys.length]!;
}

function toUpstreamPayload(
  clientFormat: RelayFormat,
  upstreamFormat: RelayFormat,
  payload: OpenAIRequest | ClaudeRequest,
  upstreamModel: string,
): OpenAIRequest | ClaudeRequest {
  if (clientFormat === upstreamFormat) {
    return { ...(payload as object), model: upstreamModel } as OpenAIRequest | ClaudeRequest;
  }
  if (clientFormat === RelayFormat.Claude && upstreamFormat === RelayFormat.OpenAI) {
    const converted = convertClaudeRequestToOpenAI(payload as ClaudeRequest);
    converted.model = upstreamModel;
    return converted;
  }
  const converted = convertOpenAIRequestToClaude(payload as OpenAIRequest);
  converted.model = upstreamModel;
  return converted;
}

function usageOfUpstreamResponse(
  upstreamFormat: RelayFormat,
  body: OpenAIResponse | ClaudeResponse,
): Usage {
  return upstreamFormat === RelayFormat.OpenAI
    ? usageFromOpenAI((body as OpenAIResponse).usage)
    : usageFromClaude((body as ClaudeResponse).usage);
}

export interface RelayOutcome {
  ok: boolean;
  channelId: number | null;
  channelName: string;
  upstreamModel: string;
  upstreamFormat: RelayFormat | '';
  usage: Usage;
  statusCode: number;
  error?: GatewayError;
  latencyMs: number;
}

export async function relay(request: RelayRequest): Promise<RelayOutcome> {
  const startedAt = Date.now();
  const { clientFormat, model, auth, sink, signal } = request;

  const attempts = Math.max(1, config.retryTimes);
  let lastError: GatewayError | null = null;
  let attemptedChannel: ChannelRecord | null = null;

  for (let retryIndex = 0; retryIndex < attempts; retryIndex += 1) {
    if (signal?.aborted) {
      lastError = new GatewayError('Client closed the connection', { statusCode: 499, code: 'api_error' });
      break;
    }

    const preferred = getPreferredChannel(String(auth.keyId), auth.group, model);
    const selection = selectChannel(auth.group, model, retryIndex, retryIndex === 0 ? preferred : null);

    if (!selection) {
      lastError = GatewayError.noChannel(model);
      break;
    }

    const channel = await loadChannel(selection.ability.channelId);
    if (!channel || !channel.enabled) {
      lastError = GatewayError.noChannel(model);
      continue;
    }
    attemptedChannel = channel;

    const adaptor: Adaptor = getAdaptor(channel.type);
    const mapping = parseModelMapping(channel.modelMapping);
    let upstreamModel = model;

    try {
      const mapped = resolveModelMapping(model, mapping);
      upstreamModel = mapped.upstreamModel;
      if (adaptor.normalizeUpstreamModel) {
        upstreamModel = adaptor.normalizeUpstreamModel(upstreamModel);
      }
    } catch (error) {
      lastError = toGatewayError(error);
      break;
    }

    const upstreamPayload = toUpstreamPayload(
      clientFormat,
      adaptor.upstreamFormat,
      request.payload,
      upstreamModel,
    );

    if (request.isStream) {
      (upstreamPayload as { stream?: boolean; stream_options?: unknown }).stream = true;
    }

    try {
      const outcome = await attemptStreamingOrJson({
        channel,
        adaptor,
        upstreamPayload,
        upstreamModel,
        request,
        signal,
        startedAt,
      });

      if (outcome.ok) {
        recordChannelAffinity(String(auth.keyId), auth.group, model, channel.id);
        void markChannelHealthy(channel.id, Date.now() - startedAt);
      }
      return outcome;
    } catch (error) {
      const gatewayError = toGatewayError(error);
      lastError = gatewayError;
      void markChannelFailing(channel.id, gatewayError.message);

      if (gatewayError.skipRetry || retryIndex === attempts - 1) break;
    }
  }

  const finalError = lastError ?? GatewayError.noChannel(model);

  if (request.isStream) {
    sink.beginStream(finalError.statusCode, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const body =
      clientFormat === RelayFormat.Claude
        ? finalError.toClaude()
        : { ...finalError.toOpenAI(), id: '', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [] };
    sink.writeSSE(JSON.stringify(body));
    if (clientFormat === RelayFormat.OpenAI) sink.writeSSE('[DONE]');
    sink.endStream();
  } else {
    await sink.sendJson(
      finalError.statusCode,
      clientFormat === RelayFormat.Claude ? finalError.toClaude() : finalError.toOpenAI(),
    );
  }

  void logRequest({
    auth,
    model,
    upstreamModel: model,
    clientFormat,
    upstreamFormat: '',
    channel: attemptedChannel,
    usage: emptyUsage(),
    statusCode: finalError.statusCode,
    ok: false,
    latencyMs: Date.now() - startedAt,
    isStream: request.isStream,
    errorMessage: finalError.message,
  });

  return {
    ok: false,
    channelId: attemptedChannel?.id ?? null,
    channelName: attemptedChannel?.name ?? '',
    upstreamModel: model,
    upstreamFormat: '',
    usage: emptyUsage(),
    statusCode: finalError.statusCode,
    error: finalError,
    latencyMs: Date.now() - startedAt,
  };
}

interface AttemptArgs {
  channel: ChannelRecord;
  adaptor: Adaptor;
  upstreamPayload: OpenAIRequest | ClaudeRequest;
  upstreamModel: string;
  request: RelayRequest;
  signal?: AbortSignal;
  startedAt: number;
}

async function attemptStreamingOrJson(args: AttemptArgs): Promise<RelayOutcome> {
  const { channel, adaptor, upstreamPayload, upstreamModel, request, signal, startedAt } = args;

  const apiKey = nextKey(channel);
  const url = adaptor.buildUrl(channel.baseUrl);
  const headers = {
    ...adaptor.buildHeaders(apiKey, {
      authStyle: (channel.authStyle ?? 'bearer') as 'bearer' | 'x-api-key' | 'none',
      extraHeaders: channel.extraHeaders,
    }),
    // Client opt-ins win over the adaptor's defaults: a client that asks for
    // a newer `anthropic-version` knows more about what it needs than we do.
    ...clientPassthroughHeaders(request.clientHeaders, adaptor.upstreamFormat),
  };

  const timeoutMs = request.isStream ? config.streamingTimeoutMs : config.requestTimeoutMs;
  const response = await callUpstream({ url, headers, body: upstreamPayload, timeoutMs, signal });

  if (!response.ok) {
    throw await upstreamError(response);
  }

  const isEventStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  const useStream = request.isStream || isEventStream;

  if (!useStream) {
    const body = (await response.json().catch(() => null)) as
      | (OpenAIResponse | ClaudeResponse)
      | null;

    if (!body) {
      throw new GatewayError('Upstream returned a malformed JSON body', {
        statusCode: 502,
        code: 'upstream_error',
      });
    }

    const usage = usageOfUpstreamResponse(adaptor.upstreamFormat, body);
    const clientBody =
      request.clientFormat === adaptor.upstreamFormat
        ? body
        : adaptor.upstreamFormat === RelayFormat.OpenAI
          ? convertOpenAIResponseToClaude(body as OpenAIResponse)
          : convertClaudeResponseToOpenAI(body as ClaudeResponse, request.model);

    await request.sink.sendJson(200, clientBody);

    const outcome: RelayOutcome = {
      ok: true,
      channelId: channel.id,
      channelName: channel.name,
      upstreamModel,
      upstreamFormat: adaptor.upstreamFormat,
      usage,
      statusCode: 200,
      latencyMs: Date.now() - startedAt,
    };

    void logRequest({
      auth: request.auth,
      model: request.model,
      upstreamModel,
      clientFormat: request.clientFormat,
      upstreamFormat: adaptor.upstreamFormat,
      channel,
      usage,
      statusCode: 200,
      ok: true,
      latencyMs: outcome.latencyMs,
      isStream: false,
    });

    return outcome;
  }

  if (!response.body) {
    throw new GatewayError('Upstream returned an empty stream body', {
      statusCode: 502,
      code: 'upstream_error',
    });
  }

  return streamToClient({
    channel,
    adaptor,
    upstreamModel,
    request,
    body: response.body,
    startedAt,
  });
}

async function streamToClient(args: {
  channel: ChannelRecord;
  adaptor: Adaptor;
  upstreamModel: string;
  request: RelayRequest;
  body: ReadableStream<Uint8Array>;
  startedAt: number;
}): Promise<RelayOutcome> {
  const { channel, adaptor, upstreamModel, request, body, startedAt } = args;
  const { sink, clientFormat } = request;

  sink.beginStream(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // Disables proxy buffering, which otherwise defeats streaming entirely.
    'x-accel-buffering': 'no',
  });

  const maxBufferBytes = config.streamScannerMaxBufferMb * 1024 * 1024;

  /** Conversion is only needed when the two ends speak different formats. */
  const needsConversion = clientFormat !== adaptor.upstreamFormat;

  const toOpenAI =
    adaptor.upstreamFormat === RelayFormat.Claude ? new ClaudeToOpenAIStream('', upstreamModel) : null;
  const toClaude =
    adaptor.upstreamFormat === RelayFormat.OpenAI ? new OpenAIToClaudeStream('', upstreamModel) : null;

  const emitOpenAI = (chunk: OpenAIStreamChunk): void => {
    sink.writeSSE(JSON.stringify(chunk));
  };

  const emitClaude = (event: ClaudeStreamEvent, id: string): void => {
    sink.writeSSE(JSON.stringify(event.type === 'message_start' ? { ...event, message: { ...event.message, id } } : event));
  };

  let streamId = '';

  try {
    for await (const frame of readSSE(body, maxBufferBytes)) {
      if (frame === '[DONE]') break;
      if (frame.trim() === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(frame);
      } catch {
        // A frame we cannot parse is not worth failing the whole stream over.
        continue;
      }

      if (adaptor.upstreamFormat === RelayFormat.OpenAI) {
        const chunk = parsed as OpenAIStreamChunk;
        streamId ||= chunk.id ?? '';

        if (!needsConversion || !toClaude) {
          emitOpenAI(chunk);
          continue;
        }
        for (const event of toClaude.push(chunk)) {
          emitClaude(event, streamId);
        }
      } else {
        const event = parsed as ClaudeStreamEvent;
        if (event.type === 'message_start') {
          streamId ||= event.message?.id ?? '';
        }

        if (!needsConversion || !toOpenAI) {
          emitClaude(event, streamId);
          continue;
        }
        for (const chunk of toOpenAI.push(event)) {
          emitOpenAI(chunk);
        }
      }
    }
  } finally {
    // finalize() is mandatory: Anthropic's terminal events and the OpenAI usage
    // chunk are produced here. Skipping it loses token accounting.
    if (toClaude) {
      for (const event of toClaude.finalize()) emitClaude(event, streamId);
    } else if (toOpenAI) {
      for (const chunk of toOpenAI.finalize()) emitOpenAI(chunk);
    }

    if (clientFormat === RelayFormat.OpenAI) sink.writeSSE('[DONE]');
    sink.endStream();
  }

  const usage = toOpenAI?.getUsage() ?? toClaude?.getUsageFromEvents() ?? emptyUsage();

  const outcome: RelayOutcome = {
    ok: true,
    channelId: channel.id,
    channelName: channel.name,
    upstreamModel,
    upstreamFormat: adaptor.upstreamFormat,
    usage,
    statusCode: 200,
    latencyMs: Date.now() - startedAt,
  };

  void logRequest({
    auth: request.auth,
    model: request.model,
    upstreamModel,
    clientFormat: request.clientFormat,
    upstreamFormat: adaptor.upstreamFormat,
    channel,
    usage,
    statusCode: 200,
    ok: true,
    latencyMs: outcome.latencyMs,
    isStream: true,
  });

  return outcome;
}

async function markChannelHealthy(channelId: number, latencyMs: number): Promise<void> {
  try {
    await db
      .update(channels)
      .set({ status: 'healthy', lastLatencyMs: latencyMs, lastTestedAt: Date.now(), lastError: null, updatedAt: Date.now() })
      .where(eq(channels.id, channelId));
  } catch (error) {
    console.error('[relay] failed to record channel health:', error);
  }
}

async function markChannelFailing(channelId: number, message: string): Promise<void> {
  try {
    await db
      .update(channels)
      .set({ status: 'failing', lastError: message.slice(0, 500), lastTestedAt: Date.now(), updatedAt: Date.now() })
      .where(eq(channels.id, channelId));
  } catch (error) {
    console.error('[relay] failed to record channel failure:', error);
  }
  clearChannelAffinity(channelId);
}

interface LogArgs {
  auth: AuthContext;
  model: string;
  upstreamModel: string;
  clientFormat: string;
  upstreamFormat: string;
  channel: ChannelRecord | null;
  usage: Usage;
  statusCode: number;
  ok: boolean;
  latencyMs: number;
  isStream: boolean;
  errorMessage?: string;
}

/** Fire-and-forget: analytics must never break a relay in flight. */
async function logRequest(args: LogArgs): Promise<void> {
  try {
    await db.insert(requestLogs)
      .values({
        keyId: args.auth.keyId,
        keyName: args.auth.keyName,
        channelId: args.channel?.id ?? null,
        channelName: args.channel?.name ?? '',
        model: args.model,
        upstreamModel: args.upstreamModel,
        clientFormat: args.clientFormat,
        upstreamFormat: args.upstreamFormat,
        promptTokens: args.usage.promptTokens,
        completionTokens: args.usage.completionTokens,
        cachedTokens: args.usage.cachedTokens,
        totalTokens: args.usage.totalTokens,
        statusCode: args.statusCode,
        ok: args.ok,
        latencyMs: args.latencyMs,
        isStream: args.isStream,
        errorMessage: args.errorMessage?.slice(0, 500) ?? null,
      });
  } catch (error) {
    console.error('[relay] failed to write request log:', error);
  }
}
