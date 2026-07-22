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
 * `agent_skills.installed_scripts` at install/update time — the baseline the
 * three-way update check (computeScriptsState) compares both upstream and the
 * local store-dir against.
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

/**
 * Three-way state of a skill's bundled scripts, comparing upstream (fresh
 * download), the install-time ORIGIN (sha256 stored in installed_scripts) and
 * the local store-dir files:
 *
 *   - 'clean'      — upstream == origin and local == origin: nothing to do.
 *   - 'update'     — upstream moved, local untouched: safe to apply.
 *   - 'conflict'   — upstream moved AND local was patched: applying overwrites
 *                    the local patches — surface the choice, never auto-pick.
 *   - 'local-only' — local was patched but upstream has NOT moved: there is
 *                    nothing new to install, so this must NOT raise the update
 *                    badge (the pre-three-way checker did, inviting users to
 *                    overwrite their own fixes with an identical upstream).
 *
 * Legacy rows installed before origin hashes existed (no `sha256` on any
 * entry) can't distinguish "upstream moved" from "local patched" — for those
 * the origin falls back to the LOCAL file hash (the historical local-vs-fresh
 * compare), and any difference reports as 'update'. One apply/acknowledge
 * stamps real origin hashes and the row graduates to true three-way.
 */
export async function computeScriptsState(
  localDir: string,
  freshSkillDir: string,
  freshScripts: DetectedScript[],
  storedScripts: Array<{ path: string; language: string; sha256?: string }>,
): Promise<'clean' | 'update' | 'conflict' | 'local-only'> {
  const freshPaths = new Set(freshScripts.map((s) => s.path));
  const storedPaths = new Set(storedScripts.map((s) => s.path));
  // A changed SET of scripts is an upstream restructure: report as an
  // upstream change (update/conflict depending on local state below).
  let upstreamChanged =
    freshPaths.size !== storedPaths.size || [...freshPaths].some((p) => !storedPaths.has(p));

  let localPatched = false;
  for (const stored of storedScripts) {
    const [freshHash, localHash] = await Promise.all([
      freshPaths.has(stored.path) ? hashFile(join(freshSkillDir, stored.path)) : null,
      hashFile(join(localDir, stored.path)),
    ]);
    // Legacy entry without an origin hash: fall back to the local file as the
    // baseline (historical behavior — see doc comment above).
    const originHash = stored.sha256 ?? localHash;
    if (freshPaths.has(stored.path) && freshHash !== originHash) upstreamChanged = true;
    if (stored.sha256 !== undefined && localHash !== stored.sha256) localPatched = true;
  }

  if (upstreamChanged) return localPatched ? 'conflict' : 'update';
  return localPatched ? 'local-only' : 'clean';
}

/**
 * True if the upstream skill's bundled scripts differ from what's currently
 * installed on disk — either the SET of script paths changed (added/removed)
 * or a script present in both has different content (sha256 compare).
 *
 * Read-only: never writes to `localDir`. `freshSkillDir` is a freshly
 * downloaded/extracted upstream copy (e.g. a temp dir from downloadAndExtract);
 * `localDir` is the skill's actual store dir on disk (skillStoreDir(entityId)/slug).
 */
export async function computeScriptsChanged(
  localDir: string,
  freshSkillDir: string,
  freshScripts: DetectedScript[],
  storedScripts: Array<{ path: string; language: string }>,
): Promise<boolean> {
  const freshPaths = new Set(freshScripts.map((s) => s.path));
  const storedPaths = new Set(storedScripts.map((s) => s.path));
  if (freshPaths.size !== storedPaths.size) return true;
  for (const p of freshPaths) if (!storedPaths.has(p)) return true;

  for (const script of freshScripts) {
    const [freshHash, localHash] = await Promise.all([
      hashFile(join(freshSkillDir, script.path)),
      hashFile(join(localDir, script.path)),
    ]);
    // freshHash === null would mean we just downloaded the file but can't
    // read it back — shouldn't happen, but fail toward "changed" (safer to
    // over-flag / re-request script authorization than to silently trust).
    if (freshHash === null || freshHash !== localHash) return true;
  }
  return false;
}
