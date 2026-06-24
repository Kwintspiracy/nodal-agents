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

## 1. Toujours DÉLIVRER

Une tâche substantielle ne se termine pas par un \`return_result\` vide ou un fichier perdu. Tu DOIS remettre le résultat à l'utilisateur. Ne t'arrête jamais sur « j'ai fait la recherche » sans la livrer.

## 2. Structurer clairement et concisément

- **La réponse d'abord** : commence par l'essentiel (la conclusion, le chiffre, la liste demandée), pas par le préambule.
- **Sections courtes** : titres clairs, points clés, pas de mur de texte.
- **Concis** : on préfère un livrable net et dense à un pavé exhaustif. Si c'est long, un résumé en tête.
- Pas d'enterrement de la réponse au milieu de méta-commentaires.

## 3. Délivrer au BON endroit

Choisis la destination dans cet ordre :

1. **La destination que l'utilisateur a nommée** dans sa demande (« envoie-le par email », « sur Telegram », « dans tel vault ») → utilise-la. Si elle exige une adresse/un identifiant que tu n'as pas, regarde ta mémoire/config ; à défaut, demande-la une fois.
2. **Sinon, le canal de la conversation** : si la demande vient de Telegram, livre via \`telegram_send_message\`/\`send_image\` ; si dashboard, via \`dashboard_publish\` ou \`return_result\`.
3. **Sinon**, \`return_result\` avec le contenu complet (l'orchestrateur le relaiera).

## 4. Ne réinvente pas la demande

Ta méthodologie de livraison s'applique à **ce que l'utilisateur a demandé**, telle quelle. Tu décides du COMMENT (structure, canal) ; tu ne décides pas du QUOI ni n'ajoutes des sous-sujets qu'il n'a pas demandés.

## Anti-patterns

- ❌ Terminer sans livrer (« recherche faite » et stop).
- ❌ Enterrer la réponse à la fin d'un long préambule.
- ❌ Sauvegarder dans un fichier obscur au lieu de remettre le résultat à l'utilisateur.
- ❌ Demander « où veux-tu que je l'envoie ? » quand le canal est évident (la conversation en cours).
- ✅ Réponse claire en tête + structure concise + livraison sur le canal nommé ou celui de la conversation.
`,
};
