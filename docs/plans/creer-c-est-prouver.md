<!-- artifact: https://claude.ai/code/artifact/cf176df0-f7ab-4f50-a79c-658e955b902d -->

# Créer, c'est prouver — la PR qui suit

> Une PR, un lot, mergée dans la semaine. C'est la règle prise le 07/09 après
> une PR de 70 000 lignes que plus personne ne pouvait relire.

## Le sujet, en une phrase

**Quand un agent crée quelque chose, l'écran doit dire ce qu'il a fait, et
Nodal doit le vérifier — sans que tu aies rien à configurer.**

Les quatre points viennent tous de la même session du 07/09, sur la
conversation « Créer un skill avec CSS et HTML ». Trois affirmations s'y
contredisaient en apparence, et l'écran cachait la seule chose qui aurait
donné raison à Quentin.

## Suivi

> Écrit le 11/09/2026 sur `feat/creer-c-est-prouver`, une seule PR. Revue
> Codex à suivre avant merge.

| # | Ce qui change | Pour qui l'utilise | Taille | État |
|---|---|---|---|---|
| 1 | Le nom du fichier se lit sur la carte | on voit enfin QUELS fichiers ont été écrits | S | 🔄 écrit, en review |
| 2 | La consigne passée au travail se déplie | on voit ce que l'agent a vraiment demandé au job | S | 🔄 écrit, en review |
| 3 | Un fichier créé est typé pour ce qu'il EST | un skill n'est plus un « projet de code » | M | 🔄 écrit, en review |
| 4 | Un document se vérifie tout seul | « Vérifié » veut enfin dire quelque chose | M | 🔄 écrit, en review |
| 5 | La page Approvals passe en anglais | le tableau de bord parle une seule langue | XS | 🔄 écrit, en review |

## Ce que la vérification a corrigé DANS CE PLAN

**Le point 3 disait « sous un projet DÉCLARÉ ⇒ code ». Seul, c'était faux.**
Le registre se remplit tout seul (P5b) à partir des cibles `code_project` qui
portent un manifeste : ne regarder que la déclaration aurait typé `document` le
premier `package.json` d'un dépôt neuf, et plus rien ne l'aurait jamais déclaré.
La règle est donc : racine à MANIFESTE **ou** projet déclaré de `kind = 'code'`
⇒ `code_project` ; sinon `document`. Et un projet déclaré de `kind =
'documents'` ne fait pas de ses fichiers du code — le plan ne connaissait pas
cette colonne.

**Le point 4 disait « un HTML se referme », et le parseur HTML5 ne le dit
pas.** La norme referme d'elle-même un `<div>` resté ouvert à `</body>`, et
`parse5` ne signale rien. Le constat lit donc les balises une à une (le
tokenizer de `parse5`) et tient la pile des éléments dont la fermeture est
obligatoire — ni les vides, ni ceux dont la norme permet d'omettre la fin.
Tolérances assumées : pas de doctype, et `<br/>`.

**Le contrat des vérificateurs décrivait une séquence de commandes**, pas un
constat sans commande : `ReadyConfig` gagne un champ `subject` (le fichier
lui-même). `cwd` ne portait pas le nom du fichier.

**Trois tests anciens affirmaient que `document` était REFUSÉ** (« réservé,
sans canonicaliseur »). Ils ont été reportés sur `other`, comme leur propre
commentaire le prévoyait. Deux autres écrivaient dans un dossier sans manifeste
en attendant un `code_project` : ils reçoivent un `package.json`, parce que
c'est bien un projet de code qu'ils voulaient prouver.

**Trois parseurs entrent dans le runner** : `css-tree` 3.2.1, `parse5` 8.0.1,
`@xmldom/xmldom` 0.9.12 — tous purs JS, bundlés par esbuild.

## Ce que Quentin verra changer

**Trois fichiers écrits ne se ressemblent plus.** Aujourd'hui la carte affiche
le chemin absolu, coupé à droite : trois écritures affichent trois fois le même
préfixe et jamais le nom du fichier. Quentin a cru voir « trois diffs sur le
même fichier ». C'étaient `SKILL.md`, `base.css` et `base.html` — exactement les
trois fichiers qu'il avait demandés. Le nom passe devant, le dossier derrière.

**La consigne passée au travail devient lisible.** La ligne « Handed to the
work » est tronquée à une ligne. Or elle porte 1 649 caractères, et c'est là
qu'on voit qu'Alfred a inventé des exigences (« Requirements: 1. … ») que
personne ne lui avait données. Quentin le lui a reproché ; l'écran lui cachait
la preuve. Elle se déplie.

**Un skill cesse d'être un projet de code.** L'outil d'écriture étiquette tout
ce qu'il écrit « projet de code ». Nodal cherche alors les commandes de test du
dossier, n'en trouve pas, et affiche « non configuré » sur un travail qui
n'avait aucun test à lancer. Un fichier n'appartenant à aucun projet déclaré est
désormais un `document`.

**Et un document se vérifie, sans réglage.** C'est la règle de Quentin, du
07/09 : *« une vérification a lieu dès qu'il y a création de quelque chose »*.
Pour un document, cela ne veut pas dire lancer des tests — cela veut dire
constater qu'il existe, qu'il se lit, qu'il n'est pas vide, et qu'il est bien
formé selon son type : un markdown a un titre, un CSS s'analyse, un HTML se
referme. Rien de tout cela n'exécute quoi que ce soit : aucune approbation,
aucun écran, aucune configuration.

## Ce que ça ne contient PAS, et pourquoi

- **Le coût d'un tour de chat** (18 500 jetons pour dire bonjour, quatre
  chantiers mesurés le 07/09). C'est la PR d'après. Les mélanger referait une
  PR fleuve.
- **Les commandes de projet découvertes et approuvées dans le canal** (v7-C) et
  **les critères tirés de la demande** (v7-D). Ils supposent le typage de cette
  PR.
- **Le vérificateur d'envoi** (`outbound_action`, « le message est-il arrivé »).
  Il lit l'outbox, pas un fichier : c'est un autre chemin, un autre lot.
- **« New conversation » sur la page Files** : c'est un arbitrage de Quentin,
  pas un chantier. Je ne le retire que s'il le dit.

## Les cinq points, en détail

### 1 · Le nom du fichier se lit — S

`FileDiff` et la ligne d'un fichier seulement lu affichent `{path}` avec
`truncate` : sur un chemin absolu, le nom disparaît toujours. Le nom de base
passe en tête, dans la couleur de l'encre ; le dossier suit, en gris, tronqué
par la GAUCHE (c'est la fin d'un chemin qui porte le sens). Le chemin complet
reste au survol.

*Preuve* : rendu HTML sur trois fichiers d'un même dossier — les trois noms se
distinguent, et aucun ne contient le préfixe commun.

### 2 · La consigne passée au travail se déplie — S

L'item `handoff` du fil est un `<p class="truncate">`. Il devient un bloc
dépliable : une ligne repliée, la consigne entière dépliée, dans le style des
notes. Pas de bouton neuf : `DisclosureButton` existe.

*Preuve* : un handoff de 1 649 caractères se lit en entier une fois déplié ;
replié, il tient sur une ligne.

### 3 · Un fichier créé est typé pour ce qu'il est — M

`file_write` et `file_edit` déclarent `deliverableType: 'code_project'` en dur
(`file-write.ts:78`, `file-edit.ts:83`). Le plan v7-A disait pourtant :
*« `code_project` seulement si le fichier appartient au projet ; sinon
`other` »*. La brique a déplacé la décision vers l'outil sans changer sa
réponse.

La règle devient mécanique, zéro LLM : le fichier est-il sous un projet
DÉCLARÉ (`code_projects`, `registered_at` non nul) ? Alors `code_project`,
comme aujourd'hui. Sinon `document`.

⚠️ **Le type `document` est refusé aujourd'hui** : `intent.ts:279` lève
`intent_type_unsupported` pour `document`, `outbound_action` et `other`, faute
de canonicaliseur. Il faut donc écrire celui de `document` DANS cette PR — le
chemin canonique du fichier, la même règle que `canonicalChangePath` déjà
partagée par la page Code et le fil. Sans cela, typer un skill en `document` le
ferait échouer au lieu d'être vérifié.

*Preuve* : un fichier écrit dans un projet déclaré reste `code_project` ; le
même fichier écrit dans le dossier partagé devient `document` ; les deux
produisent une ligne d'état, aucun ne lève.

### 4 · Un document se vérifie tout seul — M

Un vérificateur `document`, **sans pouvoir** : il ouvre le fichier, rien de
plus. Il constate quatre choses, et il les DIT plutôt que de rendre un score :

| Constat | Vrai pour |
|---|---|
| le fichier existe à l'endroit annoncé | tous |
| il n'est pas vide | tous |
| il se décode en UTF-8 | tous |
| il est bien formé | `.md` a un titre · `.css` s'analyse · `.html`/`.svg`/`.json` se parsent |

Une extension inconnue s'arrête aux trois premiers constats — et le dit, plutôt
que d'inventer une règle.

Le résultat s'écrit dans `verification_runs` comme n'importe quelle preuve : le
récapitulatif de livraison et la barre d'état n'ont rien à apprendre, ils
lisent déjà cette table. « Vérifié » devient vrai, ou rouge avec sa raison.

*Preuve* : un markdown sans titre est rouge et dit pourquoi ; un CSS invalide
est rouge ; les trois fichiers du skill sont verts ; un fichier supprimé entre
l'écriture et la vérification est rouge, pas absent.

### 5 · La page Approvals en anglais — XS

`ApprovalActions.tsx` dit « Approuver une fois », « Toujours pour ce serveur »,
« Toujours pour cet outil » dans un tableau de bord anglais. Vu le 07/09,
jamais traité.

## Sa place dans la file

Cette PR passe **après** les deux de « Parler, c'est se souvenir »
(`docs/plans/parler-c-est-se-souvenir.md`, 08/09) : un agent qui republie une
annonce dans un Discord public, et qui répond aux accusés de réception de ses
propres messages, coûte plus cher qu'un nom de fichier tronqué.

## L'ordre interne, et pourquoi

1 et 2 d'abord : ce sont des heures, et ils rendent lisible le fil sur lequel
on va juger le reste. Puis 5, qui est une minute. Puis 3, qui ne casse rien
tant que 4 n'existe pas — mais **3 sans 4 rendrait un skill non vérifiable au
lieu de mal vérifié**, donc les deux partent ensemble, dans cet ordre, dans la
même PR.

## Ce qui reste vrai après cette PR, et qu'elle ne prétend pas régler

- Un agent peut toujours écrire « vérifié » dans sa prose sans que rien ne
  l'ait prouvé. Le mot lui appartient ; l'écran dira juste, à côté, ce que
  Nodal a réellement constaté.
- Un agent en runtime CLI n'écrit pas ses appels dans `llm_calls` : son fil ne
  peut compter ni jetons ni coût (revue Codex, passe 65). La barre dit « no
  usage recorded » plutôt qu'un faux zéro.
- La création d'un agent n'est pas une transaction, et supprimer le ROOT n'a
  pas de règle de succession (revue Codex, passe 64, backlog du harnais).
