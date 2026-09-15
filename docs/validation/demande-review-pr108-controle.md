# Demande de review — PR #108, passe de CONTRÔLE sur la forme réduite

La forme a changé, sur arbitrage de Quentin après quatre passes. **Une seule
passe de contrôle**, sur la nouvelle forme, pas sur l'ancienne.

## Ce qui a été RETIRÉ

La garde qui refusait le succès d'un parent par-dessus une délégation ratée, et
ses quatre approximations successives. Elle posait une question que le runner ne
peut pas trancher — « le travail manquant a-t-il été fait autrement ? » —, et les
quatre passes ont cassé les quatre réponses (le détail est dans le corps de la
PR, section « What the runner does NOT decide, and why »).

## Ce qui RESTE, et qui doit tenir

1. Un job sans livrable ÉCHOUE (`empty_deliverable`) — après un rappel unique.
2. L'échec du spécialiste arrive au parent dans un enregistrement typé.
3. Le résultat LIVRÉ porte une ligne écrite par le harnais nommant le
   spécialiste qui n'a rien rendu — posée APRÈS la finalisation, sans quoi elle
   remplaçait le livrable au lieu de s'y ajouter.
4. Une LIVRAISON ratée bloque toujours : « rien n'est parti » se vérifie.
5. Le prompt garde l'interdiction explicite du message d'attente.

Cette passe relit le dernier commit.

Sandbox lecture seule. Deux verdicts : **le constat tient** ou **le constat est
faux**.

## Questions, par priorité

### P0

1. Les cinq points ci-dessus tiennent-ils dans le code ? Cite les lignes.
2. **Le retrait a-t-il cassé quelque chose** que la PR garantissait par
   ailleurs ? Un chemin qui passait par la garde et qui ne passe plus par rien.
3. La ligne d'échec peut-elle MANQUER là où elle compte — un parent sur Telegram
   dont la livraison part avant la finalisation, un job repris, un enfant dont
   l'échec n'est connu que du grand-parent ?
4. Peut-elle au contraire apparaître à tort — une délégation qui a livré, un
   report, un `assign_*` rejoué ?

### P1

5. Reste-t-il un commentaire ou un test qui décrit la garde retirée ?

### P2

6. Si tu ne trouves **rien de neuf**, dis-le à la dernière ligne.

## Hors périmètre

L'issue #115 ; les autres PR ouvertes ; `apps/qa` ; le style.

## Forme du rapport

Les constats d'abord (fichier:ligne, déclenchement, gravité — **BLOQUANT /
IMPORTANT / MINEUR** —, ET le SENS de l'erreur), puis les six questions avec
« tient » / « constat » / « NON TRANCHÉ ». Terminer par UNE ligne : « rien de
neuf », « des constats », ou « la forme est en cause ».
