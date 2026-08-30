import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { RelayFormat } from '../core/formats.js';
import { GatewayError, toGatewayError } from '../core/errors.js';
import { abilityIndex } from '../gateway/ability-index.js';
import { relay } from '../gateway/relay.js';
import type { RelaySink } from '../gateway/relay.js';
import { assertModelAllowed, authenticate, extractApiKey } from '../gateway/token-auth.js';
import type { ClaudeRequest } from '../convert/dto/claude.js';
import type { OpenAIRequest } from '../convert/dto/openai.js';

/**
 * Relay routes.
 *
 * Streaming uses `reply.hijack()` and writes straight to the raw socket.
 * Buffering the whole upstream response before replying would defeat the point
 * of SSE and make the first token feel as slow as the last one.
 */

function makeSink(reply: FastifyReply): RelaySink {
  return {
    sendJson(statusCode, body) {
      // Not returned: the sink contract is fire-and-forget, and awaiting here
      // would keep the retry loop from moving on after a failure.
      void Promise.resolve(reply.code(statusCode).send(body)).catch(() => undefined);
    },
    beginStream(statusCode, headers) {
      reply.hijack();
      reply.raw.writeHead(statusCode, headers);
    },
    writeSSE(data: string, event?: string) {
      if (reply.raw.writableEnded) return;
      if (event) reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${data}\n\n`);
    },
    endStream() {
      if (!reply.raw.writableEnded) reply.raw.end();
    },
  };
}

interface RelayBody {
  model?: unknown;
  stream?: unknown;
}

function requireModel(body: RelayBody | null): string {
  const model = body?.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw GatewayError.badRequest('`model` is required', 'model');
  }
  return model;
}

function isStreaming(body: RelayBody | null): boolean {
  return body?.stream === true;
}

async function handleRelay(
  request: FastifyRequest,
  reply: FastifyReply,
  clientFormat: RelayFormat,
): Promise<void> {
  const body = (request.body ?? null) as RelayBody | null;

  try {
    const rawKey = extractApiKey(
      request.headers as Record<string, unknown>,
      (request.query ?? {}) as Record<string, unknown>,
    );
    const auth = authenticate(rawKey);

    const model = requireModel(body);
    assertModelAllowed(auth, model);

    const sink = makeSink(reply);
    const abort = new AbortController();
    reply.raw.on('close', () => abort.abort());

    await relay({
      clientFormat,
      model,
      payload: body as unknown as OpenAIRequest | ClaudeRequest,
      isStream: isStreaming(body),
      auth,
      sink,
      signal: abort.signal,
      clientHeaders: request.headers as Record<string, unknown>,
    });
  } catch (error) {
    if (reply.raw.writableEnded || reply.sent) return;
    const gatewayError = toGatewayError(error);
    await reply
      .code(gatewayError.statusCode)
      .send(clientFormat === RelayFormat.Claude ? gatewayError.toClaude() : gatewayError.toOpenAI());
  }
}

export async function registerRelayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/messages', async (request, reply) => {
    await handleRelay(request, reply, RelayFormat.Claude);
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    await handleRelay(request, reply, RelayFormat.OpenAI);
  });

  app.post('/v1/completions', async (request, reply) => {
    await handleRelay(request, reply, RelayFormat.OpenAI);
  });

  /**
   * Model list is derived from the routing index, so it always reflects what
   * this key can actually reach right now.
   */
  app.get('/v1/models', async (request, reply) => {
    try {
      const rawKey = extractApiKey(
        request.headers as Record<string, unknown>,
        (request.query ?? {}) as Record<string, unknown>,
      );
      const auth = authenticate(rawKey);

      const models = abilityIndex.modelsForGroup(auth.group);
      const allowed =
        auth.modelLimit.length > 0
          ? models.filter((model) => auth.modelLimit.includes(model))
          : models;

      const created = Math.floor(Date.now() / 1000);
      const isAnthropic = typeof request.headers['x-api-key'] === 'string';

      if (isAnthropic) {
        return reply.send({
          object: 'list',
          data: allowed.map((id) => ({
            id,
            object: 'model',
            created,
            display_name: id,
            type: 'model',
          })),
        });
      }

      return reply.send({
        object: 'list',
        data: allowed.map((id) => ({ id, object: 'model', created, owned_by: 'ai-command-center' })),
      });
    } catch (error) {
      const gatewayError = toGatewayError(error);
      return reply.code(gatewayError.statusCode).send(gatewayError.toOpenAI());
    }
  });
}
