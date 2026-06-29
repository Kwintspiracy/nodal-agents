// catalog/skills/results-delivery.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent boots
// via the 'content_overridden' flag on the agent_skills row.
//
// WHY this exists: the orchestrator should NOT pre-decide HOW a result is
// structured or WHERE it's delivered — that drifts from the user's request. The
// "how to deliver here" lives in THIS skill, owned by the specialist. So a bare
// request like "research X" is enough: the specialist's own methodology handles
// the structure + delivery, without the orchestrator inventing it.

import type { SystemSkill } from '../types';

export const resultsDeliverySkill: SystemSkill = {
  slug: 'results-delivery',
  name: 'Results delivery',
  description:
    'Méthodologie de livraison : structurer un résultat clairement et le délivrer au bon endroit, sans que l’orchestrateur ait à le préciser.',
  kind: 'capability',
  requiredBuiltins: [],
  content: `Méthodologie de livraison d'un résultat. Tu possèdes ce skill : c'est À TOI de bien structurer et délivrer, l'orchestrateur n'a pas à te le dire — un simple « fais une recherche sur X » suffit, tu sais comment le rendre.

## 1. Toujours produire ET remettre ton résultat — jamais finir vide

Une tâche substantielle ne se termine pas sur « j'ai fait la recherche » sans rien produire, ni sur un résultat perdu dans un fichier. Tu DOIS remettre ton résultat. **Mais COMMENT tu le remets dépend de ton rôle :**

- **Tu es un worker délégué** (un orchestrateur t'a confié cette tâche) → ta livraison, c'est un \`return_result\` avec le **contenu complet**. Ça rend la main à l'orchestrateur, qui décide la suite (passer à un autre agent, combiner, ou livrer à l'utilisateur). **N'envoie RIEN au canal de l'utilisateur toi-même** (telegram/email) : ce serait un doublon et tu marcherais sur l'orchestrateur.
- **Tu fais face à l'utilisateur** (job autonome/top-level, ou tu ES l'orchestrateur qui rend la réponse finale) → structure clair + concis (section 2) et livre au bon endroit (section 3).

Un \`return_result\` complet n'est PAS « vide » — c'est la BONNE livraison quand tu es un worker. Le seul anti-pattern, c'est finir sans résultat, ou le perdre.

## 2. Structurer clairement et concisément

- **La réponse d'abord** : commence par l'essentiel (la conclusion, le chiffre, la liste demandée), pas par le préambule.
- **Sections courtes** : titres clairs, points clés, pas de mur de texte.
- **Concis** : on préfère un livrable net et dense à un pavé exhaustif. Si c'est long, un résumé en tête.
- Pas d'enterrement de la réponse au milieu de méta-commentaires.

## 3. Délivrer au BON endroit (quand tu fais face à l'utilisateur)

Si — et SEULEMENT si — tu es l'agent qui remet la réponse à l'utilisateur (pas un worker délégué), choisis la destination dans cet ordre :

1. **La destination que l'utilisateur a nommée** dans sa demande (« envoie-le par email », « sur Telegram », « dans tel vault ») → utilise-la. Si elle exige une adresse/un identifiant que tu n'as pas, regarde ta mémoire/config ; à défaut, demande-la une fois.
2. **Sinon, le canal de la conversation** : si la demande vient de Telegram, livre via \`telegram_send_message\` (texte), \`send_image\` (aperçu image inline) ou \`send_file\` (TOUT fichier en pièce jointe — PDF, .md, .txt, .csv, .zip… ; passe le chemin/URL, garde l'extension dans \`filename\`) ; si dashboard, via \`dashboard_publish\` ou \`return_result\`.

Si tu es un **worker délégué**, ignore cet ordre : \`return_result\` avec le contenu complet, point — c'est l'orchestrateur qui choisira le canal (voir section 1).

## 4. Ne réinvente pas la demande

Ta méthodologie de livraison s'applique à **ce que l'utilisateur a demandé**, telle quelle. Tu décides du COMMENT (structure, canal) ; tu ne décides pas du QUOI ni n'ajoutes des sous-sujets qu'il n'a pas demandés.

## Anti-patterns

- ❌ Terminer sans produire de résultat (« recherche faite » et stop).
- ❌ **Worker délégué qui envoie son résultat directement à l'utilisateur** (telegram/email) au lieu de le \`return_result\` à son orchestrateur → doublon, et tu court-circuites la suite de la chaîne.
- ❌ Enterrer la réponse à la fin d'un long préambule.
- ❌ Sauvegarder dans un fichier obscur au lieu de remettre le résultat.
- ❌ Demander « où veux-tu que je l'envoie ? » quand le canal est évident (la conversation en cours).
- ✅ Worker → \`return_result\` complet au parent. Agent face à l'user → réponse claire en tête, structure concise, canal nommé ou celui de la conversation.
`,
};
