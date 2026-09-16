## Constats

1. **BLOQUANT — échec invisible dans la livraison Telegram.** [execute.ts:3930](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:3930) exécute l’envoi avec `call.input`, sans notice. Celle-ci est ajoutée uniquement au résultat en base à [execute.ts:4574](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4574), après finalisation. Aucune nouvelle livraison n’est préparée (ligne 4530). **Déclenchement :** le parent reçoit un échec, envoie son message sur Telegram, puis termine. **Sens : faux silence** — la base contient le fait, le destinataire ne le reçoit pas.

2. **IMPORTANT — perte de l’échec à travers une synthèse intermédiaire.** [execute.ts:2754](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2754) ne retient que les résultats `error-text` commençant par le marqueur. **Déclenchement :** C échoue ; B termine avec une synthèse et la notice ; A reçoit B comme `completed`, dans un résultat `text` ([resume.ts:261](D:/APPS/wt-delegation/packages/orchestration/src/router/resume.ts:261)), puis écrit sa propre synthèse. Aucun échec de C n’est conservé dans le jeu de notices d’A. **Sens : faux silence** — la propagation finale dépend à nouveau du modèle.

3. **IMPORTANT — une reprise peut effacer l’échec sans livraison réussie.** [execute.ts:2756](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2756) considère tout résultat autre que `error-text` comme suffisant pour effacer le spécialiste. **Déclenchements :**
   - la compaction remplace l’échec par un résultat `text` ([execute.ts:395](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:395)), ensuite persisté et relu ;
   - un rejeu refusé écrit `{ error: delegation_retry_blocked… }` ([execute.ts:3707](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:3707)), sérialisé en `json` par `toResultOutput`, puis relu après une suspension.
   
   **Sens : faux effacement** — aucune livraison n’a réparé l’échec, mais la notice disparaît.

4. **MINEUR — commentaires et intitulés décrivent encore la garde retirée.** [execute.ts:4345](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:4345) affirme encore que `assign_*` bloque le succès ; [execute.ts:2729](D:/APPS/wt-delegation/apps/runner/src/job/execute.ts:2729) décrit son ancien réamorçage. Les tests annoncent encore un rappel ou un refus aux [lignes 575](D:/APPS/wt-delegation/apps/runner/src/tests/job/delegation-contract.test.ts:575) et [799](D:/APPS/wt-delegation/apps/runner/src/tests/job/delegation-contract.test.ts:799), alors qu’ils attendent `completed`. **Sens : garantie documentaire excessive**, contraire au comportement actuel.

## Six questions

1. **constat — les cinq points ne tiennent pas ensemble.**
   - **Point 1 : tient** pour le chemin sans livrable contrôlé par `return_result` : rappel unique et relu après reprise, lignes 2792–2808 ; échec `empty_deliverable`, lignes 4438–4482.
   - **Point 2 : tient** : transmission de l’échec typé, `execute.ts:3854–3866` et `resume.ts:254–263`.
   - **Point 3 : constat** : ajout après finalisation correctement placé, mais visibilité effective non garantie — constats 1 à 3.
   - **Point 4 : tient** pour les erreurs de livraison suivies dans le run : filtre conservé ligne 2706, refus sur les deux chemins lignes 3247–3262 et 4350–4377.
   - **Point 5 : tient** : interdiction explicite du message d’attente dans `resume.ts:258`.

2. **constat** — le succès après délégation ratée est désormais autorisé conformément à l’arbitrage, mais le remplacement par un fait visible laisse les chemins des constats 1 à 3 sans cette garantie.

3. **constat** — oui : Telegram, reprise après compaction ou rejeu refusé, et synthèse du grand-parent.

4. **tient** pour les cas directs : un succès du même spécialiste efface la notice ; un report `error-text` sans marqueur n’en crée pas et n’efface pas l’échec antérieur. Le rejeu refusé présente toutefois l’erreur inverse : disparition indue après reprise, constat 3.

5. **constat** — plusieurs commentaires et tests décrivent encore l’ancienne garde, constat 4.

6. **constat** — nouveaux défauts identifiés dans la visibilité promise. Contrôle statique ; tests non exécutés dans cette sandbox en lecture seule.

des constats