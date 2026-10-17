import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { tool, codeInterpreterTool } from '@openai/agents';
import { z } from 'zod';
import { runClaude, claudeTools, ClaudeProviderError } from './anthropic.ts';
import { priceOpusUsage } from '../usage/pricing.ts';

function response(content: unknown[], stop = 'end_turn', container?: string): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null,
      usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...(container ? { container: { id: container, expires_at: '' } } : {}) } },
    ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('Anthropic loop preserves thinking, tool IDs, validated invokers and container across turns', async () => {
  const requests: Record<string, any>[] = [];
  let invoked = 0;
  const echo = tool({ name: 'echo', description: 'Echo', parameters: z.object({ text: z.string() }), execute: async ({ text }) => { invoked++; return text; } });
  const thinking = { type: 'thinking', thinking: 'Checking the result.', signature: 'opaque_signature' };
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? response([thinking, { type: 'tool_use', id: 'tool_1', name: 'echo', input: { text: 'verified' } }], 'tool_use', 'container_test')
      : response([{ type: 'text', text: 'Complete.' }]);
  } });
  const events: string[] = [];
  const result = await runClaude({ instructions: 'Follow tools.', input: 'Echo verified.', tools: [echo], client, onEvent: type => events.push(type) });
  assert.equal(invoked, 1);
  assert.equal(result.text, 'Complete.');
  assert.equal(requests[0].model, 'claude-opus-5-5');
  assert.equal(requests[0].tool_choice.type, 'auto');
  assert.equal(requests[0].output_config.effort, 'high');
  assert.deepEqual(requests[0].thinking, { type: 'adaptive', display: 'updates' });
  assert.deepEqual(requests[1].messages[1].content[0], thinking);
  assert.equal(requests[1].messages[2].content[0].tool_use_id, 'tool_1');
  assert.equal(requests[1].messages[2].content[0].content, 'verified');
  assert.equal(requests[1].container, 'container_test');
  assert.deepEqual(events, ['subagent.thought', 'tool.call', 'tool.result', 'subagent.message']);
});

test('hosted Code Interpreter maps explicitly and unsupported tools fail visibly', () => {
  assert.deepEqual(claudeTools([codeInterpreterTool()]), [{ type: 'code_execution_20260521', name: 'code_execution' }]);
  assert.throws(() => claudeTools([{ type: 'hosted_tool', name: 'not_supported' }]), /No Anthropic transport/);
});

test('cancellation after provider completion cannot execute a tool or complete a report', async () => {
  const abort = new AbortController();
  let invoked = false;
  const t = tool({ name: 'action', description: 'Action', parameters: z.object({}), execute: async () => { invoked = true; return 'done'; } });
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => {
    abort.abort(new Error('cancel before action'));
    return response([{ type: 'tool_use', id: 'x', name: 'action', input: {} }], 'tool_use');
  } });
  await assert.rejects(runClaude({ instructions: 'test', input: 'test', tools: [t], client, signal: abort.signal }), /cancel before action/);
  assert.equal(invoked, false);
});

test('SDK-level approvals cannot bypass Gumbo permission handlers', async () => {
  let invoked = false;
  const t = tool({ name: 'action', description: 'Action', parameters: z.object({}), needsApproval: true, execute: async () => { invoked = true; return 'done'; } });
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => response([{ type: 'tool_use', id: 'x', name: 'action', input: {} }], 'tool_use') });
  const result = await runClaude({ instructions: 'test', input: 'test', tools: [t], client, maxTurns: 1 });
  assert.equal(invoked, false);
  assert.equal(result.exhausted, true);
  assert.match(JSON.stringify(result.history.at(-1)), /approval handler/);
});

test('pause_turn preserves server blocks and resumes without fabricated tool results', async () => {
  const block = { type: 'server_tool_use', id: 'server_1', name: 'bash_code_execution', input: { command: 'printf 42' } };
  let count = 0;
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async (_url, init) => {
    count++;
    if (count === 1) return response([block], 'pause_turn');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: [block] });
    return response([{ type: 'text', text: '42' }]);
  } });
  assert.equal((await runClaude({ instructions: 'test', input: 'test', client })).text, '42');
});

test('provider errors are typed and never expose the raw response', async () => {
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'private value' } }), { status: 401 }) });
  await assert.rejects(runClaude({ instructions: 'test', input: 'test', client }), e => e instanceof ClaudeProviderError && e.kind === 'auth' && !e.message.includes('private value'));
});

test('truncated output is not a successful report', async () => {
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => response([{ type: 'text', text: 'Partial' }], 'max_tokens') });
  await assert.rejects(runClaude({ instructions: 'test', input: 'test', client }), e => e instanceof ClaudeProviderError && e.kind === 'incomplete');
});

test('Opus API pricing separates fresh input and both cache TTLs', () => {
  assert.equal(priceOpusUsage({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } }), 37.2);
});
