// skills/check-updates.ts — detect whether an installed community skill has
// an upstream update available, WITHOUT writing any files. Re-runs the same
// download + parse steps as installCommunitySkill (parseSkillSource →
// downloadAndExtract → readInstalledSkillSource → buildContent) and
// diffs the result against what's stored: `defaultContent` for the wrapped
// SKILL.md body, and a path-set + sha256 compare (computeScriptsChanged,
// fs-util.ts) for the bundled scripts against what's actually on disk in the
// skill's store dir.
//
// Called per-skill by the cron phase (cron/run-skill-update-check.ts),
// throttled there by `last_update_check_at`. This module owns ONLY the
// per-skill check + its DB write of the 3 tracking columns (update_available,
// update_detail, last_update_check_at) — it never touches the store-dir files.
// Applying an update (writing files, revoking script authorization) is a
// separate, explicit action: applySkillUpdate in install.ts.

import { join } from 'node:path';
import { eq, agentSkills, type AnyDrizzleDb, type SkillSourceProblem } from '@nodal-agents/db';
import { parseSkillSource, SkillSourceError } from './source';
import { downloadAndExtract, SkillFetchError } from './fetch';
import { FrontmatterError } from './frontmatter';
import { detectScripts } from './detect-scripts';
import {
  readInstalledSkillSource,
  buildContent,
  SkillInstallError,
  SkillIdentityChangedError,
} from './install';
import { buildNestedSkillExclusion, computeScriptsState } from './fs-util';

export interface SkillUpdateCheckSkill {
  id: string;
  slug: string;
  source: string;
  defaultContent: string | null;
  installedScripts: Array<{ path: string; language: string; sha256?: string }> | null;
}

export interface CheckSkillUpdateOptions {
  db: AnyDrizzleDb;
  skill: SkillUpdateCheckSkill;
  /**
   * Root community-skill store dir for the skill's entity (skillStoreDir
   * (entityId) — the caller resolves it, mirroring installCommunitySkill /
   * uninstallCommunitySkill / applySkillUpdate, which all take this same
   * option rather than resolving it internally). The skill's actual files
   * live at `${skillStoreDir}/${skill.slug}`.
   */
  skillStoreDir: string;
}

export type SkillUpdateCheckOutcome =
  /** Check completed and the 3 tracking columns were written. */
  | {
      kind: 'checked';
      contentChanged: boolean;
      scriptsChanged: boolean;
      scriptsState: 'clean' | 'update' | 'conflict' | 'local-only';
    }
  /**
   * The source could not be read as the skill this row tracks: repo/ref/
   * subdir/SKILL.md gone (HTTP 404) or no longer a valid skill
   * ('source_not_found'), or a SKILL.md that declares ANOTHER skill
   * ('identity_changed' — never reported as an update, see
   * readInstalledSkillSource). `reason` is the error that said so.
   * update_detail records the problem code and NO diff (a check that could
   * not compare claims neither "changed" nor "unchanged"); update_available
   * goes false because nothing can be applied (preview and apply refuse the
   * same source), and the owner sees the problem instead of the badge.
   * last_update_check_at is stamped, so the next check after the throttle
   * interval clears the problem if the source comes back.
   */
  | { kind: 'source_problem'; problem: SkillSourceProblem; reason: string }
  /**
   * GitHub API rate limit hit (HTTP 403/429, or GitHub's explicit rate-limit
   * body). NOTHING was written — the caller (cron phase) should stop
   * processing the rest of this tick's batch, since the anonymous quota is
   * shared across every skill it might check next.
   */
  | { kind: 'rate_limited' }
  /**
   * `source` no longer parses (SkillSourceError). `last_update_check_at` IS
   * stamped (m3, Opus review) — even though re-parsing costs no network I/O,
   * an unparseable row re-consumes a batch slot on EVERY tick otherwise
   * (SKILL_UPDATE_CHECK_BATCH_SIZE is small and the SELECT has no way to tell
   * "cheap to retry" apart from "due"), which starves every other due skill
   * behind it for as long as the row stays broken. `update_available` /
   * `update_detail` are left untouched — a parse failure isn't an answer
   * about whether the skill changed, just a reason the check itself couldn't
   * run.
   */
  | { kind: 'unparseable' };

function isRateLimitError(err: Error): boolean {
  return (
    /rate limit/i.test(err.message) ||
    /\bHTTP 403\b/.test(err.message) ||
    /\bHTTP 429\b/.test(err.message)
  );
}

function isNotFoundError(err: Error): boolean {
  return /not found/i.test(err.message) || /\bHTTP 404\b/.test(err.message);
}

async function markSourceProblem(
  db: AnyDrizzleDb,
  skillId: string,
  problem: SkillSourceProblem,
  upstreamSlug?: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(agentSkills)
    .set({
      updateAvailable: false,
      updateDetail: {
        sourceProblem: problem,
        ...(upstreamSlug ? { upstreamSlug } : {}),
        checkedAt: now.toISOString(),
      },
      lastUpdateCheckAt: now,
    })
    .where(eq(agentSkills.id, skillId));
}

/** m3 (Opus review): stamp the throttle timestamp ONLY — used when the check
 * couldn't produce a real answer (unparseable source) but still must not
 * re-consume a batch slot every tick. Leaves update_available/update_detail
 * untouched, unlike markSourceProblem (which DOES have an answer: the source
 * does not hold this skill). */
async function stampCheckedAt(db: AnyDrizzleDb, skillId: string): Promise<void> {
  await db
    .update(agentSkills)
    .set({ lastUpdateCheckAt: new Date() })
    .where(eq(agentSkills.id, skillId));
}

/**
 * Check ONE community skill for an upstream update. See SkillUpdateCheckOutcome
 * for what each outcome means and which of the 3 tracking columns it writes.
 */
export async function checkSkillUpdate(
  opts: CheckSkillUpdateOptions,
): Promise<SkillUpdateCheckOutcome> {
  const { db, skill } = opts;

  let source;
  try {
    source = parseSkillSource(skill.source);
  } catch (err) {
    if (err instanceof SkillSourceError) {
      await stampCheckedAt(db, skill.id);
      return { kind: 'unparseable' };
    }
    throw err;
  }

  let extracted: Awaited<ReturnType<typeof downloadAndExtract>>;
  try {
    extracted = await downloadAndExtract(source);
  } catch (err) {
    if (err instanceof SkillFetchError) {
      if (isRateLimitError(err)) return { kind: 'rate_limited' };
      if (isNotFoundError(err)) {
        await markSourceProblem(db, skill.id, 'source_not_found');
        return { kind: 'source_problem', problem: 'source_not_found', reason: err.message };
      }
    }
    throw err;
  }

  try {
    let upstream: Awaited<ReturnType<typeof readInstalledSkillSource>>;
    try {
      upstream = await readInstalledSkillSource(extracted.extractRoot, source, skill.slug);
    } catch (err) {
      // The repo resolved but the skill this row tracks is not there any more:
      // one that is ANOTHER skill (a different slug), or no (unambiguous)
      // SKILL.md at the path this install came from, or one that is no longer
      // a valid skill. Never an update of THIS skill, and never a crash of the
      // cron phase over a repo restructure.
      if (err instanceof SkillIdentityChangedError) {
        await markSourceProblem(db, skill.id, 'identity_changed', err.upstreamSlug);
        return { kind: 'source_problem', problem: 'identity_changed', reason: err.message };
      }
      if (err instanceof SkillInstallError || err instanceof FrontmatterError) {
        await markSourceProblem(db, skill.id, 'source_not_found');
        return { kind: 'source_problem', problem: 'source_not_found', reason: err.message };
      }
      throw err;
    }
    const { skillDirAbs, body } = upstream;

    const isExcluded = await buildNestedSkillExclusion(skillDirAbs);
    const freshScripts = await detectScripts(skillDirAbs, isExcluded);
    const wrapped = buildContent(skill.slug, body, freshScripts);
    const contentChanged = wrapped !== (skill.defaultContent ?? '');

    const localDir = join(opts.skillStoreDir, skill.slug);
    // Three-way compare against the install-time ORIGIN hashes: a locally
    // patched script with an unchanged upstream ('local-only') must NOT raise
    // the badge — there is nothing new to install, and "updating" would only
    // overwrite the local patches with identical upstream files.
    const scriptsState = await computeScriptsState(
      localDir,
      skillDirAbs,
      freshScripts,
      skill.installedScripts ?? [],
    );
    const scriptsChanged = scriptsState === 'update' || scriptsState === 'conflict';

    const now = new Date();
    await db
      .update(agentSkills)
      .set({
        updateAvailable: contentChanged || scriptsChanged,
        updateDetail: {
          contentChanged,
          scriptsChanged,
          scriptsState,
          checkedAt: now.toISOString(),
        },
        lastUpdateCheckAt: now,
      })
      .where(eq(agentSkills.id, skill.id));

    return { kind: 'checked', contentChanged, scriptsChanged, scriptsState };
  } finally {
    await extracted.cleanup();
  }
}
