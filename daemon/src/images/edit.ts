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
import { echoForInstructions } from '../audio/announce.ts';
import type { Store } from '../events/store.ts';
import { imagesFetch, saveImageResponse } from './generate.ts';
import { imageNameHint, safeImageFile } from './files.ts';
import { pngDimensions, sanitizeStrokes, strokeMaskPng, type Stroke } from './mask.ts';

/**
 * Frame a masked-edit prompt so gpt-image-2 actually CONFINES the change to the brushed
 * region. Live finding (2026-07-16): with a bare instruction the model treats the mask as
 * a weak hint and reimagines the whole scene (the user brushed the right rock to add a
 * moose → the moose landed on the LEFT rock and the right rock vanished). An explicit
 * "edit ONLY the selected region, keep everything else identical" wrapper fixed it in a
 * side-by-side test — the moose landed exactly on the brushed rock with the rest
 * preserved. gpt-image-2 still isn't pixel-strict outside the mask, but it's night-and-day.
 * Whole-image edits (no strokes) keep the raw instruction — a global change is intended.
 */
export function framePromptForMask(instruction: string): string {
  return (
    `Edit ONLY the selected (masked) region of this image: ${instruction}. ` +
    `Blend the change naturally with the surrounding scene's existing lighting, color, and perspective. ` +
    `Keep everything OUTSIDE the selected region exactly identical to the original.`
  );
}

/** Run one masked (or whole-image) edit. Returns the NEW image's bare filename. */
export async function editImage(file: string, prompt: string, strokes?: Stroke[]): Promise<string> {
  const source = readFileSync(join(config.home.images, safeImageFile(file)));
  const masked = !!(strokes && strokes.length > 0);
  const form = new FormData();
  form.append('model', config.models.image);
  form.append('prompt', masked ? framePromptForMask(prompt) : prompt);
  // Highest-fidelity default (verified on a real edit): quality high. Deliberately NO
  // input_fidelity — gpt-image-2 rejects it with a 400 ("does not support the
  // 'input_fidelity' parameter", live failure 2026-07-16). PROBE TRAP for posterity:
  // the invalid-value probe listed high|low because the API validates parameter VALUES
  // before model support — enumeration proves the param exists somewhere (gpt-image-1),
  // not that this model takes it. Only a real call proves support.
  form.append('quality', config.images.quality);
  form.append('image', new Blob([new Uint8Array(source)], { type: 'image/png' }), file);
  if (masked) {
    const { width, height } = pngDimensions(source);
    form.append('mask', new Blob([new Uint8Array(strokeMaskPng(width, height, strokes!))], { type: 'image/png' }), 'mask.png');
  }
  const res = await imagesFetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    // No Content-Type header: fetch sets the multipart boundary itself.
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  return saveImageResponse(res, imageNameHint(prompt), 'image_edit');
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
    // image.edit_requested is emitted inside runImageEdit — one emitter for BOTH the
    // typed and voice paths (live gap 2026-07-16: voice edits skipped this function
    // entirely, so no working orb and no viewer busy state ever showed).
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
  // Emitted synchronously so the shell's working orb (and the viewer's busy state) pop
  // the instant ANY edit starts — typed or voice; the boot reaper also keys on it.
  store.addEvent(null, 'image.edit_requested', {
    file,
    prompt,
    ...(strokes && strokes.length > 0 ? { selection: true } : {}),
  });
  // Yield before the synchronous prefix (readFileSync + mask rasterization): callers
  // fire-and-forget this promise from the tool's execute / the WS handler, and without
  // the yield that sync work would run inline on THEIR turn — delaying the "instant"
  // ack and stalling the event loop that carries live voice audio (review 🟡).
  await new Promise((resolve) => setImmediate(resolve));
  const short = echoForInstructions(prompt); // quoted inside live instructions — defanged (review 🔵)
  const scoped = strokes && strokes.length > 0;
  // The announce is best-effort and must NOT be able to flip a terminal: it runs OUTSIDE the
  // editImage try, and its own rejection lands as a session.error, never a second terminal
  // event. (DB1: with announce inside the try, a rejecting success-announce emitted BOTH
  // image.created AND image.edit_failed and spoke a false "edit failed" for an edit already
  // on screen — the exactly-one-terminal invariant held only by the announce path's luck.)
  const speak = (cold: string, live: string) =>
    announce(cold, live).catch((e: unknown) =>
      store.addEvent(null, 'session.error', { message: `image edit announce: ${String(e)}` }),
    );
  let out: string;
  try {
    out = await editImage(file, prompt, strokes);
  } catch (err) {
    // A dedicated failure event (not a bare session.error): the shell viewer keys on it
    // to leave its busy state, and the dashboard feed shows what failed and why.
    store.addEvent(null, 'image.edit_failed', { file, prompt, error: String(err) });
    await speak(
      'the user, heads up — that image edit failed.',
      `The image edit the user asked for ("${short}") failed. Tell him briefly and offer to try again.`,
    );
    return;
  }
  store.addEvent(null, 'image.created', {
    file: out,
    prompt,
    edited_from: file,
    ...(scoped ? { selection: true } : {}),
  });
  await speak(
    'the user, your image edit is done — the new version is up.',
    `The image edit the user asked for ("${short}") just finished${scoped ? ' on the area he highlighted' : ''}; the new version is on screen and in his gallery. Tell him briefly — one sentence, no file names.`,
  );
}
