Verdict : **faux en l’état** — aucun bloquant, deux constats importants.

## Constats

### Bloquant

Aucun.

### Important

1. [project-actions.ts](D:/APPS/NodalAI/apps/web/src/lib/project-actions.ts:295) — le contrôle de contenance reste lexical jusqu’au `mkdir` de la ligne 311.

   Un sous-dossier comme `lien/externe`, où `lien` est une jonction ou un lien symbolique déjà présent dans le terrain, passe `isSafeSubfolder` et `isUnderPath`. `mkdir(..., { recursive: true })` suit ensuite ce lien et peut créer le dossier physiquement hors du terrain.

   Ce qui casse : la garantie « sous-dossier du terrain » et le confinement attendu de la création. Il faut résoudre le chemin réel du terrain et celui du parent existant le plus proche avant le `mkdir`, puis refaire une vérification de contenance physique. Aucun test ne couvre actuellement ce cas.

2. [execute.ts](D:/APPS/NodalAI/packages/tools/src/execute.ts:675), [run-job.ts](D:/APPS/NodalAI/apps/runner/src/cli-runtime/run-job.ts:317) — le rattachement est enregistré avant que l’écriture ou la session CLI ne réussisse.

   Dès que l’intention autorise l’opération, `project_id` est posé définitivement. Une erreur ultérieure de l’outil, du processus CLI, du quota disque ou du système de fichiers laisse donc un job rattaché à un projet dans lequel il n’a rien produit.

   Ce qui casse : la sémantique affichée « ce travail a produit quelque chose dans ce projet » et les métriques `jobsCount`/`lastActivityAt`. Le caractère conservateur de l’intention de mutation ne justifie pas ce faux positif dans un registre d’activité. Le rattachement devrait être validé après une exécution réussie, tout en conservant les cibles calculées avant l’appel.

### Mineur

Aucun.

## Réponse aux cinq doutes

1. **Rattachement avant l’écriture : faux.**  
   C’est approprié pour l’intention de vérification, qui doit rester sale en cas d’échec incertain, mais pas pour un registre affirmant qu’une production a eu lieu. C’est le deuxième constat important.

2. **Le terrain lui-même comme projet : faux sans arbitrage produit explicite.**  
   Techniquement, la contenance fonctionne. En revanche, sur le chemin CLI, la cible est le terrain entier : dès qu’il est enregistré comme projet, chaque job d’écriture s’y rattache avant même de connaître les fichiers effectivement modifiés. Il engloutit donc `terrain/vrac` et empêche d’attribuer correctement une écriture à un projet imbriqué. Si le produit veut autoriser ce cas, il faut assumer explicitement cette sémantique ; sinon `subfolder: ''` doit être refusé.

3. **Second passage `realpath` : tient.**  
   Son coût est `O(projets × cibles)` uniquement après l’échec lexical. Pour les volumes attendus d’un registre local, ce n’est pas préoccupant. Un projet supprimé produit au pire un faux négatif dans les cas d’alias complexes : le repli lexical ne fabrique pas de correspondance physique mensongère. Une optimisation par cache ou déduplication peut attendre une mesure réelle.

4. **`registered_from` et `registered_job_id` sans écrivain P5 : tient.**  
   P6/P10 sont des usages déjà planifiés, et poser les colonnes dans la migration qui introduit le registre évite une évolution intermédiaire du modèle. Ce n’est pas du YAGNI tant que la prochaine brique les utilise réellement. Il serait néanmoins utile d’ajouter ultérieurement une contrainte de cohérence entre `registered_at`, `registered_from` et `registered_job_id`.

5. **Contrat de `TextButton` élargi : tient techniquement, mais l’arbitrage DS doit être validé par Quentin.**  
   Le nouveau contrat est précis et les usages respectent désormais `aria-expanded`; « Back to the conversation » utilise bien `RowActionButton`. Je ne vois pas de régression fonctionnelle. En revanche, déclarer les disclosures inline comme exception officielle au DS est bien une décision de design, pas un simple correctif d’implémentation.

## Exécution

- Lecture du document de cadrage : exécutée.
- Vérification des commits exacts `fd2293c3` et `0cb5889b` avec `git show`, `git diff` et `git log` : exécutée.
- Inspection statique des fichiers du périmètre : exécutée.
- `git diff --check` : exécuté. Aucun défaut sur `fd2293c3`; des espaces finaux existent dans le rapport de passe 26, sans incidence produit.
- Tests Vitest, typecheck, lint, architecture, migration et mutations : **NON EXÉCUTÉ** — sandbox en lecture seule.
- Fichiers non committés de P6 : non relus conformément au périmètre.

Ce n’est donc pas « rien de neuf » : les deux constats importants ci-dessus sont nouveaux.