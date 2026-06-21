/**
 * gen-reference.ts — generate the "Reference" docs section from the live product
 * catalog. Run before `next dev` / `next build` (see package.json scripts).
 *
 * The catalog (@nodal-agents/catalog) is the SINGLE SOURCE OF TRUTH for the
 * system skills shipped with every install. By generating the reference pages
 * from it at build time, the docs can never drift from what the product actually
 * ships — change a skill in the catalog, the docs regenerate. This is the
 * "dynamic" half of the documentation.
 *
 * Pages are written as `.md` (NOT `.mdx`): the skill content is arbitrary
 * Markdown authored for LLM prompts and contains `{ }` (JSON examples) and
 * `<placeholder>` tokens that would break the MDX compiler. In `.md` mode MDX
 * expression/JSX parsing is off (`{` is literal), and we escape `<` outside code
 * spans so `<step>` renders as text instead of being eaten as an HTML tag. The
 * result is the skill rendered as real formatted docs — headings, tables, lists.
 *
 * Output (content/docs/reference/, gitignored — regenerated each build):
 *   reference/meta.json           — Reference section nav
 *   reference/index.mdx           — Reference landing page
 *   reference/skills/meta.json    — Skills sub-section nav (one entry per skill)
 *   reference/skills/<slug>.md    — one page per system skill
 *
 * Connectors + MCP will be added here once their catalogs are lifted into a
 * shared package (they currently live inside apps/web).
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemSkills, type SystemSkill } from '@nodal-agents/catalog';

const here = dirname(fileURLToPath(import.meta.url));
const refDir = join(here, '..', 'content', 'docs', 'reference');
const systemSkillsDir = join(refDir, 'system-skills');

// Idempotent: wipe + recreate so removed catalog entries don't leave stale pages.
if (existsSync(refDir)) rmSync(refDir, { recursive: true, force: true });
mkdirSync(refDir, { recursive: true });

/** One-line, frontmatter-safe (JSON-quoted = valid YAML double-quoted scalar). */
const fm = (v: string): string => JSON.stringify(v.replace(/\s+/g, ' ').trim());

/**
 * Neutralise raw `<tag>` tokens that CommonMark would parse as HTML (swallowing
 * the following text), but ONLY outside code spans/fences — inside code, `<` is
 * already literal and must be left untouched. Splitting on a capturing group
 * keeps the code segments at odd indices.
 */
const escapeAnglesOutsideCode = (md: string): string =>
  md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/</g, '&lt;')))
    .join('');

// ── Reference landing + nav ────────────────────────────────────────────────────
writeFileSync(
  join(refDir, 'meta.json'),
  JSON.stringify({ title: 'Reference', pages: ['index', 'system-skills', 'skills'] }, null, 2) +
    '\n',
);
writeFileSync(
  join(refDir, 'index.mdx'),
  `---
title: Reference
description: Auto-generated reference for everything Nodal-Agents ships with.
---

This section is generated from the product catalog at build time, so it can
never drift from what your install actually contains.

## System skills

The [system skills](/docs/reference/system-skills) shipped in
\`@nodal-agents/catalog\` and seeded into every install — the reusable
capabilities and disciplines you can assign to any agent. Each page shows what
the skill does, which tools it unlocks, and the exact guidance it injects into
the agent's system prompt. A few are agent-internal (loaded on demand via
\`skill_view\`, hidden from the dashboard) and marked as such.

## Skills

[Community skills](/docs/reference/skills) — install any open \`SKILL.md\` from
GitHub, skills.sh, ClawHub, Anthropic, OpenAI, or Hermes. These aren't shipped
with the product; you add them to your own install.
`,
);

// ── One page per skill, split into two sections ─────────────────────────────────
// "Skills" = user-facing assignable capabilities. "System skills" = agent-internal
// guides (loaded on demand via skill_view, hidden from the dashboard library).
// ALL skills are listed — just grouped.
const renderPage = (skill: SystemSkill): string => {
  const unlocks =
    skill.requiredBuiltins && skill.requiredBuiltins.length > 0
      ? `\n**Unlocks tools:** ${skill.requiredBuiltins.map((b) => '`' + b + '`').join(', ')}`
      : '';
  const internalNote = skill.agentInternal
    ? `\n**Agent-internal:** loaded on demand by an agent via \`skill_view\` (not shown in the dashboard skill library, not user-assigned).`
    : '';
  return `---
title: ${fm(skill.name)}
description: ${fm(skill.description)}
---

${skill.description}

**Slug:** \`${skill.slug}\`${unlocks}${internalNote}

> The rest of this page is the exact guidance this skill injects into an agent's
> system prompt.

---

${escapeAnglesOutsideCode(skill.content.trim())}
`;
};

/** Write one section folder (pages + nav meta.json), return the slugs written. */
const writeSection = (dir: string, title: string, list: SystemSkill[]): string[] => {
  mkdirSync(dir, { recursive: true });
  const slugs = list.map((s) => s.slug);
  for (const skill of list) writeFileSync(join(dir, `${skill.slug}.md`), renderPage(skill));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ title, pages: slugs }, null, 2) + '\n');
  return slugs;
};

// "System skills" = EVERY shipped catalog skill (they are all system-provided).
// The agent-internal ones (tool-* meta-tool guides) stay in this list and are
// individually marked "Agent-internal".
const sysSlugs = writeSection(systemSkillsDir, 'System skills', systemSkills);

// "Skills" = community / installable skills. These are NOT in the catalog (they
// are fetched per-install from any open SKILL.md), so there is nothing to
// auto-generate — this is a single hand-written guide page.
writeFileSync(
  join(refDir, 'skills.mdx'),
  `---
title: Skills
description: Install community skills from any open SKILL.md — GitHub, skills.sh, ClawHub, Anthropic, OpenAI, Hermes.
---

Beyond the [system skills](/docs/reference/system-skills) that ship with every
install, you can add **community skills**: any project that publishes an open
\`SKILL.md\` (the Agent Skills format). They are fetched at runtime, stored under
\`~/.nodalai/skills/\`, and assigned to agents just like system skills.

## Where to find them

- **[skills.sh](https://www.skills.sh/)** — a directory of community skills.
- **GitHub** — paste any repo URL (or \`owner/repo\`) that contains a \`SKILL.md\`.
- **ClawHub** — community skill registry.
- **Anthropic / OpenAI / Hermes** — many published skills work as-is. A large set
  is catalogued in the [Hermes skills docs](https://hermes-agent.nousresearch.com/docs/skills).

## How to install

In the dashboard, open **Skills → Install community skill** and paste the source
(a GitHub URL, an \`owner/repo\`, or a skills.sh path). Nodal fetches the archive,
locates the \`SKILL.md\`, validates its frontmatter, and stores the skill with
\`is_community = true\` and its source URL.

## Skills that bundle scripts

Some community skills (Hermes-style) bundle \`.py\` / \`.sh\` scripts. Nodal detects
them on install and lists them, but **never runs anything automatically**. To let
an agent execute a skill's scripts, assign the **command-execution** system skill
and authorize the scripts for that agent — the runner gates execution behind
\`run_skill_script\` + your approval.
`,
);

console.log(
  `[gen-reference] wrote ${sysSlugs.length} system skills + the community skills page`,
);
