/**
 * OpenAI Chat Completions data transfer objects.
 * Same permissiveness rule as the Claude DTOs: unknown fields survive.
 */

export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function';

export interface OpenAITextPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export interface OpenAIInputAudioPart {
  type: 'input_audio';
  input_audio: { data: string; format: 'wav' | 'mp3' };
}

export type OpenAIContentPart = OpenAITextPart | OpenAIImageUrlPart | OpenAIInputAudioPart;

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  index?: number;
}

/**
 * Streaming tool-call fragment. OpenAI sends `id` and `function.name` only on
 * the first fragment of each call; later fragments carry `index` and a slice of
 * `arguments`. Modelling them with the non-streaming type would force us to
 * invent a name we do not have.
 */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** OpenAI sends partial tool call arguments as a stream of string fragments. */
  refusal?: string | null;
  [key: string]: unknown;
}

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean | null;
}

export interface OpenAITool {
  type: 'function';
  function: OpenAIFunctionDef;
}

export type OpenAIToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
  n?: number | null;
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean } | null;
  stop?: string | string[] | null;
  presence_penalty?: number | null;
  frequency_penalty?: number | null;
  logit_bias?: Record<string, number> | null;
  user?: string | null;
  seed?: number | null;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  parallel_tool_calls?: boolean | null;
  response_format?: { type: string; [key: string]: unknown } | null;
  reasoning_effort?: 'low' | 'medium' | 'high' | null;
  [key: string]: unknown;
}

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
    audio_tokens?: number;
  };
  completion_tokens_details?: Record<string, number>;
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIMessage;
  finish_reason: string | null;
  logprobs?: unknown | null;
}

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage?: OpenAIUsage;
  system_fingerprint?: string;
  [key: string]: unknown;
}

export interface OpenAIStreamChoice {
  index: number;
  delta: {
    role?: OpenAIRole;
    content?: string | null;
    tool_calls?: OpenAIToolCallDelta[];
    refusal?: string | null;
    [key: string]: unknown;
  };
  finish_reason: string | null;
  logprobs?: unknown | null;
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
  system_fingerprint?: string;
  [key: string]: unknown;
}
