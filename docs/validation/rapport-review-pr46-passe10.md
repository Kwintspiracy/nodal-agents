# Rapport — review Codex PR #46, passe 10 — boucle close sur v7-C

Périmètre : le commit `c97dc8ae`. Sandbox lecture seule, tout marqué **NON
EXÉCUTÉ**.

**Aucun constat bloquant.**

## Ce que Codex a vérifié

**Le refus d'un manifeste qui est un lien est correct.** `O_NOFOLLOW` est bien
absent des drapeaux Windows, le repli à zéro est le bon, et `lstat` refuse le
lien au moment du contrôle. Sur les plateformes qui ont le drapeau, l'ouverture
refuse le dernier composant de façon atomique. Le commentaire ne prétend pas
fermer la course qui subsiste sous Windows, et c'est exactement ce qu'il dit.

**Refuser un chemin inexistant n'est pas une régression** : un projet qui
n'existe pas ne peut fournir aucun manifeste. Codex relève un effet de bord
acceptable : toute erreur de résolution, pas seulement « absent », devient
« introuvable ». Un chemin inaccessible n'était pas un cas de découverte
réussie.

**La boucle de lecture est correcte**, argument par argument : l'écriture reprend
après les octets déjà lus, la longueur ne peut pas dépasser le tampon, la
position suit malgré les lectures courtes. Un fichier exactement au plafond est
accepté entier ; un octet de plus est refusé sur l'octet sentinelle. Aucune
boucle infinie sur un fichier régulier stable, aucun dépassement, aucune
troncature d'un fichier valide.

## Bilan de la boucle sur v7-C

| Passe | Ce qu'elle a trouvé | Suite |
|---|---|---|
| 8 | La garde de périmètre comparait des chemins lexicaux ; un nom de script ne dit pas ce qu'il lance ; `pytest` détecté dans un commentaire ; les virgules finales faisaient disparaître un `deno.jsonc` ; la lecture n'était pas bornée ; un titre de test promettait plus que son corps | Six correctifs |
| 9 | Le manifeste pouvait lui-même être un lien ; un chemin inexistant était accepté sur sa forme écrite ; une lecture courte pouvait faire passer un fichier trop gros pour un fragment | Trois correctifs, une fenêtre TOCTOU nommée et laissée ouverte avec sa raison |
| 10 | Rien | Boucle close |

## Les deux boucles de la session

| Brique | Passes | Bloquants trouvés | Bloquants restants |
|---|---|---|---|
| v7-A — le type de livrable vient de l'outil | 5, 6, 7 | 4 | 0 |
| v7-C — la découverte des commandes | 8, 9, 10 | 3 | 0, plus une fenêtre TOCTOU documentée |

Aucune passe n'a redécouvert un constat déjà traité, et la dernière de chaque
boucle n'a rien trouvé. Deux boucles qui convergent, pas deux PR de mauvaise
forme.
