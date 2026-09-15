## Constats

Aucun nouveau faux vert ou faux rouge reproduit.

## Les six questions

1. **tient.** `apps/runner/src/verification/document.ts:201–207` normalise les fins de ligne, retire l’en-tête puis effectue une seule analyse Markdown. Seuls les titres de profondeur 1 directement dans le corps comptent. La conjonction a disparu.

2. **tient — sur les cas rejoués.** La version 5.0.0 était disponible localement ; aucune installation nécessaire. Comparaison exécutée en mémoire avec les vrais parseurs :
   - **30 cas** du tableau Markdown : tous conformes aux attentes ; exactement deux différences avec la référence par défaut, sur `...` et `+++`.
   - **1 200 variantes supplémentaires** : espaces, tabulations, indentation, espace insécable, clôtures, contenu et fins de ligne LF/CRLF/CR ; aucun écart supplémentaire.
   
   Cela confirme la mesure sur cet échantillon, sans prouver une équivalence universelle.

3. **tient — aucun faux vert nouveau trouvé.** Le témoin R1 de passe 8 possède un titre dans le corps selon la référence. Le déclarer vert est cohérent avec cette convention. Le cas du scalaire YAML de passe 9 est également vert après correction.

4. **NON TRANCHÉ.** Les 30 régressions Markdown passent sur la fonction réelle transpillée en mémoire. Cela ne recertifie pas les vingt correctifs, notamment la concurrence, le classement des fichiers et l’interface. Aucune suite complète ni campagne de mutations exécutée.

5. **tient pour la lecture unique ; NON TRANCHÉ pour la généralisation.** `document.ts:194–196` et `document.test.ts:372` disent « pour tout outil » : la mesure d’une référence ne démontre pas cette universalité. Autre précision : « pas elle » à `document.ts:193` décrit sa configuration **par défaut** ; `remark-frontmatter` reconnaît effectivement `+++` avec l’option `['yaml', 'toml']`, vérifiée ici. Aucun défaut de verdict supplémentaire établi.

6. **tient.** Aucun nouveau défaut comportemental reproduit. Vérifications en mémoire uniquement, aucun fichier modifié.

rien de neuf