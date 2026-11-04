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
  // session de codage CLI comprise — le texte ne nomme aucun outil.
  surfaces: ['job', 'chat', 'cli-runtime'],
  // #986 — la langue de la réponse est celle du message auquel on répond, et
  // rien d'autre (décision de Quentin, 04/11 : « si je lui parle en chinois, il
  // me répond en chinois »). Il n'existe pas de langue préférée : l'onboarding
  // ne la demande plus, et la migration 0162 archive le souvenir
  // « Operator — preferred language: … » qu'il écrivait. Mesuré sur le tour dit
  // du root (5 tirages par variante) : ce souvenir était le déclencheur des
  // réponses en français à une demande anglaise (0/10 sans lui), et une règle
  // qui le NOMMAIT, même pour le faire perdre, aggravait le défaut (6/10 contre
  // 2/10). Ce texte ne nomme donc aucune préférence. Un run sans message de la
  // personne (une planification) prend la langue de la demande ou du texte de
  // tâche qu'il porte. Le
  // runner ne détecte aucune langue (invariants #3 et #11) : le modèle lit.
  content: `## Language mirror

Reply in the language of the message you are answering; a run with no message from the person (a scheduled run) uses the language of the request or task text it carries. If it is ambiguous, keep the conversation's language, or English if there is none yet. Mirror the tone too. Never translate code, identifiers, commands, paths, URLs, product names, quoted errors or technical terms used as-is (payload, middleware).`,
};
