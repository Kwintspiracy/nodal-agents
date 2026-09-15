## Constats

### 1. `apps/runner/src/job/execute.ts:2703`, `apps/runner/src/job/execute.ts:3781` et `packages/orchestration/src/router/resume.ts:281` — **BLOQUANT** — faux succès par chronologie inversée

**Déclenchement :** le parent appelle un outil de lecture et `assign_a` au même tour. La lecture s’exécute **avant** la délégation. L’enfant échoue. `resumeDelegated` place pourtant le résultat de l’enfant **avant** les résultats des outils déjà exécutés. La relecture rencontre donc l’échec puis la lecture réussie et positionne `workDoneSinceFailure = true`.

**Sens de l’erreur :** du travail antérieur devient une réparation postérieure. Aucun outil n’a réellement réussi depuis l’échec, mais les deux chemins de finalisation autorisent le succès.

### 2. `apps/runner/src/job/execute.ts:2703` et `apps/runner/src/job/execute.ts:2713` — **BLOQUANT** — une absence d’exécution devient du travail réussi

**Déclenchement :** le parent appelle `assign_a` et `assign_b` ensemble. A est exécuté et échoue ; B est différé. À la reprise, le résultat différé de B, pourtant `error-text`, entre dans le `else` et active `workDoneSinceFailure`.

Pour les outils ordinaires, le problème est plus large : `toResultOutput` (`execute.ts:1941`) sérialise aussi les erreurs en `json` ou `text`. Le test `type !== 'error-text'` les compte donc comme des réussites à la reprise, ainsi que les marqueurs d’attente ou de report.

**Sens de l’erreur :** un outil échoué ou jamais exécuté suffit à neutraliser la délégation ratée. Le critère annoncé « un outil a RÉUSSI » n’est pas respecté.

### 3. `apps/runner/src/job/execute.ts:2644`, `apps/runner/src/job/execute.ts:2714` et `apps/runner/src/job/execute.ts:2721` — **IMPORTANT** — une réparation ancienne couvre les échecs futurs

**Déclenchement :** délégation A échouée → outil réussi → délégation B échouée → finalisation. Le booléen devient vrai après le succès intermédiaire, mais aucun nouvel échec ne le remet à faux, y compris lors de la relecture du transcript.

**Sens de l’erreur :** B ne bloque jamais, même sans aucun travail après son échec. « Depuis l’échec » signifie en pratique « depuis un ancien échec ».

### 4. `apps/runner/src/job/execute.ts:2664` et `apps/runner/src/job/execute.ts:3942` — **BLOQUANT** — le constat principal de la passe 2 tient encore

**Déclenchement :** une délégation échoue sur le travail demandé ; une lecture sans rapport réussit, ou le parent envoie simplement « recherche lancée, je te reviens ». Tout succès d’outil, **y compris l’outil de livraison**, neutralise les échecs `assign_*`. Le texte de promesse ou `toolDelivered` suffit ensuite à éviter la garde du vide.

**Sens de l’erreur :** le correctif élargit le faux vert précédent : une activité quelconque, voire l’envoi de la promesse elle-même, vaut remplacement du travail absent. Une livraison réussie prouve que le message est parti, pas que son contenu a été réalisé.

### 5. `apps/runner/src/job/execute.ts:2660` et `apps/runner/src/job/execute.ts:2717` — **MINEUR** — commentaires plus forts que le code

**Déclenchement :** lecture du contrat local. Les commentaires concluent « le parent a refait, re-délégué ou travaillé lui-même » et « une délégation qui a LIVRÉ », alors que les branches acceptent respectivement une livraison de promesse et une délégation différée.

**Sens de l’erreur :** ils présentent une preuve de réparation ou de livraison là où le code ne l’établit pas. Les deux commentaires explicitement signalés en passe 2 ont, eux, été corrigés.

## Les cinq questions

1. **constat** — Le travail demandé peut encore manquer au parent ou à l’utilisateur tout en étant finalisé en succès : constats 1 à 4. Ces chemins prouvent un défaut de garde ; ils ne supposent pas qu’un modèle performant ment systématiquement. Aucun nouveau chemin de perte d’un véritable texte final n’est établi ici.

2. **constat** — Oui : lecture sans rapport, erreur sérialisée comme résultat ordinaire, délégation différée et résultat exécuté avant l’échec mais rangé après. Même le critère mécanique annoncé est contourné.

3. **constat** — Oui. Une livraison de « je te reviens » réussie après l’échec désactive elle-même le blocage des délégations ; le parent peut ensuite terminer en succès.

4. **constat** — Oui : constat 5.

5. **constat** — Il existe des constats nouveaux, notamment la chronologie inversée, les reports comptés comme réussites et le booléen jamais réinitialisé. Revue statique en lecture seule ; aucun test exécuté.

des constats