import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceRealtimeTurn,
  priceTerraTokens,
  priceGrok,
  priceImageUsage,
  priceTranscription,
  priceTranscriptionSeconds,
  priceTts,
  priceClaudeEquivalent,
  tavilySearchCost,
  exaSearchCost,
  exaContentsCost,
  firecrawlCost,
  XAI_TOOL_CALL_USD,
} from './pricing.ts';

const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

// THE case this table exists for: cached audio input is $0.40/1M vs $32/1M uncached — an
// 80× difference a totals-only computation would silently flatten.
test('realtime: fully-cached audio input prices at $0.40/1M, not $32/1M', () => {
  const cached = priceRealtimeTurn({
    input_tokens: 1_000_000,
    output_tokens: 0,
    input_token_details: {
      audio_tokens: 1_000_000,
      cached_tokens: 1_000_000,
      cached_tokens_details: { audio_tokens: 1_000_000, text_tokens: 0 },
    },
  });
  close(cached.costUsd, 0.4);
  const uncached = priceRealtimeTurn({
    input_tokens: 1_000_000,
    input_token_details: { audio_tokens: 1_000_000, cached_tokens: 0 },
  });
  close(uncached.costUsd, 32);
});

test('realtime: mixed turn sums per modality and reports the uncached/cached split', () => {
  const p = priceRealtimeTurn({
    input_tokens: 3000,
    output_tokens: 1500,
    input_token_details: {
      text_tokens: 2000,
      audio_tokens: 1000,
      cached_tokens: 1500,
      cached_tokens_details: { text_tokens: 1000, audio_tokens: 500 },
    },
    output_token_details: { text_tokens: 500, audio_tokens: 1000 },
  });
  // uncached text 1000×$4 + cached text 1000×$0.4 + uncached audio 500×$32 + cached audio
  // 500×$0.4 + text out 500×$24 + audio out 1000×$64 (all per-1M)
  close(p.costUsd, (1000 * 4 + 1000 * 0.4 + 500 * 32 + 500 * 0.4 + 500 * 24 + 1000 * 64) / 1e6);
  assert.equal(p.inputTokens, 1500); // uncached only
  assert.equal(p.cachedTokens, 1500);
  assert.equal(p.outputTokens, 1500);
});

test('realtime degraded: cached total without its text/audio split apportions audio-first', () => {
  // 1M audio in, all cached, but cached_tokens_details omitted — must price at the cached
  // audio rate ($0.40/1M), never as uncached audio + cached image (~$32.50).
  const p = priceRealtimeTurn({
    input_tokens: 1_000_000,
    input_token_details: { audio_tokens: 1_000_000, cached_tokens: 1_000_000 },
  });
  close(p.costUsd, 0.4);
  assert.equal(p.inputTokens, 0); // fully cached — nothing uncached
  assert.equal(p.cachedTokens, 1_000_000);
});

test('realtime degraded: missing input_token_details prices the total as uncached text', () => {
  const p = priceRealtimeTurn({ input_tokens: 10_000, output_tokens: 1000 });
  close(p.costUsd, (10_000 * 4 + 1000 * 24) / 1e6);
  assert.equal(p.inputTokens, 10_000);
  assert.equal(p.detail?.degraded, true);
});

// Scan BUG (2026-07-22): input_token_details present but output_token_details omitted while
// output_tokens is positive — the output side used to price at $0.
test('realtime degraded: output_tokens without output_token_details still costs (audio-out rate)', () => {
  const p = priceRealtimeTurn({
    input_tokens: 10_000,
    output_tokens: 2000,
    input_token_details: { text_tokens: 10_000 }, // present → not the input-degraded early return
    // output_token_details deliberately omitted
  });
  // input: 10k text @ $4/1M; output: 2k priced at the audio-out rate ($64/1M), never $0.
  close(p.costUsd, (10_000 * 4 + 2000 * 64) / 1e6);
  assert.equal(p.outputTokens, 2000, 'output tokens are still recorded');
  assert.equal(p.detail?.degraded_output, true);
});

test('terra: cached share priced at the cached rate', () => {
  const p = priceTerraTokens({ input: 100_000, cached: 60_000, output: 10_000 });
  close(p.costUsd, (40_000 * 2.5 + 60_000 * 0.25 + 10_000 * 15) / 1e6);
  assert.equal(p.inputTokens, 40_000);
  assert.equal(p.cachedTokens, 60_000);
});

test('grok: hot and background models price differently and tool calls add $0.005 each', () => {
  const hot = priceGrok('grok-4.20-non-reasoning', { input: 1000, output: 1000 }, 2);
  close(hot.costUsd, (1000 * 1.25 + 1000 * 2.5) / 1e6 + 2 * XAI_TOOL_CALL_USD);
  const deep = priceGrok('grok-4.5', { input: 1000, output: 1000 }, 0);
  close(deep.costUsd, (1000 * 2 + 1000 * 6) / 1e6);
  assert.ok(deep.costUsd > (hot.costUsd - 2 * XAI_TOOL_CALL_USD));
  const unknown = priceGrok('grok-9-mystery', { input: 1000 }, 0);
  assert.equal(unknown.detail?.unknown_model, true);
});

test('image: text-in, image-in, and image-out each at their own rate', () => {
  const p = priceImageUsage({
    input_tokens: 300,
    output_tokens: 4000,
    input_tokens_details: { text_tokens: 100, image_tokens: 200 },
  });
  close(p.costUsd, (100 * 5 + 200 * 8 + 4000 * 30) / 1e6);
  assert.equal(p.inputTokens, 300);
});

test('image partial details: text share = total − image, never the total again', () => {
  const p = priceImageUsage({
    input_tokens: 300,
    output_tokens: 0,
    input_tokens_details: { image_tokens: 200 }, // text_tokens omitted
  });
  close(p.costUsd, (100 * 5 + 200 * 8) / 1e6);
  assert.equal(p.inputTokens, 300); // not 500 — no double count
});

test('transcription: audio-in + text-out rates', () => {
  const p = priceTranscription({ input: 8000, output: 200 });
  close(p.costUsd, (8000 * 1.25 + 200 * 5) / 1e6);
});

test('transcription duration fallback: $0.003/min', () => {
  const p = priceTranscriptionSeconds(120);
  close(p.costUsd, 0.006);
  assert.equal(p.detail?.estimated, true);
});

test('tts: chars→tokens and seconds→tokens estimate, flagged estimated', () => {
  const p = priceTts(400, 10); // 100 in-tokens, 200 out-tokens
  close(p.costUsd, (100 * 0.6 + 200 * 12) / 1e6);
  assert.equal(p.detail?.estimated, true);
});

test('claude equivalent: cache write at 1.25× input, read at 0.1× input', () => {
  // opus family: in $5 → write $6.25, read $0.5; out $25
  const cost = priceClaudeEquivalent('claude-opus-4-8', {
    input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000,
  });
  assert.ok(cost !== null);
  close(cost, 5 + 25 + 6.25 + 0.5);
});

test('claude equivalent: dated snapshot ids resolve by family; unknown → null', () => {
  const dated = priceClaudeEquivalent('claude-haiku-4-5-20251001', { input: 1_000_000 });
  assert.ok(dated !== null);
  close(dated, 1);
  assert.equal(priceClaudeEquivalent('gpt-5.6-terra', { input: 1000 }), null);
});

test('credit providers: unit math', () => {
  assert.deepEqual(tavilySearchCost('advanced'), { units: 2, costUsd: 0.016 });
  assert.deepEqual(tavilySearchCost('fast'), { units: 1, costUsd: 0.008 });
  close(exaSearchCost('deep').costUsd, 0.012);
  close(exaSearchCost('auto').costUsd, 0.007);
  assert.deepEqual(exaContentsCost(10), { units: 10, costUsd: 0.01 });
  close(firecrawlCost(37).costUsd, 0.37);
});
