// M5.5: what the shell's image viewer is showing right now — the seam that makes VOICE
// edits work without coordinates ever passing through the voice model. The viewer arms
// this over WS (image_context) whenever it opens / the brush selection changes, and
// clears it on close; when the user then says "make the sky purple", the edit_image tool
// resolves "this image" and "the highlighted area" from here.
import type { Stroke } from './mask.ts';

export class ImageEditContext {
  private file: string | null = null;
  private strokes: Stroke[] = [];

  /** file null = viewer closed (strokes are meaningless without their image). */
  set(file: string | null, strokes: Stroke[] = []) {
    this.file = file;
    this.strokes = file ? strokes : [];
  }

  get(): { file: string; strokes: Stroke[] } | null {
    return this.file ? { file: this.file, strokes: this.strokes } : null;
  }
}
