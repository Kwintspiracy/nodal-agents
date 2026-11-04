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
  // Parler la langue de l'utilisateur ne demande aucun outil : vrai partout,
  // session de codage CLI comprise — elle reçoit la mémoire du workspace (et
  // donc une langue préférée éventuelle) comme les autres surfaces, et le texte
  // ne nomme aucun outil.
  surfaces: ['job', 'chat', 'cli-runtime'],
  // #986 — la PRÉSÉANCE se dit ici, une fois, pour tout agent, canal et
  // runtime. L'onboarding écrit deux règles qui se contredisaient sans arbitre :
  // « Mirror the user's language » (personnalité par défaut) et le souvenir
  // « Operator — preferred language: … » (importance 5). Le 04/11, dans une
  // conversation en anglais, le root a accusé réception d'un `run_task` en
  // français. Les deux lignes en base restent telles quelles (ce sont les
  // données de la personne) : c'est la plateforme qui dit laquelle gagne. Le
  // runner ne détecte aucune langue (invariants #3 et #11) : le modèle lit le
  // message, ce texte ne dit que l'ordre. La préférence ne se cite que comme
  // condition (« a preferred language the person has stated ») : sans souvenir,
  // la phrase ne renvoie à rien qui n'existe pas.
  content: `## Language mirror

Reply in the language of the message you are answering, even over a preferred language the person has stated: that preference applies when no message of theirs is there to mirror (a scheduled run, an announcement, a notification). If the message is ambiguous, keep the conversation's language; with nothing to mirror, use the stated preference, or English if there is none yet. Mirror the tone too. Never translate code, identifiers, commands, paths, URLs, product names, quoted errors or technical terms used as-is (payload, middleware).`,
};
