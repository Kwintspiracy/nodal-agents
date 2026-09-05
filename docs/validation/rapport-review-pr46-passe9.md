# Rapport — review Codex PR #46, passe 9

Périmètre : le commit `99077742`. Sandbox lecture seule, tout marqué **NON
EXÉCUTÉ**. Un constat bloquant, deux réponses.

## Le constat bloquant — la garde restait contournable

Codex a raison, et sur un mécanisme que j'avais manqué : la garde canonicalise
le DOSSIER une fois, puis les manifestes sont ouverts par leur chemin. Quatre
scénarios, dont deux n'ont rien d'une course :

| Scénario | Fermé ? |
|---|---|
| Le `package.json` du projet est lui-même un lien vers un fichier extérieur | **Oui.** `O_NOFOLLOW` là où il existe, `lstat` partout. Un manifeste qui est un lien n'est pas lu |
| Le chemin n'existe pas à l'instant de la garde, sa forme écrite est acceptée, un lien créé ensuite est suivi | **Oui.** Un chemin qui ne se résout pas est refusé — il n'a rien à proposer de toute façon |
| Le dossier est remplacé par un lien APRÈS la garde | Non — fenêtre TOCTOU |
| Un composant intermédiaire est remplacé APRÈS la garde | Non — même fenêtre |

**Ce qui reste ouvert, dit plutôt que masqué.** Fermer la fenêtre demande une
traversée par descripteurs (`openat`), que Node n'expose pas. Refaire un
`realpath` juste avant l'ouverture la rétrécirait sans la fermer, et donnerait
l'illusion de l'avoir fermée.

Ce que ça coûte, en portée réelle : l'attaquant doit déjà pouvoir créer un lien
DANS un dossier attaché de la machine du propriétaire, donc disposer d'un shell
que le propriétaire a approuvé. Le gain est de faire apparaître des NOMS de
scripts d'un `package.json` extérieur dans une liste de propositions. C'est une
fuite, elle est réelle, elle est bornée, et elle est écrite ici plutôt que
supposée connue.

## La lecture par descripteur

Codex : un seul `read` n'est pas garanti de remplir le tampon ; un fichier trop
gros pourrait produire une lecture courte, être accepté et décodé comme
fragment. **Vrai.** La lecture boucle maintenant jusqu'à EOF ou jusqu'au
dépassement du plafond.

Codex, encore : « la fermeture est tentée, pas garantie — une erreur de `close`
est avalée ». Exact. Le commentaire ne dit plus « toujours refermé » ; il dit
que la fermeture est tentée et pourquoi son échec est avalé.

## `stripTrailingCommas`

Codex ne trouve ni corruption d'un JSON strict valide, ni boucle : les deux
boucles avancent de façon monotone, les chaînes et leurs échappements sont
suivis, et une virgule suivie d'un commentaire puis d'une fermeture est bien
retirée puisque les commentaires tombent avant. Rien à faire.

## Un test qui se déclare non éprouvé

Le cas « le manifeste est un lien » demande un lien de FICHIER, que Windows
refuse hors mode développeur — un lien de DOSSIER, lui, passe partout, ce qui
explique que le test de jonction s'exécute. Le test est donc **marqué ignoré
avec un code journalisé**, jamais rendu vert. La CI Linux l'exécute à chaque
tour.

## État après la passe

| Suite | Résultat |
|---|---|
| `apps/web` | 1055 (+1 ignoré, nommé) |

Mutation vérifiée sur le refus d'un chemin inexistant.
