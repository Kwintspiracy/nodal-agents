## Constats

### 1. `apps/runner/src/job/execute.ts:2681` et `apps/runner/src/job/execute.ts:3904` — **BLOQUANT** — faux succès

**Déclenchement :** `assign_a` échoue sur le travail demandé, puis `assign_b` réussit sur une tâche différente ou partielle. Le succès de B supprime indistinctement tous les échecs `assign_*`, sans établir qu’il remplace le travail de A. Le parent peut ensuite finaliser en succès alors que le travail initial reste absent.

**Sens de l’erreur :** la correction confond « une délégation a livré quelque chose » avec « la délégation défaillante a été remplacée ». Le travail jamais fait peut passer pour fait.

### 2. `apps/runner/src/job/execute.ts:2637`, `apps/runner/src/job/execute.ts:3167` et `apps/runner/src/job/execute.ts:4287` — **IMPORTANT** — faux échec

**Déclenchement :** une délégation échoue, puis le parent exécute honnêtement le travail lui-même avec ses propres outils et écrit le résultat. Aucun succès non-`assign_*` ne retire l’échec `assign_*`. Les deux chemins de finalisation continuent donc à refuser son succès, malgré l’instruction explicite « Refais-le toi-même ».

**Sens de l’erreur :** une issue autorisée par le rappel est impossible à valider ; un travail réellement réparé finit en `unresolved_tool_failure`.

### 3. `apps/runner/src/job/execute.ts:2727` — **MINEUR** — rappel supprimé à tort

**Déclenchement :** le texte utilisateur initial contient littéralement `[livrable-vide]`. Il est compté comme un rappel interne antérieur parce que le compteur inspecte tout message de rôle `user` par simple sous-chaîne. Le modèle ne peut pas fabriquer directement ce rôle, mais l’utilisateur peut provoquer la collision.

**Sens de l’erreur :** le premier livrable vide échoue immédiatement au lieu de recevoir l’unique rappel prévu.

### 4. `apps/runner/src/job/state.ts:245` et `apps/runner/src/tests/job/execute.test.ts:6121` — **MINEUR** — commentaires contraires au code

**Déclenchement :** lecture ou maintenance du contrat. `state.ts` affirme encore que le texte est récupéré « after children-compile », alors que le correctif fait désormais l’inverse. Le test décrit encore un « file path via return_result », alors que `return_result` ne transporte plus aucun contenu.

**Sens de l’erreur :** la documentation locale prescrit ou décrit l’ancien comportement.

## Les six questions

1. **constat** — Le vide strict n’est plus accepté sur les chemins relus, mais un travail absent peut encore être finalisé comme réussi par l’effacement global des échecs `assign_*`.

2. **constat** — L’effacement global est exploitable comme décrit au constat 1. La priorité donnée au texte final respecte le nouveau contrat : elle peut perdre le détail des enfants si le modèle écrit une synthèse pauvre, mais pas le livrable contractuel d’un modèle performant. Le compteur ne peut pas être fabriqué par le modèle dans un message assistant, mais il peut compter un vrai message utilisateur sans rapport avec un rappel.

3. **constat** — Oui. Le parent qui répare lui-même le travail reste bloqué par l’échec `assign_*` persistant, constat 2.

4. **NON TRANCHÉ** — Les skills du catalogue relues prescrivent désormais le bon contrat. Un commentaire de test conserve l’ancien contrat. Les personnalités stockées en DB ne sont pas vérifiables depuis ce worktree en lecture seule.

5. **constat** — Deux commentaires énoncent encore ce que le code ne fait plus, constat 4.

6. **constat** — Il y a des constats nouveaux.

des constats