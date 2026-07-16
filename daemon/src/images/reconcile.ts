// Boot-time truth repair for in-flight image work (live failure 2026-07-16): a tsx-watch
// restart killed an in-flight generation SILENTLY — the promise died with the process, so
// no event fired, nothing was spoken, and "did the picture regenerate?" had nothing to
// find. Tasks have the restart reaper for exactly this; images now do too. Any
// image.generating / image.edit_requested without a terminal event is failed loudly here
// (the caller announces once a shell is listening).
import type { Store } from '../events/store.ts';

export interface ReapedImageWork {
  kind: 'generation' | 'edit';
  prompt: string;
}

const SCAN_LIMIT = 500; // events — image work is sparse; this reaches back far enough

export function reapInterruptedImageWork(store: Store): ReapedImageWork[] {
  const events = store.listEvents({ limit: SCAN_LIMIT });

  // Terminals first: generations match precisely by gen_id; edits are credited per
  // source file (image.created {edited_from} or image.edit_failed {file}) — a
  // count-based match, since concurrent edits of one file are indistinguishable in
  // the log, and over-crediting is the safe direction (never fail completed work).
  const generationTerminals = new Set<string>();
  const editCredits = new Map<string, number>();
  for (const event of events) {
    const p = event.payload as Record<string, unknown> | null;
    if (event.type === 'image.created') {
      if (typeof p?.gen_id === 'string') generationTerminals.add(p.gen_id);
      if (typeof p?.edited_from === 'string') {
        editCredits.set(p.edited_from, (editCredits.get(p.edited_from) ?? 0) + 1);
      }
    } else if (event.type === 'image.generate_failed' && typeof p?.gen_id === 'string') {
      generationTerminals.add(p.gen_id);
    } else if (event.type === 'image.edit_failed' && typeof p?.file === 'string') {
      editCredits.set(p.file, (editCredits.get(p.file) ?? 0) + 1);
    }
  }

  const reaped: ReapedImageWork[] = [];
  for (const event of events) {
    const p = event.payload as Record<string, unknown> | null;
    if (event.type === 'image.generating' && typeof p?.gen_id === 'string' && !generationTerminals.has(p.gen_id)) {
      store.addEvent(null, 'image.generate_failed', {
        gen_id: p.gen_id,
        prompt: p.prompt,
        error: 'interrupted by daemon restart',
      });
      reaped.push({ kind: 'generation', prompt: String(p.prompt ?? '') });
    } else if (event.type === 'image.edit_requested' && typeof p?.file === 'string') {
      const credit = editCredits.get(p.file) ?? 0;
      if (credit > 0) {
        editCredits.set(p.file, credit - 1);
      } else {
        store.addEvent(null, 'image.edit_failed', {
          file: p.file,
          prompt: p.prompt,
          error: 'interrupted by daemon restart',
        });
        reaped.push({ kind: 'edit', prompt: String(p.prompt ?? '') });
      }
    }
  }
  return reaped;
}
