// catalog/skills/research-scope-discipline.ts — system skill, shipped with the product.
//
// Source of truth for the 'content' field. The bootstrap seeder
// (seed-default-skills.ts) upserts this row at boot. Users can override
// per-install via the dashboard; overrides are preserved on subsequent
// boots via the 'content_overridden' flag on the agent_skills row.

import type { SystemSkill } from '../types';

export const researchScopeDisciplineSkill: SystemSkill = {
  slug: 'research-scope-discipline',
  name: 'Research scope discipline',
  description:
    'Discipline de scope pour éviter les runaways de recherche et les timeouts upstream sur les synthèses long-format.',
  requiredBuiltins: [],
  content: `Discipline de scope pour les recherches encyclopédiques et synthèses long-format. Évite les timeouts upstream et améliore la qualité du livrable.

## Cible par défaut : 5-8 KB de contenu structuré

Quand on te demande une synthèse encyclopédique ou une recherche approfondie, vise **5-8 KB de contenu** (≈ 1200-1800 mots, ≈ 4-6 sections principales).

**NE PAS** viser 15-20 KB en un seul shot. C'est la cause #1 des timeouts upstream sur les LLM — y compris les modèles avec gros context. L'utilisateur peut toujours redemander un approfondissement précis après ; mieux vaut un délivrable solide qu'un timeout à 5 min.

## Workflow scope-progressif

1. **Cadre la portée** : au début de la tâche, identifie 4-6 sections clés (pas 12+). Si l'orchestrator demande "synthèse complète sur X", c'est À TOI de choisir les 4-6 angles les plus représentatifs et de t'y tenir.
2. **Recherche ciblée** : 3-5 search/scrape MAX (pas 10+). Tu as ce qu'il faut pour rédiger une synthèse propre dès 3 sources solides. Plus de scrapes = plus de tokens en context = plus de risque de timeout.
3. **Rédige direct** : après recherche, \`file_write\` (si destination vault) ou \`dashboard_publish\` (si livrable dashboard) ou \`return_result\` directement. Pas de saves intermédiaires inutiles.

## Si tu sens que ça va déborder

Si tu réalises mid-job que le sujet mérite vraiment 15+ KB (cas rare : sujet vraiment dense, demande explicite "exhaustif"), **STOP**. Au lieu de continuer en mode "encyclopédie complète" :

- Termine ce que tu as déjà rédigé : 5-8 KB ciblés sur les fondamentaux ✅
- Dans ton \`return_result\` ou ton \`file_write\`, signale clairement à l'orchestrator : *"Cette synthèse couvre les fondamentaux de X. Les sujets connexes (sous-thème A, sous-thème B, sous-thème C) mériteraient une recherche dédiée si l'utilisateur veut aller plus loin."*

Ça permet à l'orchestrator de re-déléguer en sous-tâches focalisées au lieu d'un mega-call qui timeout.

## Découpage proposé

Si l'orchestrator te confie une task très large (ex: "synthèse complète sur la mécanique quantique"), TU as le droit de répondre avec un découpage proposé AVANT de commencer :

\`\`\`
Cette synthèse complète mérite 3-4 sous-recherches focalisées :
1. Histoire + fondateurs (Planck → Dirac)
2. Postulats + formalisme mathématique
3. Phénomènes observables (intrication, décohérence)
4. Applications + recherches récentes (2024-2025)

Je commence par la #1 ; à toi de re-déléguer les 3 autres en turns successifs.
\`\`\`

C'est une alternative valide à un timeout silencieux.

## Anti-patterns

- ❌ "Synthèse encyclopédique exhaustive sur tout l'historique + toutes les théories + tous les développements récents" en un seul shot → timeout garanti.
- ❌ 10+ scrapes "pour être sûr de ne rien rater" → bloat context, qualité ne s'améliore plus après 4-5 sources.
- ❌ Rédiger 15 KB puis dashboard_publish la totalité — préfère un livrable propre de 6 KB + signal "à approfondir si besoin".
- ❌ Plus de 30 turns d'exécution sans avoir appelé \`file_write\` ni \`dashboard_publish\` ni \`return_result\` → tu es en runaway de recherche, écris ce que tu as MAINTENANT.
- ✅ Synthèse focalisée 5-8 KB + signal explicite des extensions possibles.
`,
};
