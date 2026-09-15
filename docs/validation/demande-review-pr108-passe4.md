# Demande de review — PR #108, passe 4 (dernière du budget)

Passe 3 : cinq constats, trois bloquants. Les trois portaient contre le critère
que j'avais introduit en passe 2 — « un outil a réussi depuis l'échec » — et les
trois tenaient : une LECTURE comptait, l'envoi de la PROMESSE comptait (elle se
prouvait elle-même), et relu dans la transcription un report ou une erreur
sérialisée comptaient aussi, alors que la transcription ne dit même pas l'ordre.

Le critère est maintenant le plus étroit que la machine puisse vérifier : **une
autre DÉLÉGATION a livré**. Les deux autres issues du rappel — refaire soi-même,
dire la vérité — ne finissent PAS en succès, et c'est la réponse du produit :
le travail délégué n'a pas eu lieu. `status='blocked'` porte la raison jusqu'à
l'utilisateur, et un test l'épingle.

Cette passe relit le dernier commit. **C'est la dernière du budget** : si tu
trouves encore un BLOQUANT, dis-le clairement — c'est la forme de cette PR qui
sera en cause, et je m'arrêterai là au lieu d'enchaîner une cinquième passe.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## LA question de fond, la même

**Où un modèle performant peut-il encore rendre du VIDE au parent ou à
l'utilisateur ?**

## Questions, par priorité

### P0

1. La question de fond.
2. Le critère « une autre délégation a livré » est-il contournable ? Une
   délégation au MÊME spécialiste qui livre autre chose, un enfant qui livre
   trois mots, un `assign_*` dont le résultat n'est ni `error-text` ni un vrai
   livrable.
3. Les deux issues qui échouent (refaire soi-même, dire la vérité) laissent-elles
   l'utilisateur sans explication dans un cas ?

### P1

4. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

5. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les autres PR ouvertes ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les cinq questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
