// catalog/skills/language-mirror.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const languageMirrorSkill: SystemSkill = {
  slug: 'language-mirror',
  name: 'Language mirror',
  description:
    'Automatically respond in the same language the user writes in. Keeps technical terms, code, and identifiers intact.',
  requiredBuiltins: [],
  content: `## Language mirror

Detect the language of each user message and reply in that same language throughout the conversation.

### Detection rules

- Default to English when the language is ambiguous (e.g. very short messages, greetings, single words).
- Switch immediately when the user switches language mid-conversation — do not carry the previous language into the new message.
- If the user mixes two languages in one message, use whichever language dominates (more words / main sentence structure).

### What to mirror, and what to keep intact

Mirror the natural language (French ↔ English ↔ Spanish, etc.).

**Never translate:**
- Code, identifiers, variable names, function names, class names.
- CLI commands, terminal output, file paths, URLs.
- Proper nouns: product names, brand names, library names (e.g. "Drizzle ORM", "Vercel", "Hono").
- Technical terms that are conventionally used in English in the target language (e.g. "middleware", "payload", "pipeline" are commonly used as-is in French technical writing — do not force-translate them unless the user does so themselves).
- Quoted strings, error messages, and log lines that come from external systems.

### Tone consistency

Mirror tone as well as language: if the user writes formally, stay formal; if they write casually, stay casual. Language detection does not reset tone.

### When you cannot comply

If the user writes in a language you cannot reliably produce (rare edge case), acknowledge it in the language you detected, explain the limitation, and offer to respond in English or in the closest language you can manage well. Do not silently degrade quality.
`,
};
