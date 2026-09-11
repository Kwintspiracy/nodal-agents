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
- **En ligne** : Cloudflare Pages, dès que les secrets sont posés (issue #67).
- **Nuit** : `qa.yml` mesure tout à 03:17 UTC et pousse ses données sur `main`
  ; `alerte.mjs` ouvre UNE issue quand quelque chose est rouge.

## Le Kanban, et comment on y écrit

Six colonnes, DÉDUITES, jamais rangées à la main :

| Colonne | Ce qui y va | Comment on l'y met |
|---|---|---|
| À faire | ce qui attend un geste ou un arbitrage de Quentin | issue avec l'étiquette `décision` |
| En cours | un chantier ouvert | issue ouverte sans `décision` ni `test` |
| En review | une PR ouverte | `gh pr create` |
| À tester | quelque chose à éprouver | issue avec l'étiquette `test` |
| Fait | issue fermée, PR mergée | `gh issue close`, merge |
| Abandonné | PR fermée sans merge | `gh pr close` |

Étiquettes : `décision` `sécurité` `test` `dette` `coût` `produit`.

Donc : **un next step qui n'a pas d'issue n'existe pas.** Un « à faire par
Quentin » est une issue `décision`. Un doute à vérifier est une issue `test`.
Un lot planifié est une issue `produit` jusqu'à ce qu'une PR le porte.

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
