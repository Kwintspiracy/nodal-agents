- **R1 — mineur, formulation résiduelle — `apps/cli/src/lib/postgres.ts:103`, `apps/cli/src/commands/up.ts:308`. Le constat tient.** Sur une erreur autre que `ESRCH`, `livePostmasterPid` peut retourner un PID sans établir sa vivacité. Son commentaire annonce encore « still alive » et celui de `up` « a live pid ». Le diagnostic affiché est corrigé ; aucun contournement de confirmation identifié.

1. **tient** — Correctif présent dans `e4c64e35` : `postgres.ts:120`, `:232` et `up.ts:313`. HEAD local : `9ce29ba5` ; les cinq fichiers examinés sont identiques à ceux du commit demandé.

2. **tient** — Aucun nouveau chemin identifié dans le périmètre : confirmation fraîche à `up.ts:392` avant l’arrêt gracieux, concordance du lockfile à `postgres.ts:473`, puis confirmation par PID à `up.ts:406` avant le signal à `:432`. La course résiduelle entre lecture et action demeure.

3. **tient** — Aucun nouveau comportement dangereux précédemment relevé pouvant revenir sans faire échouer les assertions examinées identifié dans le périmètre. **NON TRANCHÉ** pour l’exécution : revue statique, tests non exécutés dans cette sandbox en lecture seule.

4. **constat** — R1 : deux commentaires conservent l’affirmation de vivacité. Le message corrigé à l’écran décrit bien l’incertitude.

5. **tient** — Aucun nouveau défaut qui change ce que le programme FAIT identifié. La réserve restante porte uniquement sur la formulation.

la forme est en cause