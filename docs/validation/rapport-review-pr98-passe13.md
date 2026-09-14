- **R1 — mineur, diagnostic inexact — `apps/cli/src/lib/postgres.ts:237`. Le constat tient.** Si le lockfile devient absent, illisible ou change de PID entre les lectures à `:229` et `:236`, `livePostmasterPid` renvoie `null` ou un autre PID. Le code écrit alors `ORPHAN_PROBE_CLAIMED_PID_NOT_ALIVE` alors que le PID initial peut toujours vivre, sans même avoir été sondé. Le refus reste sûr, mais son diagnostic attribue une mort non établie. Distinguer une réclamation modifiée ou devenue illisible d’un PID effectivement mort.

1. **tient** — Les trois correctifs existent dans `944cc9b3` : R1 à `postmaster-pid.test.ts:342` ; R2 à `postgres.ts:233`, `:237` et `:272` ; R3 à `up.ts:315`. La réserve nouvelle sur R2 figure ci-dessus.

2. **tient** — Aucun nouveau chemin identifié dans le périmètre envoyant un signal sans confirmation fraîche : lecture à `up.ts:392` avant l’arrêt gracieux, concordance du lockfile à `postgres.ts:451`, lecture par PID à `up.ts:406` avant le `SIGKILL` à `:432`. La course résiduelle entre lecture et action demeure.

3. **tient** — Aucun nouveau comportement dangereux précédemment relevé susceptible de revenir sans faire échouer un test identifié dans le périmètre. Les assertions de casse à `postmaster-pid.test.ts:365` et `:378` restent discriminantes lorsque le volume permet ce scénario. **NON TRANCHÉ** pour l’exécution : revue statique, aucun test exécuté.

4. **constat** — R1 : le nouveau diagnostic affirme que le PID est mort alors que la condition peut seulement constater une différence entre deux lectures du lockfile.

5. **constat** — Les nouvelles émissions sont atteignables. Les deux nouveaux codes sont distincts ; les refus du classifieur partagent un code avec des raisons différenciées. R1 empêche toutefois de retrouver correctement la cause dans le cas d’un changement du lockfile.

6. **constat** — Un constat nouveau, mineur ; aucun contournement supplémentaire des confirmations identifié. HEAD local est `dac033f7`, mais les cinq fichiers examinés sont identiques à ceux de `944cc9b3`.

des constats