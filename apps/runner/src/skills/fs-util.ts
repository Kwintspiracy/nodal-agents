// skills/fs-util.ts — small filesystem helpers for the skill installer.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Count regular files under a directory (recursive), capped for safety. */
export async function countFilesIn(
  dir: string,
  isExcluded?: (abs: string) => boolean,
  cap = 50000,
): Promise<number> {
  let count = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of dirents) {
      if (count >= cap) return count;
      const abs = join(d, e.name);
      if (isExcluded?.(abs)) continue;
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) count++;
    }
  }
  return count;
}
