// Image-filename confinement + naming + gallery lookup, shared by every wire ingress
// (typed edits, the viewer context, the edit_image/open_image tools). Names are WORDS
// derived from the prompt (the user, 2026-07-16): hex ids were impossible to recall by
// voice — "get the ember back up" needs `green-ember.png`, not `e708105c.png`.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.ts';

/** Image filenames cross the wire (shell messages, model tool args) — confine them to
 *  bare generated-image names so they can never traverse out of the images dir.
 *  JS \w is ASCII-only, so no separators, dots, or unicode tricks fit the pattern. */
export function safeImageFile(name: string): string {
  if (!/^[\w-]+\.png$/.test(name)) throw new Error(`invalid image filename: ${name.slice(0, 60)}`);
  return name;
}

// Words that carry no recall value in an image prompt — strip before picking name words.
const NAME_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'with', 'and', 'or', 'on', 'in', 'at', 'to', 'for', 'over', 'under',
  'image', 'picture', 'photo', 'wallpaper', 'scene', 'test', 'small', 'square', 'landscape',
  'portrait', 'style', 'quality', 'draft', 'background', 'high', 'ultra', 'highly', 'detailed',
  'make', 'create', 'single', 'looking', 'very',
]);

/** The first few meaningful prompt words, kebab-cased — how the user will refer to the
 *  image later ("the green ember one"). Always satisfies safeImageFile's charset. */
export function imageNameHint(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
  return words.slice(0, 3).join('-').slice(0, 48).replace(/-+$/, '') || 'image';
}

/**
 * Gallery lookup for voice recall: newest-first names, optionally ranked by how many of
 * the query's tokens appear in the name. Zero-score entries never match — the caller
 * decides between "open the single match", "ask which of these", and "no match".
 */
export function findGalleryImages(query: string | null, limit = 8): string[] {
  let files: Array<{ file: string; ts: number }> = [];
  try {
    files = readdirSync(config.home.images)
      .filter((f) => /\.png$/i.test(f))
      .flatMap((f) => {
        try {
          return [{ file: f, ts: statSync(join(config.home.images, f)).mtimeMs }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
  files.sort((a, b) => b.ts - a.ts);
  const names = files.map((f) => f.file);
  if (!query) return names.slice(0, limit);
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
  if (tokens.length === 0) return names.slice(0, limit);
  return names
    .map((name) => ({ name, score: tokens.filter((t) => name.toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.name)
    .slice(0, limit);
}
