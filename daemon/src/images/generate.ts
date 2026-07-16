// M5 image generation (SPEC §9): gpt-image-2 via the Images API. Verified live
// (2026-07-16): POST /v1/images/generations {model, prompt, size} → data[0].b64_json,
// a base64 PNG (output_format defaults to png). The base64 is decoded HERE and only a
// filename ever leaves this module — megabytes of base64 must never ride the event
// stream or the realtime loop.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import { echoForInstructions } from '../audio/announce.ts';
import type { Store } from '../events/store.ts';

export type ImageShape = 'square' | 'landscape' | 'portrait';
export type ImageQuality = 'low' | 'medium' | 'high' | 'auto';

/** One retry on 429/5xx (the repo's provider-retry convention, scaled to a single long
 *  background call rather than a search fan-out — review 🔵): a transient 500 on a
 *  multi-second render shouldn't announce failure to the user. The per-attempt timeout is
 *  the same background budget both callers already used; FormData bodies are plain
 *  objects (not streams), so re-sending is safe. */
export async function imagesFetch(url: string, init: RequestInit): Promise<Response> {
  const first = await fetch(url, { ...init, signal: AbortSignal.timeout(config.images.timeoutMs) });
  if (first.status !== 429 && first.status < 500) return first;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return fetch(url, { ...init, signal: AbortSignal.timeout(config.images.timeoutMs) });
}

/** Generate one image and land it in ~/Gumbo/images/. Returns the bare filename. */
export async function generateImage(prompt: string, shape: ImageShape, quality?: ImageQuality): Promise<string> {
  const res = await imagesFetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.models.image,
      prompt,
      size: config.images.sizes[shape] ?? config.images.sizes.square,
      quality: quality ?? config.images.quality,
    }),
  });
  return saveImageResponse(res);
}

/** Shared tail for generations AND edits: parse the b64_json envelope, decode, land the
 *  PNG in the images home, return the bare filename (the only thing that travels on). */
export async function saveImageResponse(res: Response): Promise<string> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`images api ${res.status}: ${detail.slice(0, 200)}`);
  }
  const body = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new Error('images api: no b64_json in response');
  // 'wx' + retry (review 🟡): 8-hex names are a 32-bit namespace and a plain write
  // silently replaces on collision — which would clobber a prior image and break the
  // non-destructive-edits guarantee. Exclusive create makes a collision loud and cheap.
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = `${randomUUID().slice(0, 8)}.png`;
    try {
      writeFileSync(join(config.home.images, file), Buffer.from(b64, 'base64'), { flag: 'wx' });
      return file;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('images: could not allocate a unique filename');
}

/**
 * The background half of the generate_image tool — the voice turn already returned an
 * instant ack, so this delivers the outcome when it lands (seconds later): image.created
 * with the FILENAME only, then a brief spoken completion via the M3 announce path. A
 * failure is spoken too — the user was told the image is coming; silence reads as a hang.
 *
 * LIFECYCLE (live failure 2026-07-16): image.generating {gen_id} is emitted SYNCHRONOUSLY
 * before any await — it's what pops the shell's generating orb instantly, and it's the
 * persisted record that lets the boot reaper (images/reconcile.ts) fail this work loudly
 * if a tsx-watch restart kills the in-flight promise. Every generating MUST reach exactly
 * one terminal: image.created {gen_id} or image.generate_failed {gen_id}.
 */
export async function runImageGeneration(opts: {
  prompt: string;
  shape: ImageShape;
  quality?: ImageQuality;
  store: Store;
  announce: (coldText: string, liveInstructions: string) => Promise<void>;
}): Promise<void> {
  const { prompt, shape, quality, store, announce } = opts;
  const genId = randomUUID().slice(0, 8);
  store.addEvent(null, 'image.generating', { gen_id: genId, prompt: prompt.slice(0, 400) });
  // Yield before the network call so the fire-and-forget caller's turn stays instant.
  await new Promise((resolve) => setImmediate(resolve));
  const short = echoForInstructions(prompt); // quoted inside live instructions — defanged (review 🔵)
  try {
    const file = await generateImage(prompt, shape, quality);
    store.addEvent(null, 'image.created', { file, prompt, gen_id: genId });
    await announce(
      "the user, your image is ready — it's up on your screen.",
      `The image the user asked for ("${short}") just finished and is now on his screen — the generating orb became the thumbnail, top right; clicking it opens the editor. Tell him it's up in ONE short sentence. Do not tell him to check the gallery or open anything.`,
    );
  } catch (err) {
    store.addEvent(null, 'image.generate_failed', { gen_id: genId, prompt: prompt.slice(0, 400), error: String(err) });
    await announce(
      'the user, heads up — the image generation failed.',
      `The image the user asked for ("${short}") failed to generate. Tell him briefly and offer to try again.`,
    );
  }
}
