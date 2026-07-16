// Image-filename confinement, shared by every wire ingress (typed edits, the viewer
// context, the edit_image tool). Lived in edit.ts originally, but it guards all image
// filenames, not just edits (review 🔵).

/** Image filenames cross the wire (shell messages, model tool args) — confine them to
 *  bare generated-image names so they can never traverse out of the images dir.
 *  JS \w is ASCII-only, so no separators, dots, or unicode tricks fit the pattern. */
export function safeImageFile(name: string): string {
  if (!/^[\w-]+\.png$/.test(name)) throw new Error(`invalid image filename: ${name.slice(0, 60)}`);
  return name;
}
