// What the shell's file viewer has open right now — the seam that lets a VOICE edit target
// "the document I'm looking at" without the path ever passing through the voice model
// (mirror of images/context.ts). The viewer arms this over WS (file_context) on open and
// clears it on close / shell disconnect.

export class FileEditContext {
  private path: string | null = null;

  /** null = viewer closed. */
  set(path: string | null) {
    this.path = path;
  }

  get(): string | null {
    return this.path;
  }
}

/** Apply a raw file_context wire message. A bad payload CLEARS the context (fail toward
 *  "no target") — extracted from index.ts so the clearing semantics are testable. */
export function applyFileContext(
  context: FileEditContext,
  msg: { path?: unknown },
  onError: (detail: string) => void,
): void {
  try {
    context.set(typeof msg.path === 'string' && msg.path ? msg.path : null);
  } catch (err) {
    context.set(null);
    onError(String(err));
  }
}
