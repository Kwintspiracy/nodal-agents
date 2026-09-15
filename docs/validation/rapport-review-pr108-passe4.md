## Constats

### 1. `apps/runner/src/job/execute.ts:2715`, `apps/runner/src/job/execute.ts:2722` et `packages/orchestration/src/router/resume.ts:279` — **BLOQUANT** — une délégation reportée vaut encore livrable

**Déclenchement :** `assign_a` échoue et `assign_b`, émis dans le même tour, est reporté. `resumeDelegated` range d’abord l’échec de A puis le résultat `error-text` du report de B. Comme la relecture ne reconnaît comme échec que `error-text` préfixé par `DELEGATION_FAILED_MARKER`, B entre dans le `else` et active `workDoneSinceFailure` pendant que A reste non résolu. Le parent peut alors finir en succès. Le test du report ne couvre que le report isolé, sans échec préalable.

**Sens de l’erreur :** une délégation jamais exécutée devient « une autre délégation a livré » et neutralise une délégation qui n’a rien rendu. Le critère mécanique reste contournable.

### 2. `apps/runner/src/job/execute.ts:4253` et `apps/runner/src/job/execute.ts:4280` — **BLOQUANT** — `blocked` peut terminer sans que sa raison atteigne l’utilisateur

**Déclenchement :** sur Telegram, Discord ou Slack, le parent dit la vérité avec `status='blocked'` et une raison, mais ses tentatives de livraison échouent. Après les deux rappels autorisés, la condition `redeliveryNudges < MAX_REDELIVERY_NUDGES` devient fausse et le code passe directement à `failJob`. La raison est stockée dans `agent_jobs.result`, mais aucun outil ne l’a livrée et cette branche ne draine aucune livraison.

**Sens de l’erreur :** le job porte bien une explication en base, mais l’utilisateur d’un canal accessible uniquement par outil ne la reçoit pas. L’issue « dire la vérité » peut donc encore rendre du vide à l’utilisateur.

### 3. `apps/runner/src/job/execute.ts:2674` et `apps/runner/src/tests/job/delegation-contract.test.ts:727` — **MINEUR** — commentaires et titre contraires au contrat

**Déclenchement :** le commentaire dit encore qu’« un outil a réussi » et que le parent a pu refaire ou travailler lui-même, alors que le code n’accepte plus qu’une autre délégation. Le test intitulé « sans échec de job » attend désormais un résultat `failed`, et son commentaire affirme encore que les deux premières issues sont impossibles et qu’un outil réussi suffit.

**Sens de l’erreur :** la documentation locale décrit l’ancien critère et le titre annonce l’inverse du résultat vérifié. Le commentaire `execute.ts:2724` disant que la délégation « a LIVRÉ » est également faux dans le cas du constat 1.

## Les cinq questions

1. **constat** — Un modèle peut encore rendre du vide en succès via une seconde délégation seulement reportée. Il peut aussi rendre du vide à l’utilisateur en déclarant honnêtement `blocked` lorsque les livraisons de sa raison échouent.

2. **constat** — Le critère est contournable par le report décrit au constat 1. Trois mots ou un livrable hors sujet restent sémantiquement invérifiables ; un résultat `assign_*` qui n’est ni l’échec marqué ni un vrai livrable est néanmoins accepté par la relecture.

3. **constat** — Oui : après épuisement des rappels de livraison sur un canal à outil, `blocked` finalise sans que la raison ait atteint l’utilisateur.

4. **constat** — Oui : constat 3, ainsi que « a LIVRÉ » à `execute.ts:2724` dans le cas du constat 1.

5. **constat** — Le report compte encore comme une livraison et l’issue `blocked` peut rester invisible. Les tests n’ont pas pu être exécutés dans ce worktree : `pnpm` et `corepack` sont indisponibles.

la forme est en cause