---
name: suivi
description: Discipline de suivi des progrès. Le suivi vit SUR LE PORTAIL QUALITÉ (apps/qa) et nulle part ailleurs — son Kanban est déduit des issues et PR GitHub. Toute session de code se termine par « chaque next step a son issue » et un rendu du portail. Invoquer quand Quentin dit /suivi, « où on en est », ou À LA FIN de toute session de code, sans qu'il ait à le demander.
---

# /suivi — le suivi vit sur le portail, pas dans un artifact

Règle de Quentin, 12/09/2026 : **« assure-toi de suivre et tracker les progrès
sur ce portail uniquement »**. Le 10/09 déjà : « j'en ai marre de travailler
avec des artefacts, des fichiers de reports en MD ».

Avant, un plan vivait dans un artifact Claude republié à chaque session, et un
backlog vivant à côté. Deux documents, deux états, et l'un des deux finissait
toujours par mentir — parce qu'ils étaient ÉCRITS. Le portail, lui, ne lit que
des faits : issues, PR, exécutions de CI, rapports de tests.

## Le portail

- **Code** : `apps/qa` — `collect.mjs` rassemble, `build.mjs` rend, `serve.mjs`
  sert (port 4310).
- **Local** : `pnpm --filter @nodal-agents/qa render` puis
  `pnpm --filter @nodal-agents/qa serve` → http://localhost:4310.
  `collect` avant `render` pour un Kanban et des mesures frais (il interroge
  `gh`, il écrit dans `apps/qa/data/` — ne PAS committer une collecte locale).
- **En ligne** : GitHub Pages, sous `/qa/`, publié par `docs.yml` avec les docs.
- **Nuit** : `qa.yml` mesure tout à 03:17 UTC et pousse ses données sur `main`
  ; `alerte.mjs` ouvre UNE issue quand quelque chose est rouge.

## Le Kanban, et comment on y écrit

Six colonnes, DÉDUITES, jamais rangées à la main :

| Colonne | Ce qui y va | Comment on l'y met |
|---|---|---|
| To do | ce qui attend un geste ou un arbitrage de Quentin | issue avec l'étiquette `decision` |
| In progress | un chantier ouvert | issue ouverte sans `decision` ni `test` |
| In review | une PR ouverte | `gh pr create` |
| To test | quelque chose à éprouver | issue avec l'étiquette `test` |
| Done | issue fermée, PR mergée | `gh issue close`, merge |
| Abandoned | PR fermée sans merge | `gh pr close` |

Étiquettes (elles sont en anglais : le dépôt est public) : `decision` `security`
`test` `debt` `cost` `product`.

Donc : **un next step qui n'a pas d'issue n'existe pas.** Un « à faire par
Quentin » est une issue `decision`. Un doute à vérifier est une issue `test`.
Un lot planifié est une issue `product` jusqu'à ce qu'une PR le porte.

## Toute issue ou PR ouverte par un agent porte ses faits vérifiés

**Règle du 16/09/2026, née d'un mensonge de quatre jours.** Le 12/09 un agent a
ouvert l'issue #68 « Publish 0.8.9 » DE MÉMOIRE : 0.8.9 était sur npm depuis le
09/09. Le portail l'a portée quatre jours comme un travail à faire, et Quentin :
« je ne peux ni avoir confiance en toi ni dans mon dashboard ».

Le corps de toute issue ou PR qu'un agent ouvre porte donc une section
`## Verified` avec **au moins une commande et sa sortie** — pas une affirmation,
la commande et ce qu'elle a répondu :

```markdown
## Verified

`npm view nodal-agents version` → 0.8.9
`git describe --tags --abbrev=0 --match "v*"` → v0.8.9
`pnpm --filter @nodal-agents/qa test` → 291 passed
```

Le portail le contrôle lui-même, il ne fait confiance à personne : une carte
OUVERTE dont le corps porte le pied d'un agent (« Generated with Claude Code »,
ou la ligne `Claude-Session`) et **pas** de section `## Verified` s'affiche avec
une pastille « no verified facts » et compte dans l'alerte. Une issue écrite à
la main par Quentin n'est jamais concernée : la règle vise les agents, et le
critère est vérifiable plutôt que deviné au style.

Le portail vérifie aussi l'état de publication lui-même (`npm view` + `git`,
bloc « Release » en tête du tableau) et nomme toute carte ouverte qui demande de
publier une version déjà sur npm. C'est exactement #68, désormais dit à voix
haute au lieu d'être cru.

## Fin de session de code — le rituel

Déclenché **sans que Quentin le demande**, dès qu'une session a produit du
code (commit, PR, correctif). Trois gestes :

1. **Chaque next step a son issue**, avec la bonne étiquette ; chaque chose
   finie a son issue FERMÉE avec un commentaire qui nomme la PR. Ce que les
   revues ont trouvé et qui reste ouvert devient une issue — un constat qui
   n'atterrit pas dans le Kanban est un constat qui sera redécouvert.
2. **Rendre le portail** (`render`, et `collect` si le Kanban doit être frais)
   et vérifier http://localhost:4310 répond.
3. **Dire les next steps** dans la réponse, classés : ce que je peux faire seul
   / ce qui attend un geste de Quentin / ce qui attend une décision — avec le
   numéro d'issue de chacun.

## Ce qui reste dans `docs/plans/`

Les fichiers `docs/plans/*.md` sont des documents de CONCEPTION : le quoi, le
pourquoi, et « ce que la vérification a corrigé dans ce plan ». Ils restent
versionnés et utiles. Ils ne portent plus de tableau d'état à tenir à jour :
l'état est sur le portail. **Ne plus republier d'artifact de suivi.** Le
backlog vivant (artifact `58ca4f80…`) est gelé au 11/09 ; sa réserve P5 y
reste lisible tant qu'elle n'a pas été convertie en issues.

## Pièges appris

**Un plan raconté dans une réponse de chat est perdu à la session suivante.**
D'où l'issue : elle survit à la session, au compactage, et à la branche.

**Un commentaire de fermeture nomme la PR.** Sans lui, « Fait » ne dit pas par
quoi, et le portail ne peut pas le retrouver.

**Ne pas committer `apps/qa/data/` depuis une collecte locale** : c'est la
mesure nocturne qui écrit là, sur `main`, avec son horodatage et son commit.
