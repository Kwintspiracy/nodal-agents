# Demande de review — PR #108, passe CIBLÉE sur la livraison du harnais

Ne relis QUE le dernier commit (`b29e1705`). Le reste de la PR a eu ses quatre
passes plus une passe de contrôle ; sa forme est arbitrée.

## Ce que cet ajout fait

1. Sur un canal où seul un outil atteint l'utilisateur, le HARNAIS prépare sa
   propre livraison (`prepareDelivery` + `drainDeliveries`) pour ce que le job
   doit faire lire : la ligne d'échec de délégation, la raison d'un `blocked`,
   et l'arrêt d'un job dont les rappels de livraison sont épuisés (#115).
2. La ligne d'échec ne s'efface plus que sur une VRAIE livraison — ni un
   résultat vide, ni une erreur sérialisée en `json`, ni un texte laissé par la
   compaction.
3. Les noms déjà signalés sont RELUS dans le résultat d'un enfant, pour que
   l'échec d'un petit-enfant remonte au grand-parent.

## Questions, par priorité

### P0

1. La livraison du harnais peut-elle DOUBLER un message que l'agent a déjà
   envoyé, ou partir deux fois (reprise, rejeu, deux chemins terminaux) ?
2. Peut-elle MANQUER là où elle compte, ou partir sur un mauvais canal / un
   mauvais `chat_id` ?
3. Le texte préparé peut-il porter autre chose que du texte de plateforme —
   une phrase de l'agent, une donnée d'utilisateur non neutralisée (invariant
   #2, et l'injection par le contenu d'un résultat d'enfant) ?
4. La relecture des noms (expression régulière sur le résultat d'un enfant)
   peut-elle être fabriquée par un modèle qui écrirait cette ligne lui-même ?

### P1

5. Le resserrement de l'effacement crée-t-il un faux positif — une ligne
   d'échec qui reste après une vraie réparation ?
6. Une panne de préparation ou de drain peut-elle faire échouer un job qui a
   fini ?

### P2

7. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

TOUT le reste de la PR ; les autres PR ouvertes ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les sept questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
