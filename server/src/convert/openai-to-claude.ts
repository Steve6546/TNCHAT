import { reasonToOpenAI } from '../core/formats.js';
import type { Usage } from '../core/formats.js';
import type {
  ClaudeContentBlock,
  ClaudeMediaMessage,
  ClaudeMessage,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeStreamEvent,
  ClaudeTool,
} from './dto/claude.js';
import type {
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIToolCall,
} from './dto/openai.js';

/**
 * OpenAI Chat Completions -> Claude Messages.
 *
 * The single most important rule here: **Claude requires `max_tokens`**.
 * new-api handles this with `GetClaudeSettings().GetDefaultMaxTokens()` and so
 * do we. An OpenAI client that omits it (or sends only `max_completion_tokens`)
 * would otherwise get a hard 400 from the upstream for no good reason.
 */

export const DEFAULT_CLAUDE_MAX_TOKENS = 4096;

function parseDataUrl(
  url: string,
): { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match) {
    return { type: 'base64', media_type: match[1] ?? 'image/png', data: match[2] ?? '' };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'url', url };
  }
  return null;
}

function openAIContentToClaude(
  content: string | { type: string; text?: string; image_url?: { url?: string } }[] | null | undefined,
): string | ClaudeContentBlock[] {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  const blocks: ClaudeContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const source = parseDataUrl(part.image_url.url);
      if (source) blocks.push({ type: 'image', source } as ClaudeContentBlock);
    }
  }
  return blocks.length > 0 ? blocks : '';
}

export function convertOpenAIRequestToClaude(request: OpenAIRequest): ClaudeRequest {
  const systemParts: string[] = [];
  const messages: ClaudeMessage[] = [];

  /** Pending tool results, merged into one user message (Claude's shape). */
  let pendingToolResults: ClaudeContentBlock[] = [];

  function flushToolResults(): void {
    if (pendingToolResults.length > 0) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  }

  for (const message of request.messages ?? []) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : extractText(message.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (message.role === 'tool') {
      const text = typeof message.content === 'string' ? message.content : extractText(message.content);
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: text,
      });
      continue;
    }

    // A tool result must be followed by a user turn, so any pending results
    // flush before the next user/assistant message.
    flushToolResults();

    if (message.role === 'assistant') {
      const blocks: ClaudeContentBlock[] = [];
      const text = typeof message.content === 'string' ? message.content : extractText(message.content);
      if (text) blocks.push({ type: 'text', text });

      for (const toolCall of message.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: toolCall.id ?? '',
          name: toolCall.function?.name ?? '',
          input,
        });
      }

      messages.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : '',
      });
      continue;
    }

    // role === 'user' (and anything unexpected, treated as user input)
    messages.push({
      role: 'user',
      content: openAIContentToClaude(
        message.content as string | { type: string; text?: string; image_url?: { url?: string } }[],
      ),
    });
  }

  flushToolResults();

  const claude: ClaudeRequest = {
    model: request.model,
    messages,
  };

  if (systemParts.length > 0) {
    claude.system = systemParts.length === 1 ? systemParts[0]! : (systemParts.map((text) => ({ type: 'text' as const, text })) as ClaudeMediaMessage[]);
  }

  const maxTokens =
    request.max_tokens ?? request.max_completion_tokens ?? DEFAULT_CLAUDE_MAX_TOKENS;
  claude.max_tokens = maxTokens > 0 ? maxTokens : DEFAULT_CLAUDE_MAX_TOKENS;

  if (request.temperature !== null && request.temperature !== undefined) {
    claude.temperature = request.temperature;
  }
  if (request.top_p !== null && request.top_p !== undefined) claude.top_p = request.top_p;
  if (request.stream) claude.stream = true;

  if (request.stop) {
    claude.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }

  if (request.tools?.length) {
    claude.tools = request.tools.map<ClaudeTool>((tool) => ({
      name: tool.function.name,
      ...(tool.function.description !== undefined
        ? { description: tool.function.description }
        : {}),
      input_schema: (tool.function.parameters ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    }));

    if (request.tool_choice !== undefined && request.tool_choice !== null) {
      claude.tool_choice =
        request.tool_choice === 'auto'
          ? { type: 'auto' }
          : request.tool_choice === 'required'
            ? { type: 'any' }
            : request.tool_choice === 'none'
              ? { type: 'auto' }
              : { type: 'tool', name: request.tool_choice.function.name };
    }
  }

  if (request.user) claude.metadata = { user_id: request.user };

  return claude;
}

function extractText(
  content: string | { type: string; text?: string }[] | null | undefined,
): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}

/* ---------------- Response: Claude -> OpenAI ---------------- */

export function usageFromClaude(usage: ClaudeResponse['usage']): Usage {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  const cached = usage?.cache_read_input_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    totalTokens: prompt + completion,
  };
}

export function convertClaudeResponseToOpenAI(
  response: ClaudeResponse,
  fallbackModel: string,
): OpenAIResponse {
  const content = response.content ?? [];

  let text = '';
  const toolCalls: OpenAIToolCall[] = [];

  for (const block of content) {
    if (block.type === 'text') {
      text += block.text ?? '';
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
    // thinking blocks have no OpenAI response field; dropped (documented gap)
  }

  const finishReason = content.some((block) => block.type === 'tool_use')
    ? 'tool_calls'
    : reasonToOpenAI(response.stop_reason);

  const usage = usageFromClaude(response.usage);

  return {
    id: response.id ?? '',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model || fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: {
        cached_tokens: usage.cachedTokens,
        cache_write_tokens: usage.cacheWriteTokens,
      },
    },
  };
}

/* ---------------- Streaming: Claude events -> OpenAI chunks ---------------- */

/**
 * Emits OpenAI chunks from an Anthropic event stream.
 *
 * Anthropic sends `usage` on `message_delta`, and OpenAI clients read it from
 * the final chunk. Accumulating it and emitting it at the end is what makes
 * token accounting work for streaming calls — verified against the live GMI
 * endpoint, where usage arrives only on the second-to-last event.
 */
export class ClaudeToOpenAIStream {
  private started = false;
  private toolIndex = -1;
  private currentBlockIsTool = false;
  private stopReason: string | null = null;
  private usage: Usage | null = null;
  private id: string;
  private readonly model: string;

  constructor(id: string, model: string) {
    this.id = id;
    this.model = model;
  }

  push(event: ClaudeStreamEvent): OpenAIStreamChunk[] {
    const chunks: OpenAIStreamChunk[] = [];
    const base = () => ({
      id: this.id,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: this.model,
    });

    if (!this.started) {
      this.started = true;
      chunks.push({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }

    switch (event.type) {
      case 'message_start': {
        if (event.message?.id) this.id = event.message.id as string;
        break;
      }

      case 'content_block_start': {
        if (event.content_block?.type === 'tool_use') {
          this.currentBlockIsTool = true;
          this.toolIndex += 1;
          chunks.push({
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: this.toolIndex,
                      id: (event.content_block as { id?: string }).id ?? '',
                      type: 'function',
                      function: {
                        name: (event.content_block as { name?: string }).name ?? '',
                        arguments: '',
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        } else {
          this.currentBlockIsTool = false;
        }
        break;
      }

      case 'content_block_delta': {
        const delta = event.delta as { type?: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          chunks.push({
            ...base(),
            choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }],
          });
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          chunks.push({
            ...base(),
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: Math.max(this.toolIndex, 0),
                      function: { arguments: delta.partial_json },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        }
        break;
      }

      case 'content_block_stop': {
        this.currentBlockIsTool = false;
        break;
      }

      case 'message_delta': {
        if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason;
        if (event.usage) {
          const cached = event.usage.cache_read_input_tokens ?? 0;
          const prompt = event.usage.input_tokens ?? 0;
          const completion = event.usage.output_tokens ?? 0;
          this.usage = {
            promptTokens: prompt,
            completionTokens: completion,
            cachedTokens: cached,
            cacheWriteTokens: event.usage.cache_creation_input_tokens ?? 0,
            totalTokens: prompt + completion,
          };
        }
        break;
      }

      case 'message_stop':
      case 'ping':
      case 'error':
        break;
    }

    return chunks;
  }

  /**
   * Terminal chunks. Must be emitted after the upstream stream ends:
   * a finish_reason chunk, then a usage-only chunk (OpenAI's convention),
   * then the caller appends `data: [DONE]`.
   */
  finalize(): OpenAIStreamChunk[] {
    const chunks: OpenAIStreamChunk[] = [];
    const base = {
      id: this.id,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: this.model,
    };

    chunks.push({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: reasonToOpenAI(this.stopReason ?? 'end_turn') }],
    });

    if (this.usage) {
      chunks.push({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: this.usage.promptTokens,
          completion_tokens: this.usage.completionTokens,
          total_tokens: this.usage.totalTokens,
          prompt_tokens_details: {
            cached_tokens: this.usage.cachedTokens,
            cache_write_tokens: this.usage.cacheWriteTokens,
          },
        },
      });
    }

    return chunks;
  }

  getUsage(): Usage | null {
    return this.usage;
  }
}
