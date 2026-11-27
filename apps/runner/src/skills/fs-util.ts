// skills/fs-util.ts — small filesystem helpers for the skill installer.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { findSkillManifests } from './fetch';
import type { DetectedScript } from './detect-scripts';

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

/**
 * A repo whose chosen SKILL.md sits at a folder may bundle OTHER skills (e.g.
 * a plugins/ mirror shipping its own SKILL.md nested inside it). Those
 * subtrees belong to a different skill — build a predicate that excludes them
 * from a file copy / script scan so we don't duplicate files or report the
 * same script twice.
 *
 * Shared by installCommunitySkill (install.ts), applySkillUpdate (install.ts),
 * and checkSkillUpdate (check-updates.ts) — all three walk the same "skill
 * folder possibly containing nested skills" shape against a freshly extracted
 * upstream copy.
 */
export async function buildNestedSkillExclusion(
  skillDirAbs: string,
): Promise<(abs: string) => boolean> {
  const nestedSkillDirs = (await findSkillManifests(skillDirAbs))
    .filter((m) => m !== 'SKILL.md')
    .map((m) => join(skillDirAbs, dirname(m)));
  return (abs: string): boolean =>
    nestedSkillDirs.some((d) => abs === d || abs.startsWith(d + sep));
}

/** sha256 of a file's contents, or null if it can't be read (e.g. missing). */
export async function hashFile(p: string): Promise<string | null> {
  try {
    const buf = await readFile(p);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Stamp each detected script with the sha256 of its file under `skillDirAbs`
 * (a freshly extracted upstream copy). This is the ORIGIN hash persisted in
 * `agent_skills.installed_scripts` at install/update time. The whole folder
 * is compared through the file manifest (manifest.ts); these per-script hashes
 * remain the origin of scripts for a skill installed before the manifest.
 */
export async function hashScripts(
  skillDirAbs: string,
  scripts: DetectedScript[],
): Promise<Array<{ path: string; language: string; sha256: string }>> {
  const out: Array<{ path: string; language: string; sha256: string }> = [];
  for (const s of scripts) {
    const h = await hashFile(join(skillDirAbs, s.path));
    // A file we just extracted but cannot read back is a hard install problem,
    // not something to paper over with a fake hash (invariant: fail loud).
    if (h === null) {
      throw new Error(`hashScripts: cannot read just-extracted script "${s.path}"`);
    }
    out.push({ path: s.path, language: s.language, sha256: h });
  }
  return out;
}
