import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { convertClaudeRequestToOpenAI, OpenAIToClaudeStream } from './claude-to-openai.js';
import type { ClaudeRequest, ClaudeStreamEvent } from './dto/claude.js';
import type { OpenAIRequest, OpenAIStreamChunk } from './dto/openai.js';
import {
  convertClaudeResponseToOpenAI,
  convertOpenAIRequestToClaude,
  DEFAULT_CLAUDE_MAX_TOKENS,
} from './openai-to-claude.js';

describe('Claude request -> OpenAI request', () => {
  it('lifts system into a system message', () => {
    const claude: ClaudeRequest = {
      model: 'm1',
      system: 'You are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    };
    const openai = convertClaudeRequestToOpenAI(claude);
    assert.deepEqual(openai.messages[0], { role: 'system', content: 'You are helpful' });
    assert.equal(openai.max_tokens, 100);
  });

  it('expands a tool_result block into a separate tool message', () => {
    const claude: ClaudeRequest = {
      model: 'm1',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'found it' }],
        },
      ],
    };
    const openai = convertClaudeRequestToOpenAI(claude);
    const roles = openai.messages.map((m) => m.role);
    assert.deepEqual(roles, ['assistant', 'tool']);
    assert.equal(openai.messages[1]?.tool_call_id, 't1');
  });

  it('maps tool_choice variants correctly', () => {
    const base: ClaudeRequest = { model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] };
    assert.equal(
      convertClaudeRequestToOpenAI({ ...base, tool_choice: { type: 'any' } }).tool_choice,
      'required',
    );
    assert.equal(
      convertClaudeRequestToOpenAI({ ...base, tool_choice: { type: 'auto' } }).tool_choice,
      'auto',
    );
    assert.deepEqual(
      convertClaudeRequestToOpenAI({ ...base, tool_choice: { type: 'tool', name: 'f' } }).tool_choice,
      { type: 'function', function: { name: 'f' } },
    );
  });
});

describe('OpenAI request -> Claude request', () => {
  it('always sets max_tokens because Claude rejects requests without it', () => {
    const openai: OpenAIRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const claude = convertOpenAIRequestToClaude(openai);
    assert.equal(claude.max_tokens, DEFAULT_CLAUDE_MAX_TOKENS);
  });

  it('prefers an explicit max_tokens when present', () => {
    const claude = convertOpenAIRequestToClaude({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 256,
    });
    assert.equal(claude.max_tokens, 256);
  });

  it('coalesces consecutive tool messages into one user turn', () => {
    const claude = convertOpenAIRequestToClaude({
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      ],
    });
    const last = claude.messages.at(-1);
    assert.equal(last?.role, 'user');
    assert.equal(Array.isArray(last?.content) ? last.content.length : 0, 2);
  });
});

describe('Response conversion', () => {
  it('maps Claude usage into OpenAI usage', () => {
    const openai = convertClaudeResponseToOpenAI(
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 128 },
      },
      'm',
    );
    assert.equal(openai.choices[0]?.finish_reason, 'stop');
    assert.equal(openai.choices[0]?.message.content, 'hello');
    assert.equal(openai.usage?.prompt_tokens, 10);
    assert.equal(openai.usage?.completion_tokens, 4);
    assert.equal(openai.usage?.prompt_tokens_details?.cached_tokens, 128);
  });

  it('serialises tool_use blocks into OpenAI tool_calls', () => {
    const openai = convertClaudeResponseToOpenAI(
      {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'tool_use', id: 'x', name: 'f', input: { a: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      'm',
    );
    assert.equal(openai.choices[0]?.finish_reason, 'tool_calls');
    assert.equal(openai.choices[0]?.message.tool_calls?.[0]?.function.arguments, '{"a":1}');
  });
});

describe('Streaming: OpenAI chunks -> Claude events', () => {
  it('emits a well-formed Anthropic event sequence', () => {
    const stream = new OpenAIToClaudeStream('msg_x', 'm');
    const events: ClaudeStreamEvent[] = [];

    events.push(
      ...stream.push({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'He' }, finish_reason: null }],
      } as OpenAIStreamChunk),
    );
    events.push(
      ...stream.push({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"a":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
    events.push(
      ...stream.push({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      } as OpenAIStreamChunk),
    );
    events.push(...stream.finalize());

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'message_start');
    assert.equal(types.at(-1), 'message_stop');

    // A tool call must close the open text block before starting its own.
    const textStop = events.findIndex((e) => e.type === 'content_block_stop');
    const toolStart = events.findIndex(
      (e) => e.type === 'content_block_start' && e.content_block.type === 'tool_use',
    );
    assert.ok(textStop !== -1 && toolStart !== -1, 'both events must exist');
    assert.ok(textStop < toolStart, 'text block closes before tool block starts');

    // Indices must be contiguous: 0 for text, 1 for the tool.
    const blockStarts = events.filter((e) => e.type === 'content_block_start');
    assert.deepEqual(
      blockStarts.map((e) => (e as { index: number }).index),
      [0, 1],
    );

    assert.ok(
      events.some((e) => e.type === 'message_delta' && e.usage?.input_tokens === 3),
      'usage must be forwarded',
    );
  });
});
