# Demande de review — PR #77 « La mémoire du portail ne rougit plus toutes les PR », post-merge

Commit `ae133d1c`, mergé le 13/09 **sans passe Codex** (dette de revue,
issue #88). Il est dans `main`. Diff : 13 lignes de
`scripts/check-commit-hygiene.mjs`.

Sandbox lecture seule. Deux verdicts valent : **le constat tient** ou **le
constat est faux**.

Lire `git show ae133d1c` puis `scripts/check-commit-hygiene.mjs` en entier,
et le workflow CI qui l'appelle.

## Ce que la PR affirme

1. `apps/qa/data/tests.ndjson` (3,2 Mo, écrit par la mesure nocturne) faisait
   rougir `hygiene:check --all` sur TOUTES les PR ouvertes.
2. `SIZE_EXEMPT = /^apps\/qa\/data\/.*\.(ndjson|json)$/` exempte ces fichiers
   de la seule règle de TAILLE. NUL et UTF-16 restent contrôlés.
3. Le fichier ne peut pas être gitignoré : le portail en ligne se rend depuis
   le dépôt.

## Déjà trouvé et corrigé — à relire aussi

La question 2 n'est plus hypothétique. Le commentaire affirmait que les données
du portail échappent à la taille « et à elle seule : NUL et UTF-16 restent
contrôlés ». C'était FAUX pour `apps/qa/data/tests.ndjson`, le fichier même qui
a motivé l'exemption : `.ndjson` n'était pas dans `TEXT_EXT`, donc la boucle
sortait une ligne avant les contrôles de contenu. Trouvé en écrivant cette
demande, vérifié à la source, corrigé.

La décision « quels contrôles pour quel fichier » vit désormais dans une
fonction pure, `scripts/lib/hygiene-file-scope.mjs`, testée — la phrase est
tenue par du code et non par un commentaire.

**Ce correctif fait partie du périmètre de cette review.**

## Questions, par priorité

### P0 — l'exemption est-elle exactement celle annoncée ?

1. **La forme du chemin testé.** `file` contient-il un chemin POSIX relatif à
   la racine du dépôt dans TOUS les modes du script (`--all`, diff d'un
   commit, fichiers indexés) ? Sur Windows, si `file` peut arriver avec des
   `\`, l'ancre `^apps\/qa\/data\/` ne matche pas et l'exemption est
   inopérante — la CI redeviendrait rouge sans que personne comprenne.
2. **La portée.** `.*` traverse les `/` : `apps/qa/data/anything/deep/x.json`
   est exempté. Voulu ? Et un fichier exempté de la taille échappe-t-il aussi,
   par la structure du `for`, à un contrôle placé APRÈS (lire la suite de la
   boucle : y a-t-il un `continue` implicite, ou les contrôles NUL/UTF-16
   sont-ils bien exécutés) ?
3. **Le plafond.** Un fichier exempté n'a plus AUCUNE borne : si la mesure
   nocturne dérive (un enregistrement par exécution au lieu d'un par test),
   le dépôt grossit sans garde. La PR affirme le contenu « borné » — qu'est-ce
   qui le borne, dans le code qui écrit `tests.ndjson` ? Y a-t-il une borne,
   ou seulement une intention ?

### P1 — le reste du script

4. `BINARY_EXT.test(file)` fait un `continue` AVANT le contrôle de taille :
   la liste des extensions binaires couvre-t-elle déjà `.json` / `.ndjson` ?
   Si oui, l'exemption serait morte et la vraie cause serait ailleurs.
5. Y a-t-il un test pour cette exemption (un fichier de test qui vérifie que
   `apps/qa/data/x.ndjson` de 3 Mo passe et que `apps/x.json` de 3 Mo
   échoue) ? Sinon, la règle est-elle prouvée autrement qu'« vérifié à la
   main » ?

## Hors périmètre

Le portail `apps/qa` lui-même (relu par ailleurs) ; le contenu de
`tests.ndjson` ; style, nommage.

## Ce dont je doute moi-même

Q1 : la forme du chemin sous Windows, et Q2 : que NUL/UTF-16 soient vraiment
encore contrôlés sur les fichiers exemptés.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les cinq
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf » ou « des constats ».
