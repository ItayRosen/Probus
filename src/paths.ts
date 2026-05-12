// Locate the package root (the parent of `dist/` or `src/`) so we can place
// scan output and find the bundled web assets regardless of whether we're
// running from `tsx src/...` (dev) or `node dist/...` (installed).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findRoot(start: string): string {
  let cur = start;
  // Walk up until we find a directory named 'dist' or 'src' — its parent is
  // the package root. Fall back to `start` if we don't find one.
  while (true) {
    const base = path.basename(cur);
    if (base === 'dist' || base === 'src') return path.dirname(cur);
    const parent = path.dirname(cur);
    if (parent === cur) return start;
    cur = parent;
  }
}

export const PACKAGE_ROOT: string = findRoot(HERE);
export const WEB_DIR: string = path.join(PACKAGE_ROOT, 'dist', 'web');

export function repoSlugFor(repoPath: string): string {
  const base = path.basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

export function repoOutputDir(repoSlug: string): string {
  return path.join(PACKAGE_ROOT, 'output', repoSlug);
}
