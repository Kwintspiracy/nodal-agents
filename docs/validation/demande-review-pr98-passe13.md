# Demande de review — PR #98, passe 13

Passe 12 : trois constats, tous **mineurs**, tous vrais, tous corrigés dans
`944cc9b3`. Et la question « quel comportement dangereux pourrait revenir sans
faire rougir un test ? » — qui avait rendu un constat trois passes de suite —
est revenue **vide**.

Cette passe relit `944cc9b3`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show 944cc9b3`, le rapport de la passe 12
(`docs/validation/rapport-review-pr98-passe12.md`), puis
`apps/cli/src/lib/orphans.ts`, `apps/cli/src/lib/postgres.ts`,
`apps/cli/src/commands/up.ts` et les deux fichiers de tests.

## Ce que la passe 12 a changé

| Constat | Correctif |
|---|---|
| R1 | Le test de casse MESURE la sensibilité du volume (`existsSync(upper)` après avoir créé `lower`) et se retire quand elle n'est pas là, au lieu d'échouer pour une raison étrangère. |
| R2 | Les trois refus silencieux écrivent un code : pas de réclamation, pid réclamé mort, et les `skipped` du classifieur (ligne 3 absente ou discordante) qui étaient produits puis jetés. |
| R3 | « neither could be read » → « at least one of those two », et le paragraphe est remis en prose. |

## Questions, par priorité

### P0

1. Les trois correctifs existent-ils dans `944cc9b3` ? Cite la ligne de chacun.
2. Reste-t-il un chemin par lequel `up` signale un processus non confirmé par
   une lecture fraîche ?
3. Reste-t-il un comportement jugé dangereux par l'une des douze passes qui
   repasserait sans faire rougir un test ?

### P1

4. Reste-t-il un commentaire, un message d'écran ou un message de commit qui
   énonce ce que le code ne fait pas ? Dixième demande ; j'en ai corrigé neuf.
5. Les nouveaux codes de refus : sont-ils tous atteignables, tous distincts, et
   disent-ils assez pour qu'on retrouve la cause sans lire le source ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. C'est la
   condition de merge, et douze passes durent depuis hier soir.

## Hors périmètre

`down.ts`, `sweepRecordedChildren`, la boucle non-postgres et `taskkill /T` —
**issue #100**, ouverte ; la revérification par pid de `runUp` sans test (acté
passes 6 à 8) ; le reste de `up.ts` ; style, nommage.

## Ce dont je doute moi-même

Rien de précis, et c'est en soi un signal à surveiller : douze passes ont
chacune trouvé quelque chose de vrai, et je n'ai plus de doute nommable à te
donner. Si tu en trouves un que je n'ai pas su formuler, c'est exactement ce
qu'il faut me dire.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité), puis les six
questions avec « tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE
ligne : « rien de neuf », « des constats », ou « la forme est en cause ».
