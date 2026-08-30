/**
 * Wire formats.
 *
 * Only OpenAI Chat Completions and Anthropic Messages are implemented. That is
 * a deliberate scope decision, not a gap: converting between Claude and OpenAI
 * is rated "Fair" by the upstream project's own matrix (usable, with some
 * fidelity loss), while routing through Gemini is rated "Discouraged". Gemini
 * is left unimplemented rather than implemented badly.
 */
export enum RelayFormat {
  OpenAI = 'openai',
  Claude = 'claude',
}

/**
 * Unified token usage.
 *
 * Anthropic reports cache read and cache write separately; OpenAI reports
 * `prompt_tokens_details.cached_tokens`. Both collapse into this shape so the
 * dashboard never has to know which provider served a call.
 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export function emptyUsage(): Usage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

/**
 * finish_reason / stop_reason normalisation.
 * Each protocol names the same terminal states differently.
 */
const TO_OPENAI: Record<string, string> = {
  end_turn: 'stop',
  max_tokens: 'length',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
  pause_turn: 'stop',
};

const TO_CLAUDE: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'refusal',
  function_call: 'tool_use',
};

/**
 * Unknown reasons fall back to the protocol's normal completion value rather
 * than being passed through: an unrecognised `stop_reason` would otherwise
 * reach a client that cannot interpret it.
 */
export function reasonToOpenAI(reason: string | null | undefined): string {
  if (!reason) return 'stop';
  return TO_OPENAI[reason] ?? 'stop';
}

export function reasonToClaude(reason: string | null | undefined): string {
  if (!reason) return 'end_turn';
  return TO_CLAUDE[reason] ?? 'end_turn';
}
