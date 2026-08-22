---
name: suivi
description: Discipline de suivi des plans de travail. Tout plan vit dans docs/plans/ et est publié en Artifact avec une URL STABLE ; un plan peut couvrir plusieurs PR. Toute session de code se termine par la mise à jour de l'artifact et une proposition de next steps. Invoquer quand Quentin dit /suivi, « où on en est », « mets à jour le plan », ou À LA FIN de toute session de code, sans qu'il ait à le demander.
---

# /suivi — le plan est un artifact vivant, pas un message de chat

Un plan raconté dans une réponse de chat est perdu à la session suivante. Un
plan dans un fichier local, Quentin ne le voit pas sans changer de branche
(c'est arrivé le 22/08 : trois plans de review sur trois branches, dont deux
invisibles depuis son dossier). Un plan republié depuis un autre chemin devient
une deuxième URL, et l'historique se scinde en silence.

D'où les trois règles de ce skill.

## Les trois règles

| Règle | Pourquoi |
|---|---|
| **Tout plan est publié en Artifact** | Quentin le lit sans changer de branche, sans lancer Nodal, depuis n'importe quel appareil |
| **Un plan couvre N PR** | Le lot est l'unité de travail, pas la PR. Une PR qui se scinde ne crée pas un second plan |
| **Toute session de code se termine par : artifact à jour + next steps** | Sans ça, la session suivante repart d'une reconstitution, et la reconstitution invente |

## Anatomie d'un plan

**Source** : `docs/plans/<slug>.md`, versionné dans le dépôt.
**Publication** : un Artifact, dont l'URL est inscrite **en tête du fichier
source**.

```markdown
<!-- artifact: https://claude.ai/code/artifact/<uuid> -->
```

Cette ligne est le mécanisme central. Sans elle, la session suivante republie
depuis zéro, obtient une **nouvelle URL**, et Quentin se retrouve avec deux
plans divergents dont aucun n'est faux — le pire cas.

### À la publication

1. Écrire / mettre à jour `docs/plans/<slug>.md`.
2. Chercher la ligne `<!-- artifact: ... -->` en tête.
   - **Présente** → `Artifact` avec `url:` = cette URL. Mise à jour en place.
   - **Absente** → publier sans `url`, puis **écrire l'URL rendue en tête du
     fichier et la committer**. Ne jamais reporter à plus tard : c'est à ce
     moment précis que le lien se perd.
3. Si le plan vient d'une session antérieure et que la ligne manque :
   `Artifact` avec `action: "list"` pour retrouver l'URL. Ne PAS republier à
   l'aveugle.

Le `favicon` et le `<title>` restent **identiques** entre les republications —
Quentin retrouve son onglet par son icône.

## Ce que le plan contient

Un tableau de suivi, en tête, qui répond à « où on en est » en une ligne :

| # | Lot | PR | État |
|---|-----|----|----|
| 1 | Continuité de session | #7 | ✅ mergée |
| 2 | Conscience du dépôt | #7 | ⬜ en cours |
| 3 | Prix du catalogue | #9 | 🔄 en review |

Puis, pour chaque lot : ce qui est fait, ce qui reste, **et ce que la
vérification a corrigé dans le plan lui-même**. Cette dernière colonne est la
plus utile à relire : c'est là qu'on voit qu'un plan affirmait quelque chose de
faux et sur quelle preuve il a été corrigé.

### Ce qu'un plan ne contient PAS

- Du code. Le plan dit quoi et pourquoi, la PR dit comment.
- Des affirmations non vérifiées. Si une ligne du plan n'a pas été vérifiée
  dans le code ou la base, elle porte la mention **« à vérifier »**. Un plan
  qui affirme est un plan sur lequel on construit ; s'il affirme faux, tout ce
  qui suit est faux.

## Fin de session de code — le rituel

Déclenché **sans que Quentin le demande**, dès qu'une session a produit du code
(commit, PR, correctif). Trois gestes, dans cet ordre :

### 1. Mettre le plan à jour

États des lots, PR ouvertes/mergées, et surtout : **ce que les reviews ont
trouvé**. Un constat de review qui n'atterrit pas dans le plan est un constat
qui sera redécouvert.

### 2. Republier l'artifact

Même URL. Donner le lien dans la réponse.

### 3. Proposer les next steps

Pas un résumé de ce qui vient d'être fait — Quentin l'a lu. **Ce qui vient
après**, classé, avec pour chacun : ce qui bloque, et ce que ça coûte.

Distinguer explicitement :

| Catégorie | Exemple |
|---|---|
| **Ce que je peux faire seul** | finir un lot, traiter un rapport de review |
| **Ce qui attend un geste de Quentin** | `npm publish`, révoquer un token, tester sur Linux |
| **Ce qui attend une décision** | un arbitrage de périmètre, deux options défendables |

Ne jamais terminer une session sur un constat sans next step. Une session qui
se termine par « voilà, c'est fait » oblige Quentin à réfléchir à ce qui suit —
c'est exactement le travail qu'il délègue.

## Pièges appris

**Un `Artifact` republié depuis un chemin de fichier différent crée une
nouvelle URL.** Le chemin source est aussi important que le contenu.

**Un plan de review appartient à la PR qu'il relit**, pas à la branche où on se
trouvait en l'écrivant. Vérifier la branche AVANT de committer un document de
suivi (erreur commise le 22/08 : le plan de la #7 committé sur la branche de la
#8, donc invisible pour le relecteur).

**Le dossier de travail ne montre que la branche courante.** Un fichier
committé sur une autre branche est absent du disque, pas perdu. C'est la raison
d'être de l'artifact : il ne dépend d'aucune branche.

**Une session compactée perd le détail, pas le plan.** C'est précisément
pourquoi le plan doit être écrit AVANT d'en avoir besoin, pas reconstitué après.
