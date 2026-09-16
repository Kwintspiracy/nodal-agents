# Demande de review — PR #108, passe 2

Passe 1 : sept constats, deux bloquants, cinq importants. Tous fondés, tous
corrigés.

- **1 (bloquant)** — un livrable fait d'ESPACES finalisait un succès : le chemin
  texte testait `if (textContent)` là où la garde du vide lit après `trim()`.
- **2 (bloquant)** — la promesse pouvait être rendue en TEXTE SEUL. La garde
  vivait dans la branche `return_result` ; sur `api` et `dashboard` un parent
  finit son job par un simple texte. Elle vit maintenant sur les deux chemins.
- **3** — une délégation de secours réussie n'effaçait pas l'échec de la
  première : obtempérer au rappel menait quand même à l'échec.
- **4** — un sous-agent qui délègue perdait SA synthèse : la compilation des
  enfants remplissait `result` avant qu'on regarde son texte.
- **5** — un parent dont l'enfant a livré pouvait être déclaré vide.
- **6** — cinq skills du catalogue prescrivaient encore l'ancien contrat.
- **7** — « un seul rappel » ne valait que d'une exécution.

Cette passe relit les deux derniers commits.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## LA question de fond, la même

**Où un modèle performant peut-il encore rendre du VIDE au parent ou à
l'utilisateur ?** Tout le chemin : `assign_<slug>` → sous-job → finalisation →
`resume` → livraison.

## Questions, par priorité

### P0

1. La question de fond.
2. Les correctifs de la passe 1 ouvrent-ils un trou ? En particulier :
   effacer les `assign_*` en échec dès qu'UNE délégation réussit — peut-on
   l'exploiter pour faire passer un travail jamais fait ? Le texte final qui
   l'emporte sur les enfants — peut-il faire perdre le travail des enfants ?
   Le compteur relu dans la transcription — peut-il compter un rappel qui n'en
   est pas un, ou être fabriqué par le modèle lui-même ?
3. Le refus de finaliser sur la branche texte peut-il bloquer un job honnête —
   un parent dont la délégation a échoué mais qui a fait le travail lui-même ?

### P1

4. Reste-t-il une skill du catalogue, une personnalité, un test qui prescrit
   l'ancien contrat de `return_result` ?
5. Reste-t-il un commentaire qui énonce ce que le code ne fait pas ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

Les autres PR ouvertes ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les six questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
