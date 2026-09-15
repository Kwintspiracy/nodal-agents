# Demande de review — PR #108, passe 3

Passe 2 : quatre constats, un bloquant, un important, deux mineurs. Tous fondés,
tous corrigés. Le bloquant portait contre le correctif de la passe 1 — effacer
les délégations ratées dès qu'une autre livre confond « quelque chose a été
produit » avec « le travail manquant a été fait ».

Ce que la machine peut constater, et qui décide maintenant : **un appel d'outil
a RÉUSSI après l'échec**. L'incident #107 n'en avait aucun. Une LIVRAISON ratée,
elle, bloque toujours.

Corrigés aussi : la marque du rappel (un texte ordinaire qu'un utilisateur
pouvait recopier, privant son agent de son unique rappel) et deux commentaires.

Cette passe relit le dernier commit.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## LA question de fond, la même

**Où un modèle performant peut-il encore rendre du VIDE au parent ou à
l'utilisateur ?** Tout le chemin : `assign_<slug>` → sous-job → finalisation →
`resume` → livraison.

## Questions, par priorité

### P0

1. La question de fond.
2. Le critère « un outil a réussi depuis » est-il exploitable pour faire passer
   un travail jamais fait ? Un outil de lecture, un outil qui échoue à moitié,
   un outil appelé AVANT l'échec et dont le résultat arrive après ?
3. Reste-t-il un chemin où un parent annonce une attente à l'utilisateur ?

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
