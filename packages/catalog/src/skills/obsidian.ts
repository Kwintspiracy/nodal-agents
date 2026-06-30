// catalog/skills/obsidian.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const obsidianSkill: SystemSkill = {
  slug: 'obsidian',
  name: 'Obsidian',
  description: 'Read, search, create, and edit notes in the Obsidian vault.',
  requiredBuiltins: [],
  content: `Skill for working on an Obsidian vault via the filesystem: read, list, search, create, edit notes, with full mastery of the Obsidian Flavored Markdown syntax.

### Setup

The Obsidian vault IS this agent's workspace (configured on the dashboard side: Agents → Edit → Workspace root path). All the paths you pass to \`file_*\` are **relative** to the vault root. Never pass absolute paths, don't include the vault path.

If a \`file_*\` returns \`workspace_not_configured\`, ask the user to configure the workspace in the dashboard.

### ⚠️ STEP 1 MANDATORY — Inspect what already exists BEFORE writing

A delegation may have been launched several times (a previous call may have failed AFTER having written a file — you have no memory of those attempts). Before ANY \`file_write\` on a writing task:

1. **\`file_list({ glob: "*.md", recursive: true })\`** to see what exists in the vault (or target the relevant subfolder: \`file_list({ path: "Cosmology", glob: "*.md" })\`).
2. If a file resembling your target already exists (same topic, same nearby folder, recently created):
   - **\`file_read\`** to check its content.
   - If the content is complete and already answers the task → **DO NOT RE-WRITE**. Reply to the user referencing the existing file + call \`return_result{status:'success'}\` directly.
   - If the content is partial/incomplete → **\`file_edit\`** or **\`file_write\`** on the SAME path (not a new file with a slightly different name). Better: enrich what exists rather than rewriting everything.
3. Otherwise (nothing equivalent exists): continue the normal research + writing workflow.

This step costs 1-2 turns and avoids polluting the vault with duplicates when a previous attempt failed after file_write but before return_result.

### ⚠️ Research → vault workflow (CRITICAL — avoid the loop)

When you do a web search (\`firecrawl_search\` / \`firecrawl_scrape\`) AND the task asks to write into the vault:

1. **MANDATORY Step 1 above:** \`file_list\` + possibly \`file_read\` to see whether a draft already exists.
2. **Do the research in a MAX of 4-6 turns** (1-2 search + 2-4 targeted scrape). Do not exceed this.
3. **AS SOON AS you have enough material, call \`file_write\` IMMEDIATELY.** Not later. Not after save_memory. Not after "one more search to double-check".
4. **AFTER \`file_write\`:** OPTIONALLY a single short \`save_memory\` (max 200 chars, like "I wrote X.md in the vault about Y"). NOT the content of the research.
5. **Finish:** \`telegram_send_message\` (if jobContext.telegram_chat_id) + \`return_result{status:'success'}\` in the same turn.

### ❌ Anti-patterns to ABSOLUTELY AVOID

- ❌ **Writing a new file with a slightly different name** (\`Note v2.md\`, \`Note (2).md\`, \`Note-final.md\`) instead of enriching the existing one found in Step 1 → the vault gets polluted with near-identical duplicates.
- ❌ \`save_memory\` several times with the research content → memory is for DURABLE FACTS about the user, not for storing research summaries. The summary goes in the \`.md\` file, not in memory.
- ❌ \`mark_memory_outdated\` in a loop to "update" memory → if you find yourself calling this tool more than once on the same topic in a job, **stop, you are in a loop, call file_write now**.
- ❌ Saying "I saved it in the vault" via \`save_memory\` WHEN you have not called \`file_write\`. That is lying — the user will see nothing in their vault.
- ❌ Continuing to scrape more pages "to be exhaustive" after 5+ scrapes. You have what you need. Write.
- ❌ Skipping Step 1 "because you think it's a new task" → do the \`file_list\` anyway. Cost: 1 turn, benefit: zero duplicates.

### Read a note

\`file_read({ path: "Daily/2026-05-16.md" })\` — returns the content with line numbers + pagination. For long notes, use \`offset\` and \`limit\`.

### List the notes

- \`file_list({ glob: "*.md", recursive: true })\` — all notes
- \`file_list({ path: "Projects", glob: "*.md" })\` — subfolder
- \`file_list({ path: "." })\` — top-level structure

### Search

- \`file_search({ target: "files", pattern: "regex" })\` — by filename
- \`file_search({ pattern: "regex", file_glob: "*.md" })\` — by content (default)

Auto-skip of \`.git\` / \`.obsidian\` / \`node_modules\`.

### Create a note (the central act)

\`file_write({ path: "Cosmology/Cosmic Microwave Background 2026.md", content: "# Title\\n\\n## Section 1\\n...", create_dirs: true })\`

Atomic write (tempfile + rename). \`create_dirs: true\` creates the missing parent folders. **This is the tool that materializes the result of your work in the vault** — without this call, your work shows up nowhere.

**Reminder**: don't create a file without having done Step 1 (\`file_list\` to check what already exists).

### Edit a note (targeted change)

\`file_edit({ path: "Note.md", old_string: "...", new_string: "..." })\` — exact quote (whitespace included). Multiple matches → fail loud (pass \`replace_all: true\` or narrow it). No match → re-read the file first.

### Append to a note

Two approaches: (1) **anchored** via \`file_edit\` with a stable anchor as \`old_string\` + anchor + new content as \`new_string\`. (2) **full rewrite**: \`file_read\` then \`file_write\` with the concatenated content.

### Path anti-patterns

- ❌ Absolute path (\`D:\\...\\foo.md\`) — the workspace already scopes you, just write \`foo.md\`.
- ❌ \`..\` that goes outside the vault → \`path_traversal_blocked\` returned.
- ❌ Reading large notes in full → paginate with \`offset\` / \`limit\`.

---

## Reference — Obsidian Flavored Markdown (kepano/obsidian-skills)

Obsidian extends CommonMark + GFM with wikilinks, embeds, callouts, properties, comments and other syntaxes. Reference to open when you write a structured note for Quentin.

### Note creation workflow

1. **YAML frontmatter** at the start (properties: title, tags, aliases). See the "Properties" section below.
2. **Content** in standard markdown + the Obsidian syntaxes below.
3. **Link** the related notes via wikilinks (\`[[Note]]\`); markdown links (\`[text](url)\`) ONLY for external URLs.
4. **Embed** other notes/images/PDFs via \`![[embed]]\`.
5. **Callouts** for highlighted info via \`> [!type]\`.
6. **Check** that the note renders correctly in Obsidian reading view.

> Wikilinks vs Markdown links: \`[[wikilinks]]\` for vault notes (Obsidian tracks renames automatically), \`[text](url)\` ONLY for external URLs.

### Internal Links (Wikilinks)

\`\`\`markdown
[[Note Name]]                          Link to note
[[Note Name|Display Text]]             Custom display text
[[Note Name#Heading]]                  Link to heading
[[Note Name#^block-id]]                Link to block
[[#Heading in same note]]              Same-note heading link
\`\`\`

Define a block ID by appending \`^block-id\` to any paragraph:

\`\`\`markdown
This paragraph can be linked to. ^my-block-id
\`\`\`

For lists and quotes, place the block ID on a separate line after the block:

\`\`\`markdown
> A quote block

^quote-id
\`\`\`

### Embeds (full reference)

Prefix a wikilink with \`!\` to embed its content inline.

\`\`\`markdown
![[Note Name]]                         Embed full note
![[Note Name#Heading]]                 Embed section
![[Note Name#^block-id]]               Embed block

![[image.png]]                         Embed image
![[image.png|300]]                     Embed image (width only, aspect ratio preserved)
![[image.png|640x480]]                 Embed image (width × height)

![Alt text](https://example.com/img.png)         External image
![Alt text|300](https://example.com/img.png)     External image with width

![[audio.mp3]]                         Embed audio (mp3, ogg)
![[document.pdf]]                      Embed PDF
![[document.pdf#page=3]]               Embed PDF page
![[document.pdf#height=400]]           Embed PDF with height

![[Note#^list-id]]                     Embed a list with block ID
\`\`\`

Embed search results:

\`\`\`\`markdown
\`\`\`query
tag:#project status:done
\`\`\`
\`\`\`\`

### Callouts (full reference)

\`\`\`markdown
> [!note]
> Basic callout.

> [!warning] Custom Title
> Callout with a custom title.

> [!faq]- Collapsed by default
> Foldable callout (- collapsed, + expanded).

> [!question] Outer callout
> > [!note] Inner callout
> > Nested content
\`\`\`

Supported types (with aliases):

| Type | Aliases | Color / icon |
|------|---------|-----------------|
| \`note\` | — | Blue, pencil |
| \`abstract\` | \`summary\`, \`tldr\` | Turquoise, clipboard |
| \`info\` | — | Blue, info |
| \`todo\` | — | Blue, checkbox |
| \`tip\` | \`hint\`, \`important\` | Cyan, flame |
| \`success\` | \`check\`, \`done\` | Green, ✓ |
| \`question\` | \`help\`, \`faq\` | Yellow, ? |
| \`warning\` | \`caution\`, \`attention\` | Orange, ⚠ |
| \`failure\` | \`fail\`, \`missing\` | Red, ✗ |
| \`danger\` | \`error\` | Red, ⚡ |
| \`bug\` | — | Red, bug |
| \`example\` | — | Purple, list |
| \`quote\` | \`cite\` | Gray, " |

### Properties / Frontmatter (full reference)

\`\`\`yaml
---
title: My Note Title
date: 2024-01-15
tags:
  - project
  - important
aliases:
  - My Note
  - Alternative Name
cssclasses:
  - custom-class
status: in-progress
rating: 4.5
completed: false
due: 2024-02-01T14:30:00
---
\`\`\`

Property types:

| Type | Example |
|------|---------|
| Text | \`title: My Title\` |
| Number | \`rating: 4.5\` |
| Checkbox | \`completed: true\` |
| Date | \`date: 2024-01-15\` |
| Date & Time | \`due: 2024-01-15T14:30:00\` |
| List | \`tags: [one, two]\` or YAML list |
| Links | \`related: "[[Other Note]]"\` |

Default properties:
- \`tags\` — searchable, appears in graph view
- \`aliases\` — alternative names (used for link suggestions)
- \`cssclasses\` — CSS classes applied to the note

### Tags

\`\`\`markdown
#tag                    Inline tag
#nested/tag             Nested tag with hierarchy
#tag-with-dashes
#tag_with_underscores
\`\`\`

Tags can contain: letters (any language), digits (not as the first character), underscores \`_\`, hyphens \`-\`, slashes \`/\` (nesting). Also definable in frontmatter under \`tags\`.

### Comments (hidden in reading view)

\`\`\`markdown
This is visible %%but this is hidden%% text.

%%
This entire block is hidden in reading view.
%%
\`\`\`

### Highlight

\`\`\`markdown
==Highlighted text==
\`\`\`

### Math (LaTeX)

\`\`\`markdown
Inline: $e^{i\\pi} + 1 = 0$

Block:
$$
\\frac{a}{b} = c
$$
\`\`\`

### Diagrams (Mermaid)

\`\`\`\`markdown
\`\`\`mermaid
graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Do this]
    B -->|No| D[Do that]
\`\`\`
\`\`\`\`

To link Mermaid nodes to Obsidian notes: add \`class NodeName internal-link;\`.

### Footnotes

\`\`\`markdown
Text with a footnote[^1].

[^1]: Footnote content.

Inline footnote.^[This is inline.]
\`\`\`

### Full example (reusable as a template)

\`\`\`\`markdown
---
title: Project Alpha
date: 2024-01-15
tags:
  - project
  - active
status: in-progress
---

# Project Alpha

This project aims to [[improve workflow]] using modern techniques.

> [!important] Key Deadline
> The first milestone is due on ==January 30th==.

## Tasks

- [x] Initial planning
- [ ] Development phase
  - [ ] Backend implementation
  - [ ] Frontend design

## Notes

The algorithm uses $O(n \\log n)$ sorting. See [[Algorithm Notes#Sorting]] for details.

![[Architecture Diagram.png|600]]

Reviewed in [[Meeting Notes 2024-01-10#Decisions]].
\`\`\`\`

Reference source: https://help.obsidian.md/obsidian-flavored-markdown · Credit kepano/obsidian-skills
`,
};
