# Demande de review — dette de la PR #66, passe 6

Passe 5 : deux constats, dont une **régression que j'avais introduite** en
passe 4. Corrigés dans `bf06773c`, mais pas de la façon dont tu l'aurais peut-être
attendu — j'ai RETIRÉ l'approximation au lieu d'en écrire une cinquième.

Cette passe relit `bf06773c`.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

Lire `git show bf06773c`, le rapport de la passe 5
(`docs/validation/rapport-review-pr66-passe5.md`), puis
`apps/runner/src/verification/document.ts` et son test.

## Ce que la passe 5 a changé

Le retrait du préfixe de conteneur est **supprimé**. À la place, une règle plus
grossière et sûre : **un titre commence en colonne zéro**. CommonMark en tolère
trois d'indentation ; cette tolérance est abandonnée exprès, parce qu'un titre
indenté est presque toujours dans un conteneur que ce vérificateur ne sait pas
suivre.

Le prix est nommé : un document dont le seul titre serait indenté sera dit sans
titre — un ROUGE sur du travail correct. L'autre erreur aurait été un VERT sur
un document sans titre.

`remark-parse` est épinglé dans le dépôt pour ce travail, mais l'ajouter à
`apps/runner` demande un `pnpm install` qui ne passe pas dans cet
environnement. C'est dit, pas tenté.

## Questions, par priorité

### P0

1. Le correctif existe-t-il dans `bf06773c` ? Cite la ligne.
2. **La règle « colonne zéro » est-elle sûre dans TOUS les sens ?** Cherche un
   document où elle rend un VERT qu'elle ne devrait pas — c'est le seul sens qui
   compte. Sonde en particulier : un titre setext en colonne zéro dont le
   soulignement est indenté, un titre après un bloc jamais clôturé, un
   front-matter suivi immédiatement d'un `#`, un fichier d'une seule ligne `#`.
3. Le retrait de l'approximation a-t-il **rouvert** un faux vert que la passe 4
   avait fermé ? Compare explicitement avec les cas de `bec62175`.

### P1

4. Reste-t-il, dans les quatorze correctifs de cette branche, un comportement
   que la passe 1 avait jugé cassé et qui repasserait sans faire rougir un test ?
5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ? La passe 5
   en signalait un « directement créé par ce commit » — est-il corrigé ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne. Et si les
   constats restants ne sont que des cas exotiques de Markdown qui tombent tous
   du côté ROUGE, dis-le aussi : ce n'est pas la même chose qu'un défaut.

## Hors périmètre

Les six autres PR de la dette ; **l'issue #101** ; `apps/qa` ; style, nommage.
L'ajout d'un parseur CommonMark : hors de portée ici, à décider séparément.

## Ce dont je doute moi-même

Que « colonne zéro » suffise. C'est la cinquième forme de cette règle ; les
quatre précédentes semblaient toutes correctes quand je les ai écrites.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité, ET le SENS de
l'erreur : faux vert ou faux rouge), puis les six questions avec « tient » /
« constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de neuf », « des
constats », ou « la forme est en cause ».
