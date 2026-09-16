# Demande de review — PR #108, « un job délégué qui n'a rien produit »

Branche `fix/delegation-contract`, ouverte, ferme l'issue #107.

L'incident : Alfred délègue une recherche à Researcher. Researcher fait trois
recherches, rend un `return_result {"status":"success"}` SANS texte — un job
interne n'a aucun outil de livraison. Le runner finalise `completed` avec
`result = NULL`. Le parent reçoit `## Researcher\n(no output)`, le lit comme une
réponse, et annonce à l'utilisateur « je te renvoie la synthèse dès que c'est
prêt ». Rien n'est jamais arrivé.

Sandbox lecture seule. Deux verdicts : **le constat tient** (fichier, ligne, ce
qui casse, comment le déclencher) ou **le constat est faux**.

Lire `git log origin/main..HEAD --patch`, puis le code d'aujourd'hui :
`apps/runner/src/job/execute.ts`, `state.ts`,
`packages/orchestration/src/router/resume.ts`, `system-prompt.ts`,
`team-block.ts`, `packages/tools/src/builtin/return-result.ts`.

## Ce que la PR affirme

1. Le livrable d'un sous-agent est son TEXTE d'assistant final, et rien d'autre.
2. Signaler un succès sans texte et sans livraison donne UN rappel, puis un
   échec `empty_deliverable`.
3. La garde du vide couvre désormais tous les canaux, jobs de tête compris.
4. Le parent reçoit un OBJET typé (`status`, `summary`, `error`, `exit_reason`,
   `tools_used`), plus une chaîne.
5. Un parent devant une délégation échouée n'a plus le droit d'annoncer que le
   travail est en cours.

## LA question de fond

**Où un modèle performant peut-il encore rendre du VIDE au parent ou à
l'utilisateur ?** Suis tout le chemin — `assign_<slug>` → création du sous-job →
exécution → finalisation → `resume` du parent → livraison — et cherche les
chemins où :

- un texte non vide existe mais n'arrive pas jusqu'au parent ;
- un vide arrive jusqu'au parent sans être signalé comme un échec ;
- le parent reçoit un échec et l'annonce quand même comme un travail en cours ;
- la garde se contourne : un `return_result` avec un `summary` vide mais un
  autre champ rempli, un texte fait d'espaces, un outil de livraison appelé avec
  un contenu vide, un sous-job qui échoue avant d'avoir un tour d'assistant, une
  délégation en parallèle dont un seul enfant est vide, une reprise après
  approbation.

C'est la question qui compte. Le reste est secondaire.

## Questions, par priorité

### P0

1. La question de fond ci-dessus.
2. Le rappel unique : peut-il boucler, ou être consommé par autre chose qu'un
   tour vide ? Que se passe-t-il si le modèle rend du vide DEUX fois ?
3. `empty_deliverable` remonte-t-il jusqu'à l'écran et jusqu'au parent avec sa
   RAISON, ou juste comme « failed » ?
4. Le changement de contrat de `return_result` casse-t-il un usage existant —
   un agent dont la personnalité l'appelle, une skill du catalogue, un test ?

### P1

5. Les dix cas du test moteur prouvent-ils ce qu'ils annoncent, ou comptent-ils
   des appels ? Y en a-t-il un qui resterait vert si la garde était débranchée ?
6. Le parcours d'écran prouve-t-il quelque chose qu'un moteur vert ne prouverait
   pas déjà ?

### P2

7. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les autres PR ouvertes ; `apps/qa` ; le style et le nommage.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les sept questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
