import { reasonToClaude } from '../core/formats.js';
import type { Usage } from '../core/formats.js';
import type {
  ClaudeContentBlock,
  ClaudeMediaMessage,
  ClaudeRequest,
  ClaudeResponse,
  ClaudeStreamEvent,
  ClaudeUsage,
} from './dto/claude.js';
import type {
  OpenAIChoice,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChoice,
  OpenAIStreamChunk,
  OpenAIToolCall,
} from './dto/openai.js';

/**
 * Claude Messages -> OpenAI Chat Completions.
 *
 * Fidelity notes (these are the "Fair" gaps in new-api's own matrix, stated
 * explicitly rather than hidden):
 *   - `top_k` has no OpenAI equivalent and is dropped.
 *   - Extended `thinking` blocks have no OpenAI request equivalent. They are
 *     dropped on request; on response they are surfaced as reasoning content
 *     where the upstream emits them.
 *   - Claude `tool_result` blocks become separate `role: "tool"` messages, so a
 *     single Claude message can expand into several OpenAI messages.
 */

function claudeSystemToText(system: string | ClaudeMediaMessage[] | undefined): string | null {
  if (!system) return null;
  if (typeof system === 'string') return system;
  const parts = system
    .filter((block): block is ClaudeMediaMessage & { text: string } => block.type === 'text')
    .map((block) => block.text ?? '');
  const joined = parts.join('\n').trim();
  return joined === '' ? null : joined;
}

function imageSourceToDataUrl(
  source: { type: string; media_type?: string; data?: string; url?: string },
): string | null {
  if (source.type === 'base64' && source.data) {
    const mediaType = source.media_type ?? 'image/png';
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return source.url;
  return null;
}

function textOfTextBlock(block: ClaudeContentBlock): string | null {
  return block.type === 'text' ? (block.text ?? '') : null;
}

interface OpenAIMessageLike {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export function convertClaudeRequestToOpenAI(request: ClaudeRequest): OpenAIRequest {
  const messages: OpenAIMessageLike[] = [];

  const systemText = claudeSystemToText(request.system);
  if (systemText !== null) {
    messages.push({ role: 'system', content: systemText });
  }

  for (const message of request.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content ?? [];

    if (message.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          const text = textOfTextBlock(block);
          if (text) textParts.push(text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
        // thinking / redacted_thinking intentionally skipped (see file header)
      }

      messages.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('') : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // role === 'user'
    const textParts: string[] = [];
    const imageParts: { type: 'image_url'; image_url: { url: string } }[] = [];
    const toolResults: { tool_use_id: string; content: string; is_error?: boolean }[] = [];

    for (const block of blocks) {
      if (block.type === 'text') {
        const text = textOfTextBlock(block);
        if (text) textParts.push(text);
      } else if (block.type === 'image') {
        const url = imageSourceToDataUrl(block.source);
        if (url) imageParts.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_result') {
        const content =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .map((inner) => textOfTextBlock(inner) ?? '')
                  .join('')
              : '';
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content,
          ...(block.is_error ? { is_error: true } : {}),
        });
      }
    }

    if (textParts.length > 0 || imageParts.length > 0) {
      const content =
        imageParts.length > 0
          ? ([{ type: 'text', text: textParts.join('') }, ...imageParts] as OpenAIRequest['messages'][number]['content'] as never)
          : textParts.join('');
      messages.push({ role: 'user', content });
    }

    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: result.is_error ? `[tool error] ${result.content}` : result.content,
      });
    }
  }

  const openai: OpenAIRequest = {
    model: request.model,
    messages: messages as OpenAIRequest['messages'],
  };

  if (request.max_tokens !== undefined) openai.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) openai.temperature = request.temperature;
  if (request.top_p !== undefined) openai.top_p = request.top_p;
  if (request.stop_sequences?.length) openai.stop = request.stop_sequences;
  if (request.stream !== undefined) openai.stream = request.stream;
  if (request.metadata?.user_id) openai.user = request.metadata.user_id;

  if (request.tools?.length) {
    openai.tools = request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: (tool.input_schema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      },
    }));
  }

  if (request.tool_choice) {
    openai.tool_choice =
      request.tool_choice.type === 'auto'
        ? 'auto'
        : request.tool_choice.type === 'any'
          ? 'required'
          : request.tool_choice.type === 'tool' && request.tool_choice.name
            ? { type: 'function' as const, function: { name: request.tool_choice.name } }
            : 'auto';
  }

  return openai;
}

/* ---------------- Response: OpenAI -> Claude ---------------- */

export function claudeUsageFromOpenAI(usage: OpenAIResponse['usage']): ClaudeUsage {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    cache_read_input_tokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

export function usageFromOpenAI(usage: OpenAIResponse['usage']): Usage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    cachedTokens: cached,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
    totalTokens: usage?.total_tokens ?? prompt + completion,
  };
}

export function convertOpenAIResponseToClaude(response: OpenAIResponse): ClaudeResponse {
  const choice: OpenAIChoice | undefined = response.choices?.[0];
  const message = choice?.message;

  const content: ClaudeContentBlock[] = [];

  if (typeof message?.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    if (text !== '') content.push({ type: 'text', text });
  }

  for (const toolCall of message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
    } catch {
      // Upstream emitted malformed JSON arguments; keep the raw string rather
      // than dropping the call entirely.
      input = { _raw: toolCall.function?.arguments ?? '' };
    }
    content.push({
      type: 'tool_use',
      id: toolCall.id ?? '',
      name: toolCall.function?.name ?? '',
      input,
    });
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    id: response.id ?? '',
    type: 'message',
    role: 'assistant',
    model: response.model ?? '',
    content,
    stop_reason: reasonToClaude(choice?.finish_reason),
    stop_sequence: null,
    usage: claudeUsageFromOpenAI(response.usage),
  };
}

/* ---------------- Streaming: OpenAI chunks -> Claude events ---------------- */

/**
 * Emits Anthropic SSE events from an OpenAI chunk stream.
 *
 * The ordering contract that matters: Anthropic clients expect
 *   message_start -> (content_block_start, deltas..., content_block_stop)*
 *   -> message_delta(stop_reason + usage) -> message_stop
 * A tool call forces the open text block to close first, because block indices
 * must be contiguous.
 */
export class OpenAIToClaudeStream {
  private started = false;
  private textBlockOpen = false;
  private toolBlockOpen = false;
  private nextIndex = 0;
  private usage: Usage | null = null;
  private readonly id: string;
  private readonly model: string;

  constructor(id: string, model: string) {
    this.id = id;
    this.model = model;
  }

  push(chunk: OpenAIStreamChunk): ClaudeStreamEvent[] {
    const events: ClaudeStreamEvent[] = [];

    if (!this.started) {
      this.started = true;
      events.push({
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    const choice: OpenAIStreamChoice | undefined = chunk.choices?.[0];

    if (choice?.delta?.content && choice.delta.content !== '') {
      if (!this.textBlockOpen) {
        this.closeOpenBlock(events);
        this.textBlockOpen = true;
        events.push({
          type: 'content_block_start',
          index: this.nextIndex++,
          content_block: { type: 'text', text: '' } as Partial<ClaudeContentBlock> & { type: string },
        });
      }
      events.push({
        type: 'content_block_delta',
        index: this.nextIndex - 1,
        delta: { type: 'text_delta', text: choice.delta.content },
      });
    }

    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const isNewTool = toolCall.id !== undefined && toolCall.id !== '';
      if (isNewTool) {
        this.closeOpenBlock(events);
        this.toolBlockOpen = true;
        events.push({
          type: 'content_block_start',
          index: this.nextIndex++,
          content_block: {
            type: 'tool_use',
            id: toolCall.id ?? '',
            name: toolCall.function?.name ?? '',
            input: {},
          } as Partial<ClaudeContentBlock> & { type: string },
        });
      }
      const partialJson = toolCall.function?.arguments ?? '';
      if (partialJson !== '') {
        events.push({
          type: 'content_block_delta',
          index: this.nextIndex - 1,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        });
      }
    }

    if (choice?.finish_reason) {
      this.closeOpenBlock(events);
      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: reasonToClaude(choice.finish_reason),
          stop_sequence: null,
        },
      });
    }

    if (chunk.usage) {
      this.usage = usageFromOpenAI(chunk.usage);
      events.push({
        type: 'message_delta',
        delta: {},
        usage: claudeUsageFromOpenAI(chunk.usage),
      });
    }

    return events;
  }

  /**
   * Usage observed on the upstream stream, or null if the provider never sent
   * one. Streaming calls are accounted from here because there is no other
   * place to read it once the response has been forwarded.
   */
  getUsageFromEvents(): Usage | null {
    return this.usage;
  }

  /** Must be called once the upstream stream ends. Emits message_stop. */
  finalize(): ClaudeStreamEvent[] {
    const events: ClaudeStreamEvent[] = [];
    if (!this.started) {
      events.push({
        type: 'message_start',
        message: {
          id: this.id,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    this.closeOpenBlock(events);
    events.push({ type: 'message_stop' });
    return events;
  }

  private closeOpenBlock(events: ClaudeStreamEvent[]): void {
    if (this.textBlockOpen || this.toolBlockOpen) {
      events.push({ type: 'content_block_stop', index: this.nextIndex - 1 });
      this.textBlockOpen = false;
      this.toolBlockOpen = false;
    }
  }
}
