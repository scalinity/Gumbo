// M5 image generation (SPEC §9): gpt-image-2 via the Images API. Verified live
// (2026-07-16): POST /v1/images/generations {model, prompt, size} → data[0].b64_json,
// a base64 PNG (output_format defaults to png). The base64 is decoded HERE and only a
// filename ever leaves this module — megabytes of base64 must never ride the event
// stream or the realtime loop.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../events/store.ts';

export type ImageShape = 'square' | 'landscape' | 'portrait';

/** Generate one image and land it in ~/Gumbo/images/. Returns the bare filename. */
export async function generateImage(prompt: string, shape: ImageShape): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.models.image,
      prompt,
      size: config.images.sizes[shape] ?? config.images.sizes.square,
    }),
    // Background budget — the voice turn already got its ack; a hung request must still
    // resolve so the failure announcement fires instead of silence.
    signal: AbortSignal.timeout(config.images.timeoutMs),
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
  const file = `${randomUUID().slice(0, 8)}.png`;
  writeFileSync(join(config.home.images, file), Buffer.from(b64, 'base64'));
  return file;
}

/**
 * The background half of the generate_image tool — the voice turn already returned an
 * instant ack, so this delivers the outcome when it lands (seconds later): image.created
 * with the FILENAME only, then a brief spoken completion via the M3 announce path. A
 * failure is spoken too — the user was told the image is coming; silence reads as a hang.
 */
export async function runImageGeneration(opts: {
  prompt: string;
  shape: ImageShape;
  store: Store;
  announce: (coldText: string, liveInstructions: string) => Promise<void>;
}): Promise<void> {
  const { prompt, shape, store, announce } = opts;
  const short = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  try {
    const file = await generateImage(prompt, shape);
    store.addEvent(null, 'image.created', { file, prompt });
    await announce(
      'the user, your image is ready — it landed in the gallery.',
      `The image the user asked for ("${short}") just finished generating and is in his dashboard gallery. Tell him briefly it's ready — one sentence, no file names.`,
    );
  } catch (err) {
    store.addEvent(null, 'session.error', { message: `image generation: ${String(err)}` });
    await announce(
      'the user, heads up — the image generation failed.',
      `The image the user asked for ("${short}") failed to generate. Tell him briefly and offer to try again.`,
    );
  }
}
