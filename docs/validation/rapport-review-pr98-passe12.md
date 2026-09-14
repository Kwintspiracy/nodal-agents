- **R1 — mineur, portabilité du test — `apps/cli/src/tests/postmaster-pid.test.ts:337`. Le constat tient.** Sur Linux avec un répertoire temporaire insensible à la casse, `mkdirSync(upper)` échoue avec `EEXIST` après la création de `lower`. Aucune assertion de propriété n’est atteinte. Le filtre Linux ne vérifie pas cette précondition : détecter la sensibilité du volume et expliciter le cas non applicable.

- **R2 — mineur, documentation des refus — `apps/cli/src/lib/postgres.ts:218`. Le constat tient.** « each with its own code » promet un diagnostic pour chaque condition non vérifiable. Pourtant, une date absente du lockfile entraîne un refus dans `ownedPostgresPids`, dont `unconfirmedReading` ignore `skipped` à `:253`. Le retour anticipé à `:228` peut également être silencieux. Restreindre cette affirmation aux diagnostics effectivement émis.

- **R3 — mineur, message d’écran — `apps/cli/src/commands/up.ts:317`. Le constat tient.** « neither could be read » signifie que les deux preuves sont illisibles. Or une seule preuve illisible suffit : répertoire confirmé mais date illisible (`postgres.ts:247`), ou répertoire illisible sans lecture de la date (`:240`). Les trois thèmes sont présents, mais l’alternative reste inexacte. Écrire qu’au moins une des deux preuves n’a pu être obtenue.

1. **tient** — Les trois correctifs existent dans `d24ab568` : R1, test à `postmaster-pid.test.ts:325`, refus à `:356` et assertion miroir à `:369` ; R2, résumé à `postgres.ts:216` et fenêtre temporelle à `:235` ; R3, message à `up.ts:315`. Les réserves nouvelles figurent ci-dessus.

2. **tient** — Aucun nouveau chemin identifié dans le périmètre envoyant un signal sans confirmation fraîche. L’arrêt gracieux exige `up.ts:396`, puis la concordance du PID à `postgres.ts:435`. Chaque `SIGKILL` à `up.ts:436` exige la lecture à `:410`. La course entre lecture et action demeure, sans garantie atomique.

3. **tient** — Aucun nouveau comportement dangereux précédemment relevé qui pourrait revenir sans faire échouer un test identifié dans le périmètre. La régression de casse dans `postmasterHoldsDataDir` ferait désormais échouer `the DIRECTORY proof is case-sensitive too, not only the lockfile read`, à `postmaster-pid.test.ts:356`.

4. **constat** — R2 et R3 ci-dessus : les formulations nouvelles promettent encore davantage que le code.

5. **constat** — Sur un volume sensible à la casse, le test exerce bien `postmasterHoldsDataDir` via `unconfirmedReading` et distingue les deux répertoires ; l’assertion miroir valide le cas accepté. Il ne reproduit ni recyclage réel de PID ni arrêt de PostgreSQL. Sur un volume insensible à la casse, R1 s’applique. **NON TRANCHÉ** pour l’exécution Linux et la configuration effective de CI : revue statique sous Windows, aucun test exécuté.

6. **constat** — Trois constats nouveaux, aucun contournement supplémentaire des confirmations identifié. HEAD local est `98d484ec` ; les cinq fichiers examinés sont identiques à ceux de `d24ab568`.

des constats