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
import { systemSkills } from '@nodal-agents/catalog';

const here = dirname(fileURLToPath(import.meta.url));
const refDir = join(here, '..', 'content', 'docs', 'reference');
const skillsDir = join(refDir, 'skills');

// Idempotent: wipe + recreate so removed catalog entries don't leave stale pages.
if (existsSync(refDir)) rmSync(refDir, { recursive: true, force: true });
mkdirSync(skillsDir, { recursive: true });

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
  JSON.stringify({ title: 'Reference', pages: ['index', 'skills'] }, null, 2) + '\n',
);
writeFileSync(
  join(refDir, 'index.mdx'),
  `---
title: Reference
description: Auto-generated reference for everything Nodal-Agents ships with.
---

This section is generated from the product catalog at build time, so it can
never drift from what your install actually contains.

## Skills

The [system skills](/docs/reference/skills) shipped with every install — the
reusable capabilities you can assign to any agent. Each page shows what the
skill does, which tools it unlocks, and the exact guidance it injects into the
agent's system prompt.
`,
);

// ── One page per system skill ──────────────────────────────────────────────────
const slugs: string[] = [];
for (const skill of systemSkills) {
  slugs.push(skill.slug);

  const unlocks =
    skill.requiredBuiltins && skill.requiredBuiltins.length > 0
      ? `\n**Unlocks tools:** ${skill.requiredBuiltins.map((b) => '`' + b + '`').join(', ')}`
      : '';

  const page = `---
title: ${fm(skill.name)}
description: ${fm(skill.description)}
---

${skill.description}

**Slug:** \`${skill.slug}\`${unlocks}

> The rest of this page is the exact guidance this skill injects into an agent's
> system prompt — assign the skill and the agent is told the following.

---

${escapeAnglesOutsideCode(skill.content.trim())}
`;
  writeFileSync(join(skillsDir, `${skill.slug}.md`), page);
}

writeFileSync(
  join(skillsDir, 'meta.json'),
  JSON.stringify({ title: 'Skills', pages: slugs }, null, 2) + '\n',
);

console.log(`[gen-reference] wrote ${slugs.length} skill pages → content/docs/reference/skills/`);
