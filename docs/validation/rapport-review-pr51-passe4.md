Review limitée à `d4415dbb`. Des modifications locales sont apparues pendant la lecture ; le constat sur `titresDeTest` a donc été reproduit depuis le contenu exact du commit, chargé en mémoire.

1. **Gravité moyenne — Le nettoyage des commentaires supprime du vrai code.**  
   [apps/qa/lib.mjs:650](D:/APPS/NodalAI/apps/qa/lib.mjs:650)  
   La regex reconnaît `/*` même dans une chaîne. Cas réel : dans `apps/qa/lib.test.mjs`, elle part du glob de la ligne 299 jusqu’au `*/` de la ligne 902, supprimant notamment des déclarations de tests actives.  
   **Déclenchement :** appeler `titresDeTest` avec une chaîne contenant `tests/*.ts`, puis `it('@cap:creer-agent', () => {})`, puis `/** fin */`. Résultat exécuté sur le commit : `[]`. Une revendication valide peut ainsi disparaître et faire échouer la porte. **Aucun slug valide actuellement perdu n’a été identifié dans le dépôt** ; le cas réel démontre néanmoins la suppression de code.

2. **Gravité basse — La stabilité des homonymes dépend de leur rang, sans limitation documentée.**  
   [apps/qa/lib.mjs:519](D:/APPS/NodalAI/apps/qa/lib.mjs:519)  
   Ajouter un homonyme avant les autres transfère leurs historiques aux mauvais cas. Le commentaire affirme la stabilité de l’ordre sans expliquer cette limite.  
   **Déclenchement :** mesurer `[A vert, B rouge]`, puis `[nouveau rouge, A vert, B rouge]`, tous de même fichier et titre. Les historiques deviennent respectivement `vr`, `rv`, `r` : régression inventée pour le nouveau, historique de B attribué à A, historique neuf pour B. Non bloquant si cette limite est explicitement assumée.

3. **Gravité moyenne — Un chantier peut apparaître dans deux colonnes.**  
   [apps/qa/collect.mjs:325](D:/APPS/NodalAI/apps/qa/collect.mjs:325)  
   La concaténation ne déduplique pas les deux réponses ; `cartesDuTableau` conserve chaque occurrence.  
   **Déclenchement :** fermer une issue entre les requêtes « ouvertes » et « fermées ». Elle figure dans les deux réponses. Reproduction en mémoire : le même numéro produit deux cartes, « En cours » et « Fait », faussant les compteurs.

Les cinq questions :

1. **tient** — Les fichiers suivis sont `history.ndjson`, `playwright-run.json`, `snapshot.json` et `tests.ndjson`. Aucun fichier exclusivement humain identifié. Le collecteur écrit les trois fichiers de mesure ; le workflow fournit le rapport Playwright. La sauvegarde copie tout le dossier avant sa suppression.
2. **constat** — Constat 1. Suppression réelle de code identifiée ; disparition d’un titre portant un slug valide reproduite sur un exemple minimal, pas constatée parmi les revendications actuelles.
3. **constat** — Constat 2. La clé change avec le rang ; cette limite n’est pas documentée dans le commit.
4. **constat** — Constat 3. Aucun dédoublonnage entre les deux états.
5. **tient** — Seul `qa.yml` lance le collecteur en CI, après le banc, y compris en déclenchement manuel. `ci.yml` et `qa-pages.yml` ne collectent pas ; le script `build` rend les données existantes.

Vérifications par lecture et reproductions Node en mémoire ; suite Vitest non exécutée, `pnpm` absent du PATH. Aucun fichier modifié par cette review.

des constats