import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { runSubagent } from './openai-runner.ts';

test('research worker reaches Anthropic with its existing tools and preserves a full final report', async () => {
  const report = 'A complete report. '.repeat(100);
  const events: Array<{ type: string; payload: any }> = [];
  let calls = 0;
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async (url, init) => {
    calls++;
    assert.equal(new URL(String(url)).origin, 'https://api.anthropic.com');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'claude-opus-5-5');
    for (const name of ['web_search', 'x_search', 'fetch_page_contents', 'scrape_page', 'map_site', 'crawl_site', 'extract_structured', 'code_execution']) {
      assert.ok(body.tools.some((t: { name: string }) => t.name === name), name);
    }
    const sequence = [
      { type: 'message_start', message: { id: 'msg_worker', role: 'assistant', type: 'message', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: report } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(sequence.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await runSubagent({ taskId: 'provider-test', brief: 'Write a report', signal: new AbortController().signal, client,
    store: { addEvent: (_id: unknown, type: string, payload: unknown) => events.push({ type, payload }) } as never,
  });
  assert.equal(calls, 1);
  assert.equal(result, report);
  assert.equal(events.find(e => e.type === 'subagent.message')?.payload.text, report);
});

test('worker cancellation before a response never becomes a successful empty report', async () => {
  const controller = new AbortController();
  const client = new Anthropic({ apiKey: 'test', maxRetries: 0, fetch: async () => {
    controller.abort(new Error('cancelled worker'));
    throw controller.signal.reason;
  } });
  await assert.rejects(runSubagent({ taskId: 'cancelled', brief: 'test', signal: controller.signal, client,
    store: { addEvent() {} } as never,
  }), /cancelled worker/);
});
