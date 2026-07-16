// M5.5 image editing: gpt-image-2 via /v1/images/edits. Verified live (2026-07-16) with
// the shipped mask encoder: multipart {model, image, mask?, prompt} → data[0].b64_json,
// and the result PRESERVES the source dimensions (1536×1024 in → 1536×1024 out, no size
// param). Mask semantics: transparent pixels = "edit this", opaque = "preserve" — the
// shell's brush selection rasterizes to exactly that (mask.ts). Edits are
// non-destructive: every edit lands as a NEW image (new file + image.created with
// edited_from), never overwriting the source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';
import type { Store } from '../events/store.ts';
import { saveImageResponse } from './generate.ts';
import { safeImageFile } from './files.ts';
import { pngDimensions, sanitizeStrokes, strokeMaskPng, type Stroke } from './mask.ts';

/** Run one masked (or whole-image) edit. Returns the NEW image's bare filename. */
export async function editImage(file: string, prompt: string, strokes?: Stroke[]): Promise<string> {
  const source = readFileSync(join(config.home.images, safeImageFile(file)));
  const form = new FormData();
  form.append('model', config.models.image);
  form.append('prompt', prompt);
  form.append('image', new Blob([new Uint8Array(source)], { type: 'image/png' }), file);
  if (strokes && strokes.length > 0) {
    const { width, height } = pngDimensions(source);
    form.append('mask', new Blob([new Uint8Array(strokeMaskPng(width, height, strokes))], { type: 'image/png' }), 'mask.png');
  }
  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    // No Content-Type header: fetch sets the multipart boundary itself.
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(config.images.timeoutMs),
  });
  return saveImageResponse(res);
}

/**
 * Entry point for a typed edit off the wire (index.ts hands the raw shell message here).
 *
 * INVARIANT (review 🔴 + 🟡, both agents): every well-formed request terminates in
 * EXACTLY ONE of `image.created` | `image.edit_failed` — the viewer's busy state has no
 * other exit. Pre-flight failures (bad filename, malformed strokes) therefore emit
 * `image.edit_failed` too, not just a session.error the viewer never sees.
 */
export function acceptImageEditRequest(
  msg: { file?: unknown; prompt?: unknown; strokes?: unknown },
  store: Store,
  announce: (coldText: string, liveInstructions: string) => Promise<void>,
): void {
  const prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';
  const rawFile = typeof msg.file === 'string' ? msg.file : '';
  if (!prompt || !rawFile) return; // not a request the viewer could be busy-waiting on
  try {
    const file = safeImageFile(rawFile);
    const strokes = msg.strokes !== undefined ? sanitizeStrokes(msg.strokes) : undefined;
    store.addEvent(null, 'image.edit_requested', { file, prompt, ...(strokes?.length ? { selection: true } : {}) });
    runImageEdit({ file, prompt, strokes, store, announce }).catch((err: unknown) => {
      // runImageEdit handles (and speaks) its own failures — this only guards the
      // announce path itself so nothing becomes an unhandled rejection.
      store.addEvent(null, 'session.error', { message: `image edit announce: ${String(err)}` });
    });
  } catch (err) {
    store.addEvent(null, 'image.edit_failed', { file: rawFile, prompt, error: String(err) });
  }
}

/**
 * Background half of an edit request (typed from the viewer, or voiced through the
 * edit_image tool): the requester already got an instant ack. On success:
 * image.created carrying the new FILENAME + edited_from lineage (the shell swaps the
 * open viewer to the new version off this event), then a brief spoken completion.
 * Failures are spoken too — the user is waiting on something he asked for.
 */
export async function runImageEdit(opts: {
  file: string;
  prompt: string;
  strokes?: Stroke[];
  store: Store;
  announce: (coldText: string, liveInstructions: string) => Promise<void>;
}): Promise<void> {
  const { file, prompt, strokes, store, announce } = opts;
  const short = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
  const scoped = strokes && strokes.length > 0;
  try {
    const out = await editImage(file, prompt, strokes);
    store.addEvent(null, 'image.created', {
      file: out,
      prompt,
      edited_from: file,
      ...(scoped ? { selection: true } : {}),
    });
    await announce(
      'the user, your image edit is done — the new version is up.',
      `The image edit the user asked for ("${short}") just finished${scoped ? ' on the area he highlighted' : ''}; the new version is on screen and in his gallery. Tell him briefly — one sentence, no file names.`,
    );
  } catch (err) {
    // A dedicated failure event (not a bare session.error): the shell viewer keys on it
    // to leave its busy state, and the dashboard feed shows what failed and why.
    store.addEvent(null, 'image.edit_failed', { file, prompt, error: String(err) });
    await announce(
      'the user, heads up — that image edit failed.',
      `The image edit the user asked for ("${short}") failed. Tell him briefly and offer to try again.`,
    );
  }
}
