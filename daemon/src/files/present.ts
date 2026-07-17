// Shared file-presentation logic (2026-07-16): reading a file for on-screen display goes
// through here from THREE callers — the present_file voice tool, the auto-present of a
// finished session's deliverable (session.ts), and the re-present after a document edit
// (files/edit.ts). Guards live in one place: absolute path, secret paths refused (incl.
// symlink targets), text-only, size-capped.
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { config, secretFilePaths } from '../config.ts';

// Content rides the file_present WS message inline; agent-written docs are tens of KB, so
// this is a runaway guard, not a working budget.
export const PRESENT_FILE_MAX_CHARS = 300_000;

export interface PresentedFile {
  title: string;
  file: string;
  path: string;
  content: string;
}

function hitsSecret(p: string): boolean {
  return secretFilePaths.some((s) => {
    const sec = resolve(s);
    return p === sec || p.startsWith(sec + sep);
  });
}

/** Read a file for presentation, or return a spoken-ready error string. The string secret
 *  check runs BEFORE realpathSync so a protected path that doesn't exist still refuses as
 *  "protected" instead of falling into the generic could-not-read message. */
export function readForPresentation(rawPath: string, title?: string | null): PresentedFile | { error: string } {
  const expanded = rawPath.startsWith('~') ? join(homedir(), rawPath.slice(1)) : rawPath;
  if (!isAbsolute(expanded)) return { error: `Pass an absolute path — got "${rawPath}".` };
  const real = resolve(expanded);
  if (hitsSecret(real)) return { error: 'That file is under a protected path and cannot be shown.' };
  let content: string;
  let realResolved: string;
  try {
    // resolve() doesn't follow symlinks but the reads below do — re-check the real target
    // so a link can't smuggle a protected file past the string check.
    realResolved = realpathSync(real);
    if (hitsSecret(realResolved)) return { error: 'That file is under a protected path and cannot be shown.' };
    if (statSync(realResolved).size > PRESENT_FILE_MAX_CHARS * 4) {
      return { error: 'That file is too large to present on screen — summarize it for the user instead.' };
    }
    content = readFileSync(realResolved, 'utf8');
  } catch {
    return { error: `Could not read ${real} — check the path (it must exist on this Mac).` };
  }
  if (content.includes('\u0000')) return { error: 'That looks like a binary file — only text files can be presented.' };
  return { title: title?.trim() || basename(real), file: basename(real), path: real, content: content.slice(0, PRESENT_FILE_MAX_CHARS) };
}

/** The boundary for EDITING (not just showing) a presented file: only documents under
 *  ~/Gumbo — the files Gumbo itself produced. Showing any non-secret file read-only is
 *  low-risk; writing arbitrary paths by voice is not. Repo/code files go through a
 *  supervised coding session instead. `realPath` must already be realpath'd (the write
 *  path realpaths its target because writeFileSync follows symlinks). The ROOT is realpath'd
 *  too when it exists: config.home.root is stored raw, but a parent can be a symlink
 *  (macOS temp/home dirs sit under /var → /private/var), so a raw-vs-realpath'd compare
 *  would wrongly refuse a legitimate in-workspace write. Matches how the rest of the
 *  codebase canonicalizes config.home paths (realOrLiteral in claude-runner). */
export function isEditableFile(realPath: string): boolean {
  const root = existsSync(config.home.root) ? realpathSync(config.home.root) : resolve(config.home.root);
  return realPath === root || realPath.startsWith(root + sep);
}
