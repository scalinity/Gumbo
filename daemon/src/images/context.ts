// M5.5: what the shell's image viewer is showing right now — the seam that makes VOICE
// edits work without coordinates ever passing through the voice model. The viewer arms
// this over WS (image_context) whenever it opens / the brush selection changes, and
// clears it on close; when the user then says "make the sky purple", the edit_image tool
// resolves "this image" and "the highlighted area" from here.
import { sanitizeStrokes, type Stroke } from './mask.ts';
import { safeImageFile } from './files.ts';

/** Apply a raw image_context wire message. A bad payload CLEARS the context (fail toward
 *  "no target") rather than leaving a stale image armed for voice edits — extracted from
 *  index.ts so the clearing semantics are unit-testable (review 🟡). */
export function applyImageContext(
  context: ImageEditContext,
  msg: { file?: unknown; strokes?: unknown },
  onError: (detail: string) => void,
): void {
  try {
    context.set(
      typeof msg.file === 'string' && msg.file ? safeImageFile(msg.file) : null,
      msg.strokes !== undefined ? sanitizeStrokes(msg.strokes) : [],
    );
  } catch (err) {
    context.set(null);
    onError(String(err));
  }
}

export class ImageEditContext {
  private file: string | null = null;
  private strokes: Stroke[] = [];
  private latestCreated: string | null = null;

  /** file null = viewer closed (strokes are meaningless without their image). */
  set(file: string | null, strokes: Stroke[] = []) {
    this.file = file;
    this.strokes = file ? strokes : [];
  }

  get(): { file: string; strokes: Stroke[] } | null {
    return this.file ? { file: this.file, strokes: this.strokes } : null;
  }

  /** index.ts notes every image.created here. "Edit the image you just created" must
   *  work by voice with NO viewer open (live gap 2026-07-16: the filename is deliberately
   *  withheld from the voice model everywhere, so without this the model literally cannot
   *  name the file the user means). Survives viewer open/close; in-memory like the rest of
   *  the context — after a daemon restart the user's next generation re-seeds it. */
  noteCreated(file: string) {
    this.latestCreated = file;
  }

  get latest(): string | null {
    return this.latestCreated;
  }
}
