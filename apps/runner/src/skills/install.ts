// skills/install.ts — orchestrate installing a community skill (open Agent
// Skills / SKILL.md format) into the local DB + skill store.
//
// Flow: parse source → download+extract repo → locate the SKILL.md → parse &
// validate frontmatter → detect bundled scripts → copy the skill folder into
// the store → upsert the agent_skills row (is_community=true). Fail loud at
// every step; never write a half-installed row.

import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, basename, sep, resolve } from 'node:path';
import { eq, and, agentSkills, agentSkillAssignments, type AnyDrizzleDb } from '@nodal-agents/db';
import { systemSkillSlugs } from '@nodal-agents/catalog';
import { parseSkillSource } from './source';
import { downloadAndExtract, findSkillManifests, isFile } from './fetch';
import { parseSkillMarkdown, validateFrontmatter } from './frontmatter';
import { detectScripts, type DetectedScript } from './detect-scripts';
import {
  countFilesIn,
  buildNestedSkillExclusion,
  computeScriptsChanged,
  hashScripts,
} from './fs-util';

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

export interface InstallSkillOptions {
  db: AnyDrizzleDb;
  /** Raw user-supplied source string (GitHub URL / owner-repo / skills.sh path). */
  source: string;
  /** Absolute path to the skill store root (e.g. ~/.nodalai/skills). */
  skillStoreDir: string;
  /** Entity that owns the installed skill row. */
  entityId: string;
}

export interface InstallSkillResult {
  slug: string;
  name: string;
  description: string;
  source: string;
  installedScripts: DetectedScript[];
  fileCount: number;
  reinstalled: boolean;
}

/** Default builtins granted to every installed skill: read its own bundle. */
const INSTALLED_SKILL_BUILTINS = ['skill_file_read', 'skill_file_list'];

/** Hard cap on the assembled skill content stored in the DB / injected into LLM context. */
export const MAX_SKILL_CONTENT_BYTES = 512 * 1024; // 512 KB

export function buildContent(slug: string, body: string, scripts: DetectedScript[]): string {
  const scriptNote = scripts.length
    ? `This skill bundles ${scripts.length} script file(s) (${scripts
        .map((s) => s.path)
        .join(', ')}). To run one, use the run_skill_script tool — e.g. ` +
      `run_skill_script({ skill: '${slug}', script: 'scripts/<name>', args: [...] }). It runs ` +
      `from the skill folder, so the skill's own files (workflows/, sibling modules) resolve by ` +
      `relative path; read its stdout (often JSON) for the result. If run_skill_script is NOT in ` +
      `your available tools, script execution has not been authorized for you — do that step with ` +
      `an equivalent native tool, or ask the user to enable "Allow scripts" for this skill. For ` +
      `any other shell the skill instructs (curl, CLIs, pip install), use run_command if you have it.`
    : 'This skill bundles no scripts.';
  return [
    '> **Installed skill — operational notes**',
    `> Your bundled files live in the skill store. Read them on demand with ` +
      `\`skill_file_read('${slug}', '<relative path>')\` and discover them with ` +
      `\`skill_file_list('${slug}')\`. Read files rather than assuming their contents.`,
    `> ${scriptNote}`,
    '',
    body.trim(),
  ].join('\n');
}

/**
 * Pick the SKILL.md manifest to install from the extracted repo, honouring an
 * explicit subdir, then a skills.sh skill name, then a single-manifest repo.
 * Returns the manifest path relative to extractRoot.
 */
export async function pickManifest(
  extractRoot: string,
  subdir: string | null,
  skillName: string | null,
): Promise<string> {
  if (subdir) {
    const rel = `${subdir.replace(/\/+$/, '')}/SKILL.md`;
    // CAT-2 (audit#2): source.ts now rejects a literal ".." in subdir at parse
    // time, but this is defense in depth in case a subdir ever reaches here by
    // another path (e.g. future callers of pickManifest, or a symlink/junction
    // trick in the extracted archive) — join()+resolve() can still land outside
    // extractRoot, and that path would then be read/copied as the skill's own
    // manifest. Mirrors the same startsWith(root + sep) guard fetch.ts already
    // applies to every archive entry during extraction.
    const rootResolved = resolve(extractRoot);
    const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
    const abs = resolve(join(extractRoot, rel));
    if (abs !== rootResolved && !abs.startsWith(rootWithSep)) {
      throw new SkillInstallError(`Unsafe skill path: "${subdir}" escapes the repository.`);
    }
    if (await isFile(abs)) return rel;
    throw new SkillInstallError(`No SKILL.md at "${subdir}" in the repository.`);
  }

  const manifests = await findSkillManifests(extractRoot);
  if (manifests.length === 0) {
    throw new SkillInstallError('No SKILL.md found in the repository.');
  }
  if (manifests.length === 1) return manifests[0]!;

  if (skillName) {
    // Prefer a manifest whose frontmatter name matches; fall back to folder name.
    const byFrontmatter: string[] = [];
    for (const rel of manifests) {
      try {
        const text = await readFile(join(extractRoot, rel), 'utf8');
        if (parseSkillMarkdown(text).frontmatter.name === skillName) byFrontmatter.push(rel);
      } catch {
        // ignore unreadable manifest
      }
    }
    if (byFrontmatter.length > 0) return byFrontmatter[0]!;
    const byFolder = manifests.filter((rel) => basename(dirname(rel)) === skillName);
    if (byFolder.length > 0) return byFolder[0]!;
    throw new SkillInstallError(
      `Repository has multiple skills but none named "${skillName}". Found: ${manifests
        .map((m) => dirname(m))
        .join(', ')}.`,
    );
  }

  // No disambiguator: prefer a SKILL.md at the repo root (the canonical skill;
  // common when a repo also ships a plugins/ mirror). Otherwise fail loud.
  const rootManifest = manifests.find((m) => m === 'SKILL.md');
  if (rootManifest) return rootManifest;

  throw new SkillInstallError(
    `Repository contains multiple skills. Specify which one (skills.sh path or a GitHub ` +
      `URL to the skill folder). Found: ${manifests.map((m) => dirname(m)).join(', ')}.`,
  );
}

export async function installCommunitySkill(
  opts: InstallSkillOptions,
): Promise<InstallSkillResult> {
  const source = parseSkillSource(opts.source);
  const { extractRoot, cleanup } = await downloadAndExtract(source);

  try {
    const manifestRel = await pickManifest(extractRoot, source.subdir, source.skillName);
    const skillDirAbs = join(extractRoot, dirname(manifestRel));
    const manifestAbs = join(extractRoot, manifestRel);

    const text = await readFile(manifestAbs, 'utf8');
    const { frontmatter, body } = parseSkillMarkdown(text);
    const { slug, name, description } = validateFrontmatter(frontmatter);

    // P2b (F-6 follow-up): refuse a slug reserved by the system catalog
    // outright, in ANY entity — before any insert/update. Not reachable as a
    // takeover of a REAL system row today (the collision guard below already
    // blocks that: a system-skill row is always isCommunity=false and has no
    // `source`, so `!existing.isCommunity || existing.source !== source.raw`
    // is always true for it and the reinstall branch always throws first).
    // This closes the door for coherence — a community skill should never be
    // installable under a catalog slug in the first place, in ANY entity,
    // not just the one that happens to hold the real system row.
    if (systemSkillSlugs.includes(slug)) {
      throw new SkillInstallError(
        `"${slug}" is reserved by a system skill and cannot be used for a community-installed ` +
          `skill. Rename the skill (its SKILL.md frontmatter "name") to use a different slug.`,
      );
    }

    // A repo whose chosen SKILL.md sits at the root may bundle OTHER skills
    // (e.g. a plugins/ mirror shipping its own SKILL.md). Those subtrees belong
    // to a different skill — exclude them from the copy + script scan so we
    // don't duplicate files or report the same script twice. Shared with
    // applySkillUpdate/checkSkillUpdate (fs-util.ts) — same folder shape.
    const isExcluded = await buildNestedSkillExclusion(skillDirAbs);

    const scripts = await detectScripts(skillDirAbs, isExcluded);
    const fileCount = await countFilesIn(skillDirAbs, isExcluded);

    // Collision handling: only overwrite a prior install of the SAME source,
    // scoped to THIS entity — slug is unique per (entity_id, slug), not
    // globally (F-6, audit #2), so an unscoped lookup here would find another
    // entity's skill row sharing the slug and silently overwrite its content
    // on "reinstall".
    const [existing] = await opts.db
      .select({
        id: agentSkills.id,
        isCommunity: agentSkills.isCommunity,
        source: agentSkills.source,
      })
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, slug), eq(agentSkills.entityId, opts.entityId)))
      .limit(1);

    let reinstalled = false;
    if (existing) {
      if (!existing.isCommunity || existing.source !== source.raw) {
        throw new SkillInstallError(
          `A skill with slug "${slug}" already exists from a different source. ` +
            `Uninstall it first if you want to replace it.`,
        );
      }
      reinstalled = true;
    }

    // Copy the skill folder into the store (replace on reinstall).
    const destDir = join(opts.skillStoreDir, slug);
    await mkdir(opts.skillStoreDir, { recursive: true });
    await rm(destDir, { recursive: true, force: true });
    await cp(skillDirAbs, destDir, {
      recursive: true,
      filter: (src) => !isExcluded(src),
    });

    const content = buildContent(slug, body, scripts);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > MAX_SKILL_CONTENT_BYTES) {
      throw new SkillInstallError(
        `Skill content too large (${contentBytes} bytes, max ${MAX_SKILL_CONTENT_BYTES / 1024}KB) — trim SKILL.md.`,
      );
    }
    // ORIGIN hashes: what upstream's scripts looked like at install time —
    // the baseline the three-way update check compares against.
    const hashedScripts = await hashScripts(skillDirAbs, scripts);
    const installedScripts = hashedScripts.length ? hashedScripts : null;

    if (existing) {
      await opts.db
        .update(agentSkills)
        .set({
          name,
          description,
          content,
          defaultContent: content,
          contentOverridden: false,
          requiredBuiltins: INSTALLED_SKILL_BUILTINS,
          active: true,
          isCommunity: true,
          source: source.raw,
          installedScripts,
          updatedAt: new Date(),
        })
        .where(eq(agentSkills.id, existing.id));
    } else {
      await opts.db.insert(agentSkills).values({
        entityId: opts.entityId,
        slug,
        name,
        description,
        content,
        defaultContent: content,
        contentOverridden: false,
        requiredBuiltins: INSTALLED_SKILL_BUILTINS,
        active: true,
        isCommunity: true,
        source: source.raw,
        installedScripts,
      });
    }

    return {
      slug,
      name,
      description,
      source: source.raw,
      installedScripts: scripts,
      fileCount,
      reinstalled,
    };
  } finally {
    await cleanup();
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface UninstallSkillOptions {
  db: AnyDrizzleDb;
  slug: string;
  skillStoreDir: string;
  /** Entity that must own the skill being uninstalled. */
  entityId: string;
}

/**
 * Remove an installed community skill: delete its agent_skills row (assignments
 * cascade via FK) and its files from the store. Refuses to touch a non-community
 * skill (system/custom skills are not uninstallable this way).
 */
export async function uninstallCommunitySkill(opts: UninstallSkillOptions): Promise<void> {
  if (!SLUG_RE.test(opts.slug)) {
    throw new SkillInstallError(`Invalid skill slug "${opts.slug}".`);
  }
  // F-6 (audit #2): slug is unique per (entity_id, slug), not globally — an
  // unscoped lookup here would let entity A uninstall (and delete the files
  // of) entity B's same-slug skill.
  const [existing] = await opts.db
    .select({ id: agentSkills.id, isCommunity: agentSkills.isCommunity })
    .from(agentSkills)
    .where(and(eq(agentSkills.slug, opts.slug), eq(agentSkills.entityId, opts.entityId)))
    .limit(1);
  if (!existing) {
    throw new SkillInstallError(`No skill installed with slug "${opts.slug}".`);
  }
  if (!existing.isCommunity) {
    throw new SkillInstallError(
      `Skill "${opts.slug}" is not a community-installed skill and cannot be uninstalled this way.`,
    );
  }
  await opts.db.delete(agentSkills).where(eq(agentSkills.id, existing.id));
  await rm(join(opts.skillStoreDir, opts.slug), { recursive: true, force: true });
}

// ─── previewSkillUpdate (SKILL-003) ─────────────────────────────────────────

export interface PreviewSkillUpdateResult {
  /** The skill text agents see TODAY — the left side of the diff. */
  currentContent: string;
  /** The skill text that WILL be installed — the right side of the diff. */
  upstreamContent: string;
  contentChanged: boolean;
  scriptsChanged: boolean;
  /** Bundled script paths detected upstream, for the "scripts will be re-authorized" notice. */
  scriptNames: string[];
  /**
   * SHA-256 of `upstreamContent`. Hand this back to `applySkillUpdate` as
   * `expectedContentHash`: the apply re-downloads, and if upstream has moved
   * since the preview it REFUSES rather than installing text nobody reviewed.
   */
  upstreamContentHash: string;
  /** True when the owner edited the skill locally — an apply won't clobber `content`. */
  contentOverridden: boolean;
}

/**
 * Compute exactly what an update would install, without writing anything.
 *
 * SKILL-003 (audit vague D). The update confirmation used to show a CATEGORY
 * ("Last check found: content changes"), never the text — while that text goes
 * straight into the system prompt of every agent the skill is assigned to. The
 * owner was approving content they had never seen, from a third-party repo:
 * persistent prompt injection with a consent dialog on top.
 *
 * Two halves are needed and this is the first. The second is that the apply
 * must install what was SHOWN: `applySkillUpdate` re-downloads at click time,
 * so the preview alone is a hint, not a promise (the old `describeChanges`
 * comment said as much). `upstreamContentHash` closes that gap.
 */
export async function previewSkillUpdate(
  opts: ApplySkillUpdateOptions,
): Promise<PreviewSkillUpdateResult> {
  const existing = await loadUpdatableSkill(opts);
  const source = parseSkillSource(existing.source!);
  const { extractRoot, cleanup } = await downloadAndExtract(source);
  try {
    const resolved = await resolveUpstreamContent(extractRoot, source, opts.slug);
    const localDir = join(opts.skillStoreDir, opts.slug);
    const scriptsChanged = await computeScriptsChanged(
      localDir,
      resolved.skillDirAbs,
      resolved.scripts,
      existing.installedScripts ?? [],
    );
    const currentContent = existing.defaultContent ?? '';
    return {
      currentContent,
      upstreamContent: resolved.content,
      contentChanged: resolved.content !== currentContent,
      scriptsChanged,
      scriptNames: resolved.scripts.map((s) => s.path),
      upstreamContentHash: sha256(resolved.content),
      contentOverridden: existing.contentOverridden === true,
    };
  } finally {
    await cleanup();
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── applySkillUpdate ───────────────────────────────────────────────────────

export interface ApplySkillUpdateOptions {
  db: AnyDrizzleDb;
  slug: string;
  skillStoreDir: string;
  /** Entity that must own the skill being updated. */
  entityId: string;
  /**
   * SKILL-003: the `upstreamContentHash` from the preview the owner actually
   * read. When set and upstream no longer matches, the apply FAILS instead of
   * installing unreviewed text (invariant #4 — no silent fallback). Omitted
   * only by callers with no human in the loop.
   */
  expectedContentHash?: string;
}

export interface ApplySkillUpdateResult {
  contentChanged: boolean;
  scriptsChanged: boolean;
  /** Number of agent_skill_assignments rows whose scripts_authorized flipped true→false. */
  scriptsAuthorizationRevoked: number;
}

/**
 * Apply a pending upstream update to an already-installed community skill:
 * re-download the current source, replace the store-dir files, and update the
 * DB row. Unlike checkSkillUpdate (read-only), this WRITES files and is meant
 * to be called from the explicit "apply update" action (POST /api/skills/update),
 * never from the throttled background check.
 *
 * - `defaultContent` is always overwritten with the freshly wrapped content.
 * - `content` is overwritten too, UNLESS the owner has edited it
 *   (`contentOverridden=true`) — a local edit is never silently clobbered by
 *   an upstream change; the owner sees the drift via `contentOverridden` and
 *   can reconcile manually.
 * - scripts changed (recomputed HERE, not read from the update_available
 *   cache written by the last background check — the upstream may have moved
 *   again since then) revokes scripts_authorized on every agent×skill
 *   assignment for this skill: an upstream that changes its scripts loses the
 *   owner's prior execution authorization and must be re-authorized per agent.
 */
/**
 * Load + validate the skill row an update targets. Shared by preview and apply
 * so the two can never disagree about what is updatable.
 *
 * F-6-shaped scoping (mirrors uninstallCommunitySkill): slug is unique per
 * (entity_id, slug), not globally.
 */
async function loadUpdatableSkill(opts: ApplySkillUpdateOptions): Promise<{
  id: string;
  isCommunity: boolean | null;
  source: string | null;
  defaultContent: string | null;
  contentOverridden: boolean | null;
  installedScripts: Array<{ path: string; language: string; sha256?: string }> | null;
}> {
  const [existing] = await opts.db
    .select({
      id: agentSkills.id,
      isCommunity: agentSkills.isCommunity,
      source: agentSkills.source,
      defaultContent: agentSkills.defaultContent,
      contentOverridden: agentSkills.contentOverridden,
      installedScripts: agentSkills.installedScripts,
    })
    .from(agentSkills)
    .where(and(eq(agentSkills.slug, opts.slug), eq(agentSkills.entityId, opts.entityId)))
    .limit(1);
  if (!existing) {
    throw new SkillInstallError(`No skill installed with slug "${opts.slug}".`);
  }
  if (!existing.isCommunity || !existing.source) {
    throw new SkillInstallError(
      `Skill "${opts.slug}" is not a community-installed skill and cannot be updated this way.`,
    );
  }
  return existing;
}

/**
 * Locate the manifest in an extracted repo and build the wrapped skill content.
 * Shared by preview and apply so the text the owner READS is produced by the
 * exact same code path as the text that gets INSTALLED.
 */
async function resolveUpstreamContent(
  extractRoot: string,
  source: ReturnType<typeof parseSkillSource>,
  slug: string,
): Promise<{
  skillDirAbs: string;
  scripts: DetectedScript[];
  content: string;
  /** Nested-skill filter, reused by the apply's file copy. */
  isExcluded: (src: string) => boolean;
}> {
  const manifestRel = await pickManifest(extractRoot, source.subdir, source.skillName);
  const skillDirAbs = join(extractRoot, dirname(manifestRel));
  const manifestAbs = join(extractRoot, manifestRel);
  const text = await readFile(manifestAbs, 'utf8');
  const { body } = parseSkillMarkdown(text);

  const isExcluded = await buildNestedSkillExclusion(skillDirAbs);
  const scripts = await detectScripts(skillDirAbs, isExcluded);
  const content = buildContent(slug, body, scripts);
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_SKILL_CONTENT_BYTES) {
    throw new SkillInstallError(
      `Skill content too large (${contentBytes} bytes, max ${MAX_SKILL_CONTENT_BYTES / 1024}KB) — trim SKILL.md.`,
    );
  }
  return { skillDirAbs, scripts, content, isExcluded };
}

export async function applySkillUpdate(
  opts: ApplySkillUpdateOptions,
): Promise<ApplySkillUpdateResult> {
  const existing = await loadUpdatableSkill(opts);

  const source = parseSkillSource(existing.source!);
  const { extractRoot, cleanup } = await downloadAndExtract(source);
  try {
    const resolved = await resolveUpstreamContent(extractRoot, source, opts.slug);
    const { skillDirAbs, scripts, content, isExcluded } = resolved;

    // SKILL-003: install what was REVIEWED, or nothing.
    //
    // This download is a SECOND fetch — the preview the owner read came from
    // an earlier one. Upstream is a third-party repo and can move between the
    // two. Without this check the owner's consent would apply to text that no
    // longer exists, which is precisely why the old confirmation dialog could
    // never be more than a hint. Fail loud (invariant #4): re-preview and let
    // them read the new text.
    if (opts.expectedContentHash && sha256(content) !== opts.expectedContentHash) {
      throw new SkillInstallError(
        `Upstream changed since you reviewed this update — nothing was installed. ` +
          `Re-open the update to read the new version before approving it.`,
      );
    }

    const localDir = join(opts.skillStoreDir, opts.slug);
    // Recomputed against what's ACTUALLY on disk right now — not the
    // update_available/update_detail cache from the last background check,
    // which may be stale (upstream could have changed again since then).
    const scriptsChanged = await computeScriptsChanged(
      localDir,
      skillDirAbs,
      scripts,
      existing.installedScripts ?? [],
    );
    const contentChanged = content !== (existing.defaultContent ?? '');
    // Fresh ORIGIN hashes: after an apply, upstream-now IS the new baseline.
    const hashedScripts = await hashScripts(skillDirAbs, scripts);
    const installedScripts = hashedScripts.length ? hashedScripts : null;
    const now = new Date();

    // C1 (Opus review): DB FIRST (one transaction: revoke + row update), THEN
    // the store-dir files — the REVERSE of the old order (files → row →
    // revoke). That old order had two failure modes:
    //   1. A crash between the file copy and the revoke left CHANGED scripts
    //      already on disk with the OLD authorization still active — an agent
    //      could execute upstream's new script before it was ever vetted.
    //   2. If only the revoke step failed, a retry would recompute
    //      scriptsChanged against the disk (already synced to the new
    //      upstream by step 1) and find nothing changed — permanently
    //      skipping the revocation.
    // With DB-first: a crash before commit leaves EVERYTHING untouched (files
    // and DB both still reflect the pre-update state) — safe, and a plain
    // retry redoes the whole thing from scratch. A crash AFTER commit but
    // before the file copy is fail-safe the other way: scripts_authorized is
    // already revoked (worst case the agent loses execution rights it should
    // keep, until the file copy catches up), and the store-dir files are
    // stale relative to the new default_content — the NEXT background check
    // re-downloads upstream and re-diffs against the (still-stale) local
    // files, so a missed file copy keeps getting re-flagged rather than
    // silently forgotten.
    let scriptsAuthorizationRevoked = 0;
    await opts.db.transaction(async (tx) => {
      if (scriptsChanged) {
        const revoked = await tx
          .update(agentSkillAssignments)
          .set({ scriptsAuthorized: false })
          .where(
            and(
              eq(agentSkillAssignments.skillId, existing.id),
              eq(agentSkillAssignments.scriptsAuthorized, true),
            ),
          )
          .returning({ id: agentSkillAssignments.id });
        scriptsAuthorizationRevoked = revoked.length;
      }
      await tx
        .update(agentSkills)
        .set({
          defaultContent: content,
          ...(existing.contentOverridden ? {} : { content }),
          installedScripts,
          updateAvailable: false,
          updateDetail: null,
          lastUpdateCheckAt: now,
          updatedAt: now,
        })
        .where(eq(agentSkills.id, existing.id));
    });

    // Files LAST, only after the DB transaction above has committed.
    await mkdir(opts.skillStoreDir, { recursive: true });
    await rm(localDir, { recursive: true, force: true });
    await cp(skillDirAbs, localDir, {
      recursive: true,
      filter: (src) => !isExcluded(src),
    });

    return { contentChanged, scriptsChanged, scriptsAuthorizationRevoked };
  } finally {
    await cleanup();
  }
}

// ─── acknowledgeSkillUpdate (« keep my version ») ───────────────────────────

export interface AcknowledgeSkillUpdateOptions {
  db: AnyDrizzleDb;
  slug: string;
  /** Entity that must own the skill being acknowledged. */
  entityId: string;
}

export interface AcknowledgeSkillUpdateResult {
  /** True when upstream's SKILL.md still differs — the badge stays for that. */
  contentChanged: boolean;
}

/**
 * Resolve a script 'conflict' (or a stale legacy badge) by KEEPING the local
 * files: re-baseline the ORIGIN hashes to upstream-as-of-now WITHOUT touching
 * a single local file. The next background check then compares upstream to
 * this new baseline — the badge only returns if upstream moves again.
 *
 * Nothing on disk changes, so script authorizations are NOT revoked: the
 * owner keeps running exactly the files they already vetted.
 *
 * `contentChanged` (SKILL.md drift) is deliberately NOT acknowledged here —
 * scripts and content are separate concerns, and hiding a real content update
 * behind a scripts acknowledgment would be a silent skip (invariant #4).
 */
export async function acknowledgeSkillUpdate(
  opts: AcknowledgeSkillUpdateOptions,
): Promise<AcknowledgeSkillUpdateResult> {
  const [existing] = await opts.db
    .select({
      id: agentSkills.id,
      isCommunity: agentSkills.isCommunity,
      source: agentSkills.source,
      defaultContent: agentSkills.defaultContent,
    })
    .from(agentSkills)
    .where(and(eq(agentSkills.slug, opts.slug), eq(agentSkills.entityId, opts.entityId)))
    .limit(1);
  if (!existing) {
    throw new SkillInstallError(`No skill installed with slug "${opts.slug}".`);
  }
  if (!existing.isCommunity || !existing.source) {
    throw new SkillInstallError(
      `Skill "${opts.slug}" is not a community-installed skill and cannot be acknowledged this way.`,
    );
  }

  const source = parseSkillSource(existing.source);
  const { extractRoot, cleanup } = await downloadAndExtract(source);
  try {
    const manifestRel = await pickManifest(extractRoot, source.subdir, source.skillName);
    const skillDirAbs = join(extractRoot, dirname(manifestRel));
    const manifestAbs = join(extractRoot, manifestRel);
    const text = await readFile(manifestAbs, 'utf8');
    const { body } = parseSkillMarkdown(text);

    const isExcluded = await buildNestedSkillExclusion(skillDirAbs);
    const scripts = await detectScripts(skillDirAbs, isExcluded);
    const content = buildContent(opts.slug, body, scripts);
    const contentChanged = content !== (existing.defaultContent ?? '');

    const hashedScripts = await hashScripts(skillDirAbs, scripts);
    const now = new Date();
    await opts.db
      .update(agentSkills)
      .set({
        installedScripts: hashedScripts.length ? hashedScripts : null,
        updateAvailable: contentChanged,
        updateDetail: {
          contentChanged,
          scriptsChanged: false,
          scriptsState: 'local-only',
          checkedAt: now.toISOString(),
        },
        lastUpdateCheckAt: now,
        updatedAt: now,
      })
      .where(eq(agentSkills.id, existing.id));

    return { contentChanged };
  } finally {
    await cleanup();
  }
}
