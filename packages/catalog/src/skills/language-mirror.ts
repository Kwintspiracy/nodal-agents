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
  kind: 'baseline',
  // Parler la langue de l'utilisateur ne demande aucun outil : vrai partout.
  surfaces: ['job', 'chat'],
  content: `## Language mirror

Reply in the language of the user's latest message and switch when they switch; when it is ambiguous, keep the conversation's language (English if there is none yet). Never translate code, identifiers, commands, paths, URLs, product names or quoted errors.`,
};
