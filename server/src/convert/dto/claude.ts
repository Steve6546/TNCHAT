/**
 * Anthropic Messages API data transfer objects.
 *
 * Models are intentionally permissive. Real providers attach extra fields
 * (GMI/MiniMax returns `base_resp`, others add `service_tier`), and a strict
 * schema would reject valid traffic. Unknown fields are preserved where we
 * pass through and dropped only where we genuinely rewrite the payload.
 */

export type ClaudeRole = 'user' | 'assistant';

export interface ClaudeTextBlock {
  type: 'text';
  text: string;
  citations?: unknown[] | null;
}

export interface ClaudeImageSource {
  type: 'base64' | 'url' | 'file';
  media_type?: string;
  data?: string;
  url?: string;
  file_id?: string;
}

export interface ClaudeImageBlock {
  type: 'image';
  source: ClaudeImageSource;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ClaudeContentBlock[];
  is_error?: boolean;
}

export interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ClaudeRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | ClaudeRedactedThinkingBlock;

export interface ClaudeMediaMessage {
  type: 'text' | 'image';
  text?: string;
  source?: ClaudeImageSource;
  cache_control?: { type: 'ephemeral' } | null;
}

export interface ClaudeMessage {
  role: ClaudeRole;
  content: string | ClaudeContentBlock[];
}

export interface ClaudeTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface ClaudeToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

export interface ClaudeThinking {
  type: 'enabled' | 'disabled' | 'adaptive';
  budget_tokens?: number;
  display?: string;
}

export interface ClaudeRequest {
  model: string;
  messages: ClaudeMessage[];
  max_tokens?: number;
  system?: string | ClaudeMediaMessage[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
  thinking?: ClaudeThinking;
  output_config?: unknown;
  service_tier?: string;
  [key: string]: unknown;
}

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
}

export interface ClaudeResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ClaudeContentBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: ClaudeUsage;
  [key: string]: unknown;
}

/* ---------- Streaming events ---------- */

/**
 * The message shell is written out field by field rather than as
 * `Omit<ClaudeResponse, 'content'>`. ClaudeResponse carries a string index
 * signature, and `Omit` over an index-signature type erases every named
 * property, which would silently widen `id` to `unknown`.
 */
export interface ClaudeStreamMessageShell {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content?: ClaudeContentBlock[];
  stop_reason: string | null;
  stop_sequence?: string | null;
  usage: ClaudeUsage;
  [key: string]: unknown;
}

export interface ClaudeStreamMessageStart {
  type: 'message_start';
  message: ClaudeStreamMessageShell;
}
export interface ClaudeStreamContentBlockStart {
  type: 'content_block_start';
  index: number;
  content_block: Partial<ClaudeContentBlock> & { type: string };
}
export interface ClaudeStreamContentBlockDelta {
  type: 'content_block_delta';
  index: number;
  delta:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: 'thinking_delta'; thinking: string }
    | { type: 'signature_delta'; signature: string }
    | { type: string; [key: string]: unknown };
}
export interface ClaudeStreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}
export interface ClaudeStreamMessageDelta {
  type: 'message_delta';
  delta: { stop_reason?: string | null; stop_sequence?: string | null };
  usage?: Partial<ClaudeUsage>;
}
export interface ClaudeStreamMessageStop {
  type: 'message_stop';
}
export interface ClaudeStreamPing {
  type: 'ping';
}
export interface ClaudeStreamError {
  type: 'error';
  error: { type: string; message: string };
}

export type ClaudeStreamEvent =
  | ClaudeStreamMessageStart
  | ClaudeStreamContentBlockStart
  | ClaudeStreamContentBlockDelta
  | ClaudeStreamContentBlockStop
  | ClaudeStreamMessageDelta
  | ClaudeStreamMessageStop
  | ClaudeStreamPing
  | ClaudeStreamError;
