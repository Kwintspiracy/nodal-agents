// catalog/skills/markdown-output.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const markdownOutputSkill: SystemSkill = {
  slug: 'markdown-output',
  name: 'Markdown output',
  description:
    'Formats longer responses with clean, readable markdown: headings, lists, tables, fenced code blocks. Knows when plain prose is better.',
  requiredBuiltins: [],
  kind: 'channel',
  content: `## Markdown output

Use markdown to make responses scannable and useful. Apply structure where it genuinely helps; do not apply it reflexively.

### When to use structure

- **Headings (\`##\`, \`###\`):** Use for responses with two or more distinct sections. Do not use for answers that are one cohesive thought.
- **Bullet lists:** Use for enumerations of 3+ parallel items where order does not matter. Do not use for flowing prose or narrative reasoning.
- **Numbered lists:** Use for ordered steps, sequences, or ranked items.
- **Tables:** Use to compare multiple items across multiple attributes. Do not use for a single attribute or for two items — a sentence is clearer.
- **Bold (\`**text**\`):** Use to highlight key terms, important caveats, or decision points. Limit to 2–4 instances per section; overuse renders it meaningless.
- **Italics (\`*text*\`):** Use sparingly for emphasis or introducing a defined term.

### Code fences — always add a language tag

\`\`\`typescript
// Always specify the language after the opening backticks:
//   \`\`\`typescript, \`\`\`python, \`\`\`sql, \`\`\`bash, \`\`\`json, \`\`\`yaml …
\`\`\`

Even for short snippets, add the language tag. It enables syntax highlighting and signals intent.

For terminal commands, use \`\`\`bash\`. For generic output or logs with no language, use \`\`\`text\`.

### When NOT to use markdown

- Short answers (1–3 sentences): plain prose. A bullet list for two items is noisier than a sentence.
- Conversational exchanges: direct acknowledgment of a question needs no heading.
- Inline code references: use backticks (\`variableName\`), not a full fenced block.
- Telegram or SMS delivery channels: prefer plain text with minimal formatting (the Telegram skill overrides this if both are active).

### Anti-patterns

- ❌ A heading for every paragraph — turns a response into a bureaucratic document.
- ❌ Nesting bullets 3+ levels deep — restructure into sections instead.
- ❌ Bold nearly everything — destroys the contrast that makes bold useful.
- ❌ A table to show a single column of values — use a list.
- ❌ Markdown in file content that will be rendered literally (e.g. a plain-text config) — emit raw text.
`,
};
