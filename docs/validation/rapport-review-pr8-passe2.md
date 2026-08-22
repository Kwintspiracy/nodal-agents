# Rapport de review - PR #8, passe 2

Verdict global : le reformage ne tient pas entièrement. Je trouve deux constats nouveaux. Je n’ai trouvé aucune régression nouvelle sur la surface Nodal ordinaire.

## 1. Un agent CLI avec un skill assigné reçoit encore des outils inexistants, sans chemin exploitable

- `packages/orchestration/src/system-prompt.ts:452-455`
- `packages/orchestration/src/system-prompt.ts:540-560`
- Test insuffisant : `packages/orchestration/src/tests/cli-runtime-surface.test.ts:148`

Le texte CLI affirme que les instructions des skills sont accessibles sur disque, mais la requête ne charge aucun chemin : seulement ID, slug, nom et description. L’index commun rendu ligne 543 reste en outre :

```text
skill_view('<slug>')
```

Le fallback de description ligne 542 recommande lui aussi `skill_view`.

Ce qui casse concrètement : avec un vrai skill assigné, le prompt CLI nomme encore `skill_view`, contrairement à la garantie du nouveau test, tout en ne donnant aucun chemin que `Read` pourrait ouvrir. L’agent connaît donc le nom du skill mais ne peut toujours pas accéder à ses instructions. Une information utile a bien été perdue lors du passage de « consigne » à « fait ».

Le test reste vert parce que sa fixture crée un sous-agent, mais n’assigne aucun skill à l’agent testé. L’assertion « ne nomme AUCUN outil absent » n’exerce donc jamais cette branche.

## 2. La suppression complète du baseline retire des règles générales parfaitement applicables au CLI

- `packages/orchestration/src/system-prompt.ts:631-640`
- Composition réelle du baseline : `packages/orchestration/src/agent-baseline.ts:68-90`

Le commentaire affirme que le baseline est « entièrement » construit autour des builtins Nodal. C’est faux : `buildBaselineBlock` agrège également tous les skills catalogue de type `baseline` avant d’ajouter les disciplines mémoire et rôle.

La condition ligne 638 supprime donc aussi, pour tout agent CLI :

- la vérification avant de déclarer le travail terminé ;
- les confirmations avant actions destructrices et le fail-loud ;
- le miroir de langue et de ton ;
- l’hygiène du workspace et la réutilisation des artefacts existants.

Ce qui casse concrètement : un agent CLI peut désormais annoncer un changement non vérifié, effectuer une modification destructive sans la discipline Nodal, répondre dans une autre langue ou recréer des artefacts déjà présents. Ces règles ne dépendaient pas de `save_memory`, `assign_*` ou des outils fichiers Nodal ; seule leur formulation devait éventuellement être adaptée.

## Surface Nodal ordinaire

Je n’ai trouvé aucun comportement nouveau cassé sur la surface par défaut : les nouvelles options conservent leurs valeurs historiques par défaut, et `buildSystemPrompt` ne désactive équipe, baseline, mémoire ou API de workspaces que lorsque `surface === 'cli-runtime'`.

La couverture ajoutée pour cette surface ordinaire reste très étroite — elle vérifie seulement la présence de `assign_` — mais le diff lui-même ne montre pas de régression ordinaire supplémentaire.
