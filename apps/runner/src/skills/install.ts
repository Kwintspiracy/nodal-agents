// skills/install.ts — orchestrate installing a community skill (open Agent
// Skills / SKILL.md format) into the local DB + skill store.
//
// Flow: parse source → download+extract repo → locate the SKILL.md → parse &
// validate frontmatter → detect bundled scripts → copy the skill folder into
// the store → upsert the agent_skills row (is_community=true). Fail loud at
// every step; never write a half-installed row.

import { cp, rm, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, basename, sep } from 'node:path';
import { eq, agentSkills, type AnyDrizzleDb } from '@nodal-agents/db';
import { parseSkillSource } from './source';
import { downloadAndExtract, findSkillManifests, isFile } from './fetch';
import { parseSkillMarkdown, validateFrontmatter } from './frontmatter';
import { detectScripts, type DetectedScript } from './detect-scripts';
import { countFilesIn } from './fs-util';

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

function buildContent(slug: string, body: string, scripts: DetectedScript[]): string {
  const scriptNote = scripts.length
    ? `This skill bundles ${scripts.length} script file(s) (${scripts
        .map((s) => s.path)
        .join(', ')}). You CANNOT execute scripts here. When an instruction calls for ` +
      `running one, use an equivalent native tool if one exists; otherwise tell the ` +
      `user that step needs script execution, which is not available.`
    : 'You cannot execute scripts in this environment.';
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
    if (await isFile(join(extractRoot, rel))) return rel;
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

    // A repo whose chosen SKILL.md sits at the root may bundle OTHER skills
    // (e.g. a plugins/ mirror shipping its own SKILL.md). Those subtrees belong
    // to a different skill — exclude them from the copy + script scan so we
    // don't duplicate files or report the same script twice.
    const nestedSkillDirs = (await findSkillManifests(skillDirAbs))
      .filter((m) => m !== 'SKILL.md')
      .map((m) => join(skillDirAbs, dirname(m)));
    const isExcluded = (abs: string): boolean =>
      nestedSkillDirs.some((d) => abs === d || abs.startsWith(d + sep));

    const scripts = await detectScripts(skillDirAbs, isExcluded);
    const fileCount = await countFilesIn(skillDirAbs, isExcluded);

    // Collision handling: only overwrite a prior install of the SAME source.
    const [existing] = await opts.db
      .select({
        id: agentSkills.id,
        isCommunity: agentSkills.isCommunity,
        source: agentSkills.source,
      })
      .from(agentSkills)
      .where(eq(agentSkills.slug, slug))
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
    const installedScripts = scripts.length ? scripts : null;

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
  const [existing] = await opts.db
    .select({ id: agentSkills.id, isCommunity: agentSkills.isCommunity })
    .from(agentSkills)
    .where(eq(agentSkills.slug, opts.slug))
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
