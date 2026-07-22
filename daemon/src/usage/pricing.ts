// Static price card for every metered provider Gumbo talks to. Rates verified against the
// live pricing pages 2026-07-21 (OpenAI developers.openai.com/api/docs/pricing; xAI
// docs.x.ai; Anthropic platform.claude.com; Tavily/Exa/Firecrawl pricing pages). Costs are
// computed AT WRITE TIME by the recorder, so editing a rate here changes only future rows —
// history never rewrites. All token rates are USD per 1M tokens.

/** USD for `tokens` at a per-1M `rate`. */
const perM = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;

// ── OpenAI ──────────────────────────────────────────────────────────────────────

// gpt-realtime-2.1 — the voice session. Cached audio input is $0.40 vs $32 uncached (80×),
// so the cached/uncached modality split is priced exactly, never from totals.
const REALTIME = {
  textIn: 4, cachedTextIn: 0.4, textOut: 24,
  audioIn: 32, cachedAudioIn: 0.4, audioOut: 64,
  imageIn: 5, cachedImageIn: 0.5,
};

// gpt-5.6-terra — background sub-agents, the supervisor, and vision queries.
const TERRA = { in: 2.5, cachedIn: 0.25, out: 15 };

// gpt-image-2 — image generation + edits.
const IMAGE = { textIn: 5, imageIn: 8, imageOut: 30 };

// gpt-4o-mini-transcribe — realtime input-audio transcription (billed on top of the session).
const TRANSCRIBE = { audioIn: 1.25, textOut: 5 };

// gpt-4o-mini-tts — cold announcements. /v1/audio/speech returns raw audio with no usage
// object, so both sides are estimates: text-in tokens ≈ chars/4; audio-out tokens ≈
// seconds × 20 (calibrated to OpenAI's own ≈$0.015/min estimate against the $12/1M rate).
const TTS = { textIn: 0.6, audioOut: 12 };
const TTS_TOKENS_PER_SECOND = 20;

// ── xAI (Grok) ──────────────────────────────────────────────────────────────────

// The ≥200k-context tier (rates double) is deliberately ignored — Gumbo's lookups are a few
// hundred tokens; revisit only if a query ever crosses it.
const GROK: Record<string, { in: number; cachedIn: number; out: number }> = {
  'grok-4.20-non-reasoning': { in: 1.25, cachedIn: 0.2, out: 2.5 },
  'grok-4.5': { in: 2, cachedIn: 0.3, out: 6 },
};
/** Server-side web_search / x_search: $5 per 1,000 tool calls, on top of tokens. */
export const XAI_TOOL_CALL_USD = 0.005;

// ── Anthropic (equivalent value — subscription auth, never billed) ─────────────
// Matched by family substring so dated snapshot ids resolve. Cache write = 1.25× input
// (5-minute TTL), cache read = 0.1× input.
const ANTHROPIC_FAMILIES: Array<{ match: string; in: number; out: number }> = [
  { match: 'fable', in: 10, out: 50 },
  { match: 'mythos', in: 10, out: 50 },
  { match: 'opus', in: 5, out: 25 },
  { match: 'sonnet', in: 3, out: 15 },
  { match: 'haiku', in: 1, out: 5 },
];

// ── Credit providers (estimates — flagged estimated=1 on the row) ──────────────
export const TAVILY_CREDIT_USD = 0.008; // advanced = 2 credits; basic/fast/ultra-fast = 1 (fast tiers assumed 1)
export const EXA_SEARCH_USD = { standard: 0.007, deep: 0.012 }; // code tiers fast/auto → standard
export const EXA_CONTENTS_PAGE_USD = 0.001;
export const FIRECRAWL_CREDIT_USD = 0.01; // Standard-plan effective rate; 1 credit/page

// ── Pricing functions ──────────────────────────────────────────────────────────

/** The realtime `response.done` usage shape (fields optional-guarded — live API may omit). */
export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    image_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

export interface PricedTokens {
  costUsd: number;
  inputTokens: number; // uncached input
  outputTokens: number;
  cachedTokens: number; // cache-read input
  detail?: Record<string, number | boolean>;
}

/** One voice turn. Uncached per modality = modality total − its cached share. */
export function priceRealtimeTurn(u: RealtimeUsage): PricedTokens {
  const inD = u.input_token_details ?? {};
  // Degraded payload: no input detail at all but a total — price it all as uncached text
  // (the cheapest defensible read) rather than silently pricing the input at $0.
  if (u.input_token_details === undefined && (u.input_tokens ?? 0) > 0) {
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    return {
      costUsd: perM(input, REALTIME.textIn) + perM(output, REALTIME.textOut),
      inputTokens: input, outputTokens: output, cachedTokens: 0,
      detail: { degraded: true },
    };
  }
  const cachedD = inD.cached_tokens_details ?? {};
  let cachedText = cachedD.text_tokens ?? 0;
  let cachedAudio = cachedD.audio_tokens ?? 0;
  const cachedTotal = inD.cached_tokens ?? cachedText + cachedAudio;
  // Degraded payload: a cached total without its text/audio split. Apportion it to audio
  // first, then text — misattributing cached audio as uncached would overprice 80×.
  if (inD.cached_tokens_details === undefined && cachedTotal > 0) {
    cachedAudio = Math.min(cachedTotal, inD.audio_tokens ?? 0);
    cachedText = Math.min(cachedTotal - cachedAudio, inD.text_tokens ?? 0);
  }
  // Cached image tokens have no details field — whatever cached remainder isn't text/audio.
  const cachedImage = Math.max(0, cachedTotal - cachedText - cachedAudio);
  const textIn = Math.max(0, (inD.text_tokens ?? 0) - cachedText);
  const audioIn = Math.max(0, (inD.audio_tokens ?? 0) - cachedAudio);
  const imageIn = Math.max(0, (inD.image_tokens ?? 0) - cachedImage);
  const outD = u.output_token_details ?? {};
  const textOut = outD.text_tokens ?? 0;
  const audioOut = outD.audio_tokens ?? 0;
  const costUsd =
    perM(textIn, REALTIME.textIn) + perM(cachedText, REALTIME.cachedTextIn) +
    perM(audioIn, REALTIME.audioIn) + perM(cachedAudio, REALTIME.cachedAudioIn) +
    perM(imageIn, REALTIME.imageIn) + perM(cachedImage, REALTIME.cachedImageIn) +
    perM(textOut, REALTIME.textOut) + perM(audioOut, REALTIME.audioOut);
  return {
    costUsd,
    inputTokens: textIn + audioIn + imageIn,
    outputTokens: u.output_tokens ?? textOut + audioOut,
    cachedTokens: cachedTotal,
    detail: {
      text_in: textIn, audio_in: audioIn, cached_text_in: cachedText,
      cached_audio_in: cachedAudio, text_out: textOut, audio_out: audioOut,
    },
  };
}

/** Plain Responses/chat-style usage: total input with a cached share. */
export interface TextUsage { input?: number; output?: number; cached?: number }

/** gpt-5.6-terra calls (sub-agent runs, supervisor answers, vision queries). */
export function priceTerraTokens(t: TextUsage): PricedTokens {
  const cached = t.cached ?? 0;
  const input = Math.max(0, (t.input ?? 0) - cached);
  const output = t.output ?? 0;
  return {
    costUsd: perM(input, TERRA.in) + perM(cached, TERRA.cachedIn) + perM(output, TERRA.out),
    inputTokens: input, outputTokens: output, cachedTokens: cached,
  };
}

/** Grok lookup/search: tokens at the model's rate + the per-tool-call fee. */
export function priceGrok(model: string, t: TextUsage, toolCalls: number): PricedTokens {
  const rates = GROK[model] ?? GROK['grok-4.5']; // unknown grok id → priciest known, noted in detail
  const known = model in GROK;
  const cached = t.cached ?? 0;
  const input = Math.max(0, (t.input ?? 0) - cached);
  const output = t.output ?? 0;
  const costUsd =
    perM(input, rates.in) + perM(cached, rates.cachedIn) + perM(output, rates.out) +
    toolCalls * XAI_TOOL_CALL_USD;
  const detail: Record<string, number | boolean> = { tool_calls: toolCalls };
  if (!known) detail.unknown_model = true;
  return { costUsd, inputTokens: input, outputTokens: output, cachedTokens: cached, detail };
}

/** gpt-image-2 usage: text + image input tokens, image output tokens. */
export function priceImageUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}): PricedTokens {
  const d = u.input_tokens_details ?? {};
  const imageIn = d.image_tokens ?? 0;
  // Partial details (image share known, text missing): text = total − image, never the
  // whole total again — that would double-count the image tokens.
  const textIn = d.text_tokens
    ?? (u.input_tokens_details ? Math.max(0, (u.input_tokens ?? 0) - imageIn) : u.input_tokens ?? 0);
  const output = u.output_tokens ?? 0;
  return {
    costUsd: perM(textIn, IMAGE.textIn) + perM(imageIn, IMAGE.imageIn) + perM(output, IMAGE.imageOut),
    inputTokens: textIn + imageIn, outputTokens: output, cachedTokens: 0,
    detail: { text_in: textIn, image_in: imageIn },
  };
}

/** Input-audio transcription usage (if the realtime event carries one). */
export function priceTranscription(t: TextUsage): PricedTokens {
  const input = t.input ?? 0;
  const output = t.output ?? 0;
  return {
    costUsd: perM(input, TRANSCRIBE.audioIn) + perM(output, TRANSCRIBE.textOut),
    inputTokens: input, outputTokens: output, cachedTokens: 0,
  };
}

/** Duration-type transcription usage — OpenAI's own ≈$0.003/min estimate. */
export function priceTranscriptionSeconds(seconds: number): PricedTokens {
  return {
    costUsd: (seconds / 60) * 0.003,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    detail: { seconds: Math.round(seconds * 10) / 10, estimated: true },
  };
}

/** TTS announcement estimate from input chars + measured PCM seconds. */
export function priceTts(chars: number, seconds: number): PricedTokens {
  const inputTokens = Math.round(chars / 4);
  const outputTokens = Math.round(seconds * TTS_TOKENS_PER_SECOND);
  return {
    costUsd: perM(inputTokens, TTS.textIn) + perM(outputTokens, TTS.audioOut),
    inputTokens, outputTokens, cachedTokens: 0,
    detail: { seconds: Math.round(seconds * 10) / 10, estimated: true },
  };
}

/** Anthropic tokens → equivalent API value. null = unknown family (caller records
 *  cost 0 + detail.unpriced — never a silent drop). */
export function priceClaudeEquivalent(
  model: string,
  t: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): number | null {
  const family = ANTHROPIC_FAMILIES.find((f) => model.includes(f.match));
  if (!family) return null;
  return (
    perM(t.input ?? 0, family.in) +
    perM(t.output ?? 0, family.out) +
    perM(t.cacheWrite ?? 0, family.in * 1.25) +
    perM(t.cacheRead ?? 0, family.in * 0.1)
  );
}

// ── Credit-provider helpers ────────────────────────────────────────────────────

export function tavilySearchCost(depth: string): { units: number; costUsd: number } {
  const units = depth === 'advanced' ? 2 : 1;
  return { units, costUsd: units * TAVILY_CREDIT_USD };
}

export function exaSearchCost(tier: string): { units: number; costUsd: number } {
  return { units: 1, costUsd: tier === 'deep' ? EXA_SEARCH_USD.deep : EXA_SEARCH_USD.standard };
}

export function exaContentsCost(pages: number): { units: number; costUsd: number } {
  return { units: pages, costUsd: pages * EXA_CONTENTS_PAGE_USD };
}

export function firecrawlCost(credits: number): { units: number; costUsd: number } {
  return { units: credits, costUsd: credits * FIRECRAWL_CREDIT_USD };
}
