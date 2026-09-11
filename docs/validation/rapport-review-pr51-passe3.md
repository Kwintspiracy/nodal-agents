**La passe 2 ne tient pas entièrement.** HEAD `a38491ec` et base `44f72be6` vérifiés. Voici les constats reproductibles.

1. **Important — Un ancien rapport de banc peut être présenté comme la mesure actuelle.**  
   [.github/workflows/qa.yml:98](/D:/APPS/NodalAI/.github/workflows/qa.yml:98)  
   `bench-run.json` n’est pas effacé avant l’exécution. Après une première nuit réussie, il est versionné et revient donc même sur un runner neuf. Si le banc échoue avant d’écrire son JSON — erreur d’import, par exemple — `|| true` laisse continuer et le collecteur relit le rapport précédent. Un ancien vert masque alors l’absence de mesure.  
   **Déclenchement :** une première collecte réussie, puis une panne du CLI avant `writeFileSync`.

2. **Important — La sauvegarde annule les suppressions de rapports.**  
   [.github/workflows/qa.yml:209](/D:/APPS/NodalAI/.github/workflows/qa.yml:209)  
   `reset --hard` restaure les fichiers suivis, puis `cp -r` écrase uniquement les fichiers présents dans la sauvegarde. Il ne propage aucune suppression. Ainsi, lorsque « Normaliser le rapport » supprime `playwright-run.json` faute de résultat, l’enregistrement réintroduit l’ancien fichier. Le snapshot du jour reste correctement absent, mais les données publiées deviennent incohérentes et une collecte ultérieure peut recompter ce rapport périmé.  
   **Déclenchement :** rapport Playwright déjà versionné, puis exécution sans sortie JSON.

3. **Important — L’absence complète du banc ne déclenche aucun écart.**  
   [apps/qa/lib.mjs:326](/D:/APPS/NodalAI/apps/qa/lib.mjs:326)  
   `verdictDuBanc(null)` renvoie bien `absent: true`, mais `ecartsDe` ignore ce champ. L’écran Banc signale l’absence ; l’alerte ne la signale pas et peut fermer le billet si aucun autre écart de gravité haute ne subsiste.  
   **Reproduction exécutée :** `ecartsDe({ banc: { dernierRun: null } }, [{}, {}])` renvoie `[]`. Une section portant explicitement `error`, en revanche, est correctement signalée.

4. **Important — Un test commenté ou une fixture peut satisfaire la porte.**  
   [apps/qa/lib.mjs:621](/D:/APPS/NodalAI/apps/qa/lib.mjs:621)  
   La regex ne distingue pas le code des commentaires et des chaînes. Commenter l’unique test d’une capacité laisse donc sa revendication active. Inversement, une fixture contenant un faux appel avec une étiquette inconnue bloque la CI.  
   **Reproductions exécutées :** `// test('@cap:fantome', () => {})` et une chaîne contenant cet appel donnent tous deux `["@cap:fantome"]`. Cela contredit directement le contrat documenté dans `CLAUDE.md`.

5. **Important — Des cas paramétrés homonymes fusionnent en une fausse histoire temporelle.**  
   [apps/qa/lib.mjs:465](/D:/APPS/NodalAI/apps/qa/lib.mjs:465), [apps/qa/lib.mjs:506](/D:/APPS/NodalAI/apps/qa/lib.mjs:506)  
   La clé contient seulement le fichier et le titre complet. Avec `test.each` dont le titre ne distingue pas les paramètres, deux cas deviennent deux « tours » du même test. Un cas toujours vert et un autre toujours rouge produisent artificiellement de l’instabilité et une régression fraîche.  
   **Reproduction exécutée :** deux résultats homonymes, vert puis rouge dans une seule collecte, produisent une seule entrée avec `tours: 2`, `recents: "vr"` et `rougeDepuis` renseigné.

6. **Important — Le Kanban peut perdre silencieusement des éléments ouverts.**  
   [apps/qa/collect.mjs:308](/D:/APPS/NodalAI/apps/qa/collect.mjs:308)  
   Les limites portent sur **tous les états** : 200 issues et 50 PR. Des éléments fermés récents peuvent évincer des éléments ouverts plus anciens. Le collecteur présente pourtant la réponse comme un tableau mesuré complet.  
   **Déclenchement :** une ancienne PR toujours ouverte et cinquante PR plus récentes dans les résultats ; l’ancienne disparaît de « En review ». Aucun indicateur de troncature ni état ABSENT.

Vérification locale : `node apps/qa/porte.mjs` réussit, avec 24 capacités exigées et 28 revendications. Les reproductions ci-dessus ont tourné en mémoire. **Les 121 tests Vitest n’ont pas pu être exécutés** : `pnpm` absent du PATH, puis lancement direct bloqué par une dépendance `pathe` manquante. Aucun fichier modifié.

Pour les dix questions demandées :

1. **constat** — Suppressions perdues, constat 2. Aucun chemin identifié ajoutant du code hors `apps/qa/data/` au commit. Le premier `git diff` ignore effectivement les fichiers non suivis ; toutefois, une collecte normale modifie aussi `history.ndjson` et `snapshot.json`, déjà suivis : ce défaut seul ne perd donc pas la mesure dans le scénario actuel.
2. **tient** — Checkout de main ; collecteur et banc utilisent `git rev-parse HEAD`, pas le SHA de l’événement. L’historique décrit le commit mesuré avant le repositionnement pour sauvegarde.
3. **NON TRANCHÉ** pour toutes les ponctuations côté serveur. L’égalité locale `i.title === titre` empêche bien un titre approchant d’être modifié. La recherche serveur n’est pas une égalité de titre ; la limite de 50 reste une limite de candidats. Le comportement précis des guillemets incorporés et du cadratin n’a pas été testé contre GitHub. [Documentation de recherche](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests).
4. **constat** — Constats 1 et 3. Une section explicitement en panne est distinguée ; une section simplement omise n’est pas détectée, et `{ diffs: [] }` est accepté comme un passage sans régression.
5. **tient** — `ref: main` demande la branche, sans reprendre le SHA de l’événement. Le push précède la fin du workflow : le checkout suivant récupère la mesure ou un descendant, dans le déroulement normal. [Code officiel de checkout v5](https://raw.githubusercontent.com/actions/checkout/v5/src/input-helper.ts).
6. **constat** — Constats 1 et 6. Les échecs des requêtes GitHub deviennent correctement `null`, et une couverture absente reste absente. Toutes les données manquantes ne sont toutefois pas signalées : notamment un rapport unitaire absent apporte simplement zéro nouvel essai.
7. **constat** — Constat 4. `.skip` et `.todo` comptent comme déclarations, conformément au contrat actuel, sans devenir des preuves exécutées. Un slug littéral dans un template est lu ; un slug interpolé ne l’est pas. Tous les fichiers suivis aux extensions reconnues sont scannés, y compris `apps/qa/lib.test.mjs`.
8. **constat** — Constat 5. Deux fichiers distincts restent séparés. Renommer un `describe` crée une nouvelle clé et conserve l’ancienne entrée ; la continuité historique n’est donc pas préservée.
9. **tient** — Les titres d’issues, noms de tests et textes affichés passent par `esc`. Les erreurs Playwright brutes ne sont pas injectées dans le HTML. Aucun chemin d’injection identifié depuis ces champs.
10. **tient** pour les filtres de titres — Aucun `--grep` actif identifié comme cassé par les ajouts. Le diff comprend aussi des changements de sélecteurs e2e et d’ancres UI ; leur fonctionnement en navigateur reste **NON TRANCHÉ**, faute d’exécution e2e.