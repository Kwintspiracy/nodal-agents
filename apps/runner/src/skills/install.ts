// skills/install.ts — orchestrate installing a community skill (open Agent
// Skills / SKILL.md format) into the local DB + skill store.
//
// Flow: parse source → download+extract repo → locate the SKILL.md → parse &
// validate frontmatter → detect bundled scripts → build the skill folder
// beside its place in the store → move it in and insert the agent_skills row
// (is_community=true) in one step. Fail loud at every step; never write a
// half-installed row or a half-copied folder.
//
// An installed skill is the full list of its files (manifest.ts): an update
// compares every file, keeps every file the source did not ship, asks about
// every file changed on both sides, and installing the same source again is
// that same update — never a second path that overwrites.

import { rm, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, basename, sep, resolve } from 'node:path';
import {
  eq,
  and,
  agentSkills,
  agentSkillAssignments,
  type AnyDrizzleDb,
  type SkillFilesState,
  type SkillUpdateDetail,
} from '@nodal-agents/db';
import { systemSkillSlugs } from '@nodal-agents/catalog';
import { COMMUNITY_SKILL_CATALOG } from '@nodal-agents/shared';
import { parseSkillSource, type SkillSource } from './source';
import { downloadAndExtract, findSkillManifests, isFile } from './fetch';
import { parseSkillMarkdown, validateFrontmatter } from './frontmatter';
import { detectScripts, type DetectedScript } from './detect-scripts';
import { countFilesIn, buildNestedSkillExclusion, hashScripts } from './fs-util';
import { SkillInstallError } from './errors';
import {
  readTree,
  toManifest,
  treeHash,
  isCaseInsensitiveDir,
  planSkillFiles,
  restrictPlan,
  resolvePlan,
  opsTouch,
  stageSkillFolder,
  stageFreshSkillFolder,
  swapSkillFolder,
  personFilesOf,
  unswapSkillFolder,
  discardPreviousFolder,
  type FileTree,
  type FileChange,
  type ConflictChoice,
  type SkillFilesPlan,
  type SwappedFolder,
} from './manifest';

export { SkillInstallError };
export type { FileChange, ConflictChoice };

/**
 * The source of an installed skill now serves ANOTHER skill (its SKILL.md
 * declares `upstreamSlug`, not the installed slug). A SkillInstallError like
 * any other refusal; its own class so the background check can record which
 * problem it met (update_detail.sourceProblem = 'identity_changed').
 */
export class SkillIdentityChangedError extends SkillInstallError {
  readonly upstreamSlug: string;
  constructor(installedSlug: string, upstreamSlug: string) {
    super(
      `The installed skill "${installedSlug}" is not at its source any more: the source now ` +
        `serves a skill named "${upstreamSlug}". Nothing was changed.`,
    );
    this.name = 'SkillIdentityChangedError';
    this.upstreamSlug = upstreamSlug;
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
  /**
   * When the store already holds files for this skill (left by an earlier
   * removal that kept the person's files, or by an older version that left
   * the folder): the `upstreamFilesHash` of the review the person read, and
   * their choice for each conflicting file. Without it, such an install
   * returns `status: 'review'` and writes nothing.
   */
  expectedFilesHash?: string;
  conflictChoices?: Readonly<Record<string, ConflictChoice>>;
}

export type InstallSkillResult =
  | {
      status: 'installed';
      slug: string;
      name: string;
      description: string;
      source: string;
      installedScripts: DetectedScript[];
      fileCount: number;
    }
  /**
   * The store already holds files for this skill and no row owns them. They
   * are compared with what the source ships, like an update of a skill
   * installed before the file manifest: nothing was written. Install again
   * with `expectedFilesHash` and a choice for each conflict.
   */
  | {
      status: 'review';
      slug: string;
      name: string;
      description: string;
      source: string;
      installedScripts: DetectedScript[];
      files: FileChange[];
      filesState: SkillFilesState;
      upstreamFilesHash: string;
    }
  /**
   * The same source is already installed for this entity. Nothing was
   * written: installing it again IS an update, and goes through the update
   * review (previewSkillUpdate → applySkillUpdate), with the same rules.
   */
  | {
      status: 'already_installed';
      slug: string;
      name: string;
      description: string;
      source: string;
      updateAvailable: boolean;
      updateDetail: SkillUpdateDetail | null;
      /** The installed skill bundles scripts (installed_scripts non-empty). */
      hasScripts: boolean;
      /** The installed row, for the update review: an edited skill's text is replaced by an update. */
      skillId: string;
      contentOverridden: boolean;
      content: string;
    };

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

/**
 * Read the SKILL.md a source serves today: locate it, parse it, validate its
 * frontmatter. The one reader of an upstream manifest — install goes through
 * it, and so does every path that re-reads the source of an installed skill
 * (readInstalledSkillSource below).
 */
async function readSourceManifest(
  extractRoot: string,
  source: SkillSource,
): Promise<{ skillDirAbs: string; body: string; slug: string; name: string; description: string }> {
  const manifestRel = await pickManifest(extractRoot, source.subdir, source.skillName);
  const text = await readFile(join(extractRoot, manifestRel), 'utf8');
  const { frontmatter, body } = parseSkillMarkdown(text);
  const { slug, name, description } = validateFrontmatter(frontmatter);
  return { skillDirAbs: join(extractRoot, dirname(manifestRel)), body, slug, name, description };
}

/**
 * The same read for a skill ALREADY installed under `installedSlug`: the
 * background update check, the update preview, its apply, and « keep my
 * version ». A source tracks a moving ref, and what it serves today may be
 * another skill (renamed, moved, replaced upstream). That is not an update of
 * the installed skill: taking it would put another skill's text and files
 * behind this row's slug and name. Refuse, naming both slugs, before any
 * caller has written anything.
 */
export async function readInstalledSkillSource(
  extractRoot: string,
  source: SkillSource,
  installedSlug: string,
): Promise<{ skillDirAbs: string; body: string }> {
  const manifest = await readSourceManifest(extractRoot, source);
  if (manifest.slug !== installedSlug) {
    throw new SkillIdentityChangedError(installedSlug, manifest.slug);
  }
  return { skillDirAbs: manifest.skillDirAbs, body: manifest.body };
}

export async function installCommunitySkill(
  opts: InstallSkillOptions,
): Promise<InstallSkillResult> {
  const source = parseSkillSource(opts.source);
  const { extractRoot, cleanup } = await downloadAndExtract(source);

  try {
    const {
      skillDirAbs,
      body,
      slug,
      name: manifestName,
      description,
    } = await readSourceManifest(extractRoot, source);
    // A skill installed from a card of the curated catalog keeps the card's
    // name ("Comfy (official)"), whoever asks for the install: the screen or
    // an agent. Any other source keeps the name its SKILL.md declares.
    // The card vouches for ONE skill: a catalog source tracks a moving branch,
    // and if what it serves today is another skill (moved, renamed, replaced
    // upstream), labelling it with the card's name would be a false statement
    // to the owner and to every agent reading the skill list. Refuse instead.
    const card = COMMUNITY_SKILL_CATALOG.find((e) => e.source === opts.source.trim());
    if (card && card.slug !== slug) {
      throw new SkillInstallError(
        `The catalog card "${card.name}" installs the skill "${card.slug}", but its source now ` +
          `serves a skill named "${slug}". Nothing was installed.`,
      );
    }
    const name = card?.name ?? manifestName;

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

    // Collision handling, scoped to THIS entity — slug is unique per
    // (entity_id, slug), not globally (F-6, audit #2).
    const [existing] = await opts.db
      .select({
        id: agentSkills.id,
        name: agentSkills.name,
        description: agentSkills.description,
        isCommunity: agentSkills.isCommunity,
        source: agentSkills.source,
        updateAvailable: agentSkills.updateAvailable,
        updateDetail: agentSkills.updateDetail,
        installedScripts: agentSkills.installedScripts,
        contentOverridden: agentSkills.contentOverridden,
        content: agentSkills.content,
      })
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, slug), eq(agentSkills.entityId, opts.entityId)))
      .limit(1);

    if (existing) {
      if (!existing.isCommunity || existing.source !== source.raw) {
        throw new SkillInstallError(
          `A skill with slug "${slug}" already exists from a different source. ` +
            `Uninstall it first if you want to replace it.`,
        );
      }
      // Installing the same source again is an update: same review, same
      // rules (files added locally kept, conflicts asked, new scripts not
      // authorized by the old grant). Nothing is written here.
      return {
        status: 'already_installed',
        slug,
        name: existing.name,
        description: existing.description ?? '',
        source: source.raw,
        updateAvailable: existing.updateAvailable,
        updateDetail: existing.updateDetail ?? null,
        hasScripts: (existing.installedScripts ?? []).length > 0,
        skillId: existing.id,
        contentOverridden: existing.contentOverridden === true,
        content: existing.content,
      };
    }

    // Every refusal before the store is touched.
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
    // The manifest: every file the source ships (nested skills excluded).
    const upstream = await readTree(skillDirAbs, isExcluded);

    // Files already in the store for this slug, owned by no row: the same
    // plan as an update with no manifest — every file there is the person's
    // until shown otherwise, kept or chosen, never overwritten unseen.
    const destDir = join(opts.skillStoreDir, slug);
    const destExists = await isDirectory(destDir);
    const local: FileTree = destExists ? await readTree(destDir) : new Map();
    let ops;
    if (local.size > 0) {
      const plan = planSkillFiles({
        local,
        upstream,
        origin: null,
        caseInsensitive: await isCaseInsensitiveDir(opts.skillStoreDir),
      });
      const filesHash = treeHash(upstream);
      if (opts.expectedFilesHash === undefined) {
        return {
          status: 'review',
          slug,
          name,
          description,
          source: source.raw,
          installedScripts: scripts,
          files: plan.changes,
          filesState: plan.state,
          upstreamFilesHash: filesHash,
        };
      }
      if (opts.expectedFilesHash !== filesHash) {
        throw new SkillInstallError(
          `The skill's files changed at its source since you reviewed this install — nothing ` +
            `was installed. Review it again.`,
        );
      }
      ops = resolvePlan(plan, opts.conflictChoices ?? {});
    }

    // Built beside its place, checked, then moved in with the row (one step).
    const staged =
      ops === undefined
        ? await stageFreshSkillFolder({
            storeDir: opts.skillStoreDir,
            slug,
            upstreamDir: skillDirAbs,
            upstream,
          })
        : await stageSkillFolder({
            storeDir: opts.skillStoreDir,
            slug,
            localDir: destDir,
            local,
            upstreamDir: skillDirAbs,
            ops,
          });
    await commitWithFolder({
      db: opts.db,
      storeDir: opts.skillStoreDir,
      slug,
      stagingDir: staged.stagingDir,
      planned: destExists ? local : null,
      writeRows: async (tx) => {
        await tx.insert(agentSkills).values({
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
          installedFiles: toManifest(upstream),
        });
      },
    });

    return {
      status: 'installed',
      slug,
      name,
      description,
      source: source.raw,
      installedScripts: scripts,
      fileCount,
    };
  } finally {
    await cleanup();
  }
}

type SkillTx = Parameters<Parameters<AnyDrizzleDb['transaction']>[0]>[0];

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Write the rows, switch the staged folder in, THEN commit — one step. A
 * failure while switching rolls the rows back; a failure of the commit after
 * the switch puts the previous folder back. Either way the old folder and the
 * old rows are what remains. Returns the previous folder when it could not be
 * removed after a successful commit (see discardPreviousFolder).
 *
 * The rows include the revocation of script authorizations when the switch
 * brings changed scripts, so once the commit is done a script is never on
 * disk under a grant given to another version of it. A process killed between
 * the switch and the commit (one round-trip) leaves the new files under the
 * old rows: the next check then finds each switched file equal to upstream,
 * which reads as nothing to do for that file, never as a local edit.
 */
async function commitWithFolder(opts: {
  db: AnyDrizzleDb;
  storeDir: string;
  slug: string;
  /**
   * The folder to switch in; null with `removeLive` to move the live folder
   * out (a removal); null without it to leave the folder alone.
   */
  stagingDir: string | null;
  removeLive?: boolean;
  /** The live folder as planned; null for a fresh install (no folder may exist). */
  planned: FileTree | null;
  writeRows: (tx: SkillTx) => Promise<void>;
}): Promise<{ leftoverDir: string | null }> {
  const localDir = join(opts.storeDir, opts.slug);
  const state: { swapped: SwappedFolder | null } = { swapped: null };
  try {
    await opts.db.transaction(async (tx) => {
      await opts.writeRows(tx);
      if (opts.stagingDir !== null || opts.removeLive === true) {
        state.swapped = await swapSkillFolder({
          storeDir: opts.storeDir,
          slug: opts.slug,
          localDir,
          stagingDir: opts.stagingDir,
          planned: opts.planned,
        });
      }
    });
  } catch (err) {
    if (state.swapped !== null) await unswapSkillFolder(state.swapped);
    if (opts.stagingDir !== null) await rm(opts.stagingDir, { recursive: true, force: true });
    throw err;
  }
  return { leftoverDir: state.swapped ? await discardPreviousFolder(state.swapped) : null };
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface UninstallSkillOptions {
  db: AnyDrizzleDb;
  slug: string;
  skillStoreDir: string;
  /** Entity that must own the skill being uninstalled. */
  entityId: string;
  /**
   * What happens to the person's files in the folder (files the source did
   * not ship, shipped files changed here — previewSkillRemoval lists them):
   * 'keep' leaves them in the store, where a later install of the same skill
   * finds them and reviews them; 'delete' removes them with the skill.
   * Required when there is at least one such file: the removal refuses,
   * changing nothing, rather than choose for the person.
   */
  localFiles?: 'keep' | 'delete';
}

export interface SkillRemovalPreview {
  /** The person's files in the skill folder, sorted by path. */
  localFiles: FileChange[];
  /** False for a skill installed before the file manifest: which files the
   *  source shipped is unknown, so every file is listed. */
  originKnown: boolean;
}

async function loadRemovableSkill(opts: { db: AnyDrizzleDb; slug: string; entityId: string }) {
  if (!SLUG_RE.test(opts.slug)) {
    throw new SkillInstallError(`Invalid skill slug "${opts.slug}".`);
  }
  // F-6 (audit #2): slug is unique per (entity_id, slug), not globally — an
  // unscoped lookup here would let entity A uninstall (and delete the files
  // of) entity B's same-slug skill.
  const [existing] = await opts.db
    .select({
      id: agentSkills.id,
      isCommunity: agentSkills.isCommunity,
      installedScripts: agentSkills.installedScripts,
      installedFiles: agentSkills.installedFiles,
    })
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
  return existing;
}

async function planRemoval(
  opts: { skillStoreDir: string; slug: string },
  existing: Awaited<ReturnType<typeof loadRemovableSkill>>,
) {
  const localDir = join(opts.skillStoreDir, opts.slug);
  const [local, caseInsensitive] = await Promise.all([
    readTree(localDir),
    isCaseInsensitiveDir(opts.skillStoreDir),
  ]);
  const { plan, files } = personFilesOf({
    local,
    origin: existing.installedFiles,
    legacyScriptOrigins: existing.installedScripts,
    caseInsensitive,
  });
  return { localDir, local, plan, files };
}

/** What removing the skill would do to the person's files — read-only. */
export async function previewSkillRemoval(opts: {
  db: AnyDrizzleDb;
  slug: string;
  skillStoreDir: string;
  entityId: string;
}): Promise<SkillRemovalPreview> {
  const existing = await loadRemovableSkill(opts);
  const { files } = await planRemoval(opts, existing);
  return { localFiles: files, originKnown: existing.installedFiles !== null };
}

/**
 * Remove an installed community skill — the one removal of a community skill,
 * whoever asks (the dashboard's Uninstall and Delete both come here): delete
 * its agent_skills row (assignments cascade via FK) and deal with its folder
 * in the same step as the row, with the discipline of an update:
 *
 *   - 'delete' (or no file of the person's): the folder is moved out by
 *     rename inside the transaction, removed after the commit;
 *   - 'keep': a folder holding only the person's files is built beside the
 *     live one and switched in; the source's untouched files go.
 *
 * A failure at any step leaves the row and the folder as they were. Refuses
 * to touch a non-community skill (system/custom skills have no folder).
 */
export async function uninstallCommunitySkill(
  opts: UninstallSkillOptions,
): Promise<{ keptFiles: string[]; leftoverDir: string | null }> {
  const existing = await loadRemovableSkill(opts);
  const { localDir, local, plan, files } = await planRemoval(opts, existing);
  if (files.length > 0 && opts.localFiles === undefined) {
    throw new SkillInstallError(
      `The folder of "${opts.slug}" holds files that are yours: ` +
        `${files
          .slice(0, 10)
          .map((f) => f.path)
          .join(', ')}${files.length > 10 ? ` and ${files.length - 10} more` : ''}. ` +
        `Choose whether to keep them or delete them with the skill. Nothing was removed.`,
    );
  }
  const keep = files.length > 0 && opts.localFiles === 'keep';
  const deleteRow = async (tx: SkillTx): Promise<void> => {
    await tx.delete(agentSkills).where(eq(agentSkills.id, existing.id));
  };

  if (keep) {
    const keepAll = Object.fromEntries(
      files.filter((f) => f.kind === 'conflict').map((f) => [f.path, 'keep-local' as const]),
    );
    const ops = resolvePlan(plan, keepAll);
    const staged = await stageSkillFolder({
      storeDir: opts.skillStoreDir,
      slug: opts.slug,
      localDir,
      local,
      upstreamDir: localDir, // never read: a removal only deletes
      ops,
    });
    const { leftoverDir } = await commitWithFolder({
      db: opts.db,
      storeDir: opts.skillStoreDir,
      slug: opts.slug,
      stagingDir: staged.stagingDir,
      planned: local,
      writeRows: deleteRow,
    });
    return { keptFiles: files.map((f) => f.path), leftoverDir };
  }

  const { leftoverDir } = await commitWithFolder({
    db: opts.db,
    storeDir: opts.skillStoreDir,
    slug: opts.slug,
    stagingDir: null,
    removeLive: true,
    planned: local,
    writeRows: deleteRow,
  });
  return { keptFiles: [], leftoverDir };
}

// ─── previewSkillUpdate (SKILL-003) ─────────────────────────────────────────

export interface PreviewSkillUpdateResult {
  /** The skill text agents see TODAY — the left side of the diff. */
  currentContent: string;
  /** The skill text that WILL be installed — the right side of the diff. */
  upstreamContent: string;
  contentChanged: boolean;
  /** True when the update writes, removes, or asks about a script. */
  scriptsChanged: boolean;
  /** Bundled script paths detected upstream, for the "scripts will be re-authorized" notice. */
  scriptNames: string[];
  /**
   * Scripts the update brings that the current authorization never covered:
   * new or changed upstream (a conflict included, should the person take the
   * new version). Applying revokes the authorization for every agent; each
   * must be authorized again after review.
   */
  scriptsToAuthorize: string[];
  /**
   * SHA-256 of `upstreamContent`. Hand this back to `applySkillUpdate` as
   * `expectedContentHash`: the apply re-downloads, and if upstream has moved
   * since the preview it REFUSES rather than installing text nobody reviewed.
   */
  upstreamContentHash: string;
  /**
   * Every file whose fate is not "identical everywhere", sorted by path:
   * added / changed / removed upstream (applied), local changes and local
   * additions (kept), conflicts (the person chooses, see `conflictChoices`).
   */
  files: FileChange[];
  filesState: SkillFilesState;
  /** Same role as `upstreamContentHash`, for the upstream files (`expectedFilesHash`). */
  upstreamFilesHash: string;
  /**
   * True when the owner edited the skill locally. The apply replaces their
   * text with `upstreamContent`: the dashboard says so before they confirm,
   * and shows their current text so they can redo their changes.
   */
  contentOverridden: boolean;
}

/**
 * Compute exactly what an update would install, without writing anything to
 * the skill's folder or row.
 *
 * SKILL-003 (audit vague D). The update confirmation used to show a CATEGORY
 * ("Last check found: content changes"), never the text — while that text goes
 * straight into the system prompt of every agent the skill is assigned to. The
 * owner was approving content they had never seen, from a third-party repo:
 * persistent prompt injection with a consent dialog on top.
 *
 * Two halves are needed and this is the first. The second is that the apply
 * must install what was SHOWN: `applySkillUpdate` re-downloads at click time,
 * so the preview alone is a hint, not a promise. `upstreamContentHash` and
 * `upstreamFilesHash` close that gap.
 */
export async function previewSkillUpdate(
  opts: ApplySkillUpdateOptions,
): Promise<PreviewSkillUpdateResult> {
  const existing = await loadUpdatableSkill(opts);
  const source = parseSkillSource(existing.source!);
  const { extractRoot, cleanup } = await downloadAndExtract(source);
  try {
    const u = await planUpdate(opts, existing, extractRoot, source);
    const currentContent = existing.defaultContent ?? '';
    return {
      currentContent,
      upstreamContent: u.resolved.content,
      contentChanged: u.resolved.content !== currentContent,
      scriptsChanged: u.scriptChanges.some(
        (c) => c.kind !== 'kept-local-change' && c.kind !== 'kept-local-addition',
      ),
      scriptNames: u.resolved.scripts.map((s) => s.path),
      scriptsToAuthorize: u.scriptChanges
        .filter((c) => c.kind === 'added' || c.kind === 'changed' || isUpstreamConflict(c, u))
        .map((c) => c.path),
      upstreamContentHash: sha256(u.resolved.content),
      files: u.plan.changes,
      filesState: u.plan.state,
      upstreamFilesHash: treeHash(u.upstream),
      contentOverridden: existing.contentOverridden === true,
    };
  } finally {
    await cleanup();
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A conflict whose "take the new version" writes an upstream file (not a removal). */
function isUpstreamConflict(c: FileChange, u: UpdatePlan): boolean {
  return c.kind === 'conflict' && u.upstream.has(c.path);
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
  /** The preview's `upstreamFilesHash`: same contract, for the files. */
  expectedFilesHash?: string;
  /**
   * One choice per file the preview listed as a conflict, keyed by its path.
   * Required: an apply with a conflict left unchosen refuses and writes
   * nothing, and so does a choice for a file that is no longer in conflict.
   */
  conflictChoices?: Readonly<Record<string, ConflictChoice>>;
}

export interface ApplySkillUpdateResult {
  contentChanged: boolean;
  scriptsChanged: boolean;
  /** Number of agent_skill_assignments rows whose scripts_authorized flipped true→false. */
  scriptsAuthorizationRevoked: number;
  /** The plan that was applied, as the preview listed it. */
  files: FileChange[];
  /**
   * The previous folder, when it could not be removed after the update
   * (Windows keeps a folder that a process still holds). The update is
   * complete; this folder is a leftover the person can delete.
   */
  leftoverDir: string | null;
}

/**
 * Load + validate the skill row an update targets. Shared by preview and apply
 * so the two can never disagree about what is updatable.
 *
 * F-6-shaped scoping (mirrors uninstallCommunitySkill): slug is unique per
 * (entity_id, slug), not globally.
 */
async function loadUpdatableSkill(opts: ApplySkillUpdateOptions): Promise<UpdatableRow> {
  const [existing] = await opts.db
    .select({
      id: agentSkills.id,
      isCommunity: agentSkills.isCommunity,
      source: agentSkills.source,
      defaultContent: agentSkills.defaultContent,
      contentOverridden: agentSkills.contentOverridden,
      installedScripts: agentSkills.installedScripts,
      installedFiles: agentSkills.installedFiles,
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

interface UpdatableRow {
  id: string;
  isCommunity: boolean | null;
  source: string | null;
  defaultContent: string | null;
  contentOverridden: boolean | null;
  installedScripts: Array<{ path: string; language: string; sha256?: string }> | null;
  installedFiles: Array<{ path: string; sha256: string }> | null;
}

/**
 * Locate the manifest in an extracted repo and build the wrapped skill content.
 * Shared by preview and apply so the text the owner READS is produced by the
 * exact same code path as the text that gets INSTALLED.
 */
async function resolveUpstreamContent(
  extractRoot: string,
  source: SkillSource,
  slug: string,
): Promise<{
  skillDirAbs: string;
  scripts: DetectedScript[];
  content: string;
  /** Nested-skill filter, reused by the file tree read. */
  isExcluded: (src: string) => boolean;
}> {
  const { skillDirAbs, body } = await readInstalledSkillSource(extractRoot, source, slug);

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

interface UpdatePlan {
  resolved: Awaited<ReturnType<typeof resolveUpstreamContent>>;
  upstream: FileTree;
  local: FileTree;
  plan: SkillFilesPlan;
  /** The plan restricted to the skill's scripts (upstream's and the installed ones). */
  scriptChanges: ReadonlyArray<FileChange>;
  scriptPaths: string[];
}

/**
 * The one comparison behind the preview, the apply (and, in check-updates.ts,
 * the background check): every file of the live folder against what the
 * source shipped and what it ships today.
 */
async function planUpdate(
  opts: ApplySkillUpdateOptions,
  existing: UpdatableRow,
  extractRoot: string,
  source: SkillSource,
): Promise<UpdatePlan> {
  const resolved = await resolveUpstreamContent(extractRoot, source, opts.slug);
  const localDir = join(opts.skillStoreDir, opts.slug);
  const [upstream, local, caseInsensitive] = await Promise.all([
    readTree(resolved.skillDirAbs, resolved.isExcluded),
    readTree(localDir),
    isCaseInsensitiveDir(opts.skillStoreDir),
  ]);
  const plan = planSkillFiles({
    local,
    upstream,
    origin: existing.installedFiles,
    legacyScriptOrigins: existing.installedScripts,
    caseInsensitive,
  });
  const scriptPaths = [
    ...new Set([
      ...resolved.scripts.map((s) => s.path),
      ...(existing.installedScripts ?? []).map((s) => s.path),
    ]),
  ];
  return {
    resolved,
    upstream,
    local,
    plan,
    scriptChanges: restrictPlan(plan, scriptPaths),
    scriptPaths,
  };
}

/**
 * Apply a pending upstream update to an already-installed community skill —
 * the explicit "apply update" action (POST /api/skills/update), never the
 * throttled background check.
 *
 * - Files: the plan of planUpdate, every file compared. Files the source did
 *   not ship are kept; files changed on both sides follow `conflictChoices`
 *   (required for each). The new folder is built beside the live one,
 *   checked, switched in by rename, and the row is committed after the
 *   switch: a failure at any step leaves the old folder and the old row.
 * - `content` and `defaultContent` both take the freshly wrapped content, and
 *   `contentOverridden` goes false — the owner is on the new version, as for
 *   a system skill's "Reset to default". This holds for an EDITED skill too:
 *   keeping the local text used to leave the owner on it for good, the badge
 *   gone and every later improvement silently skipped. The edit is never
 *   clobbered blind: the update dialog tells the owner it replaces their
 *   changes and shows their text to copy, and only their confirmation (with
 *   the reviewed `expectedContentHash`) reaches this function.
 * - Scripts: when the apply writes or removes a script (recomputed HERE from
 *   the folder as it is now, not from the last check's cache), scripts_
 *   authorized is revoked on every agent×skill assignment, in the same
 *   transaction as the row: a script new or changed upstream is never covered
 *   by a grant given to the old version. A local script patch that is kept
 *   revokes nothing — the owner keeps running the file they vetted.
 */
export async function applySkillUpdate(
  opts: ApplySkillUpdateOptions,
): Promise<ApplySkillUpdateResult> {
  const existing = await loadUpdatableSkill(opts);

  const source = parseSkillSource(existing.source!);
  const { extractRoot, cleanup } = await downloadAndExtract(source);
  try {
    const u = await planUpdate(opts, existing, extractRoot, source);
    const { skillDirAbs, scripts, content } = u.resolved;

    // SKILL-003: install what was REVIEWED, or nothing. This download is a
    // SECOND fetch — the preview the owner read came from an earlier one.
    if (opts.expectedContentHash && sha256(content) !== opts.expectedContentHash) {
      throw new SkillInstallError(
        `Upstream changed since you reviewed this update — nothing was installed. ` +
          `Re-open the update to read the new version before approving it.`,
      );
    }
    if (opts.expectedFilesHash && treeHash(u.upstream) !== opts.expectedFilesHash) {
      throw new SkillInstallError(
        `The skill's files changed upstream since you reviewed this update — nothing was ` +
          `installed. Re-open the update to see what changed before approving it.`,
      );
    }

    const ops = resolvePlan(u.plan, opts.conflictChoices ?? {});
    const scriptsChanged = opsTouch(u.plan, ops, u.scriptPaths);
    const contentChanged = content !== (existing.defaultContent ?? '');
    // Fresh ORIGIN hashes: after an apply, upstream-now IS the new baseline.
    const hashedScripts = await hashScripts(skillDirAbs, scripts);
    const installedScripts = hashedScripts.length ? hashedScripts : null;
    const now = new Date();

    const staged =
      ops.length > 0
        ? await stageSkillFolder({
            storeDir: opts.skillStoreDir,
            slug: opts.slug,
            localDir: join(opts.skillStoreDir, opts.slug),
            local: u.local,
            upstreamDir: skillDirAbs,
            ops,
          })
        : null;

    let scriptsAuthorizationRevoked = 0;
    const { leftoverDir } = await commitWithFolder({
      db: opts.db,
      storeDir: opts.skillStoreDir,
      slug: opts.slug,
      stagingDir: staged?.stagingDir ?? null,
      planned: u.local,
      writeRows: async (tx) => {
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
            content,
            contentOverridden: false,
            installedScripts,
            installedFiles: toManifest(u.upstream),
            updateAvailable: false,
            updateDetail: null,
            lastUpdateCheckAt: now,
            updatedAt: now,
          })
          .where(eq(agentSkills.id, existing.id));
      },
    });

    return {
      contentChanged,
      scriptsChanged,
      scriptsAuthorizationRevoked,
      files: u.plan.changes,
      leftoverDir,
    };
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
 * Resolve a conflict (or a stale legacy badge) by KEEPING the local files:
 * re-baseline the ORIGIN — the file manifest and the script hashes — to
 * upstream-as-of-now WITHOUT touching a single local file. The next check
 * then compares upstream to this new baseline: every local difference reads
 * as the owner's own (kept), and the badge only returns if upstream moves
 * again.
 *
 * Nothing on disk changes, so script authorizations are NOT revoked: the
 * owner keeps running exactly the files they already vetted.
 *
 * `contentChanged` (SKILL.md drift) is deliberately NOT acknowledged here —
 * the text and the files are separate concerns, and hiding a real content
 * update behind a files acknowledgment would be a silent skip (invariant #4).
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
    const { skillDirAbs, body } = await readInstalledSkillSource(extractRoot, source, opts.slug);

    const isExcluded = await buildNestedSkillExclusion(skillDirAbs);
    const scripts = await detectScripts(skillDirAbs, isExcluded);
    const content = buildContent(opts.slug, body, scripts);
    const contentChanged = content !== (existing.defaultContent ?? '');

    const hashedScripts = await hashScripts(skillDirAbs, scripts);
    const upstream = await readTree(skillDirAbs, isExcluded);
    const now = new Date();
    await opts.db
      .update(agentSkills)
      .set({
        installedScripts: hashedScripts.length ? hashedScripts : null,
        installedFiles: toManifest(upstream),
        updateAvailable: contentChanged,
        updateDetail: {
          contentChanged,
          scriptsChanged: false,
          scriptsState: 'local-only',
          filesState: 'local-only',
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
