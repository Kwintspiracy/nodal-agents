# Demande de review — PR #46, passe 25 (P4b : la barre d'état et le panneau de coût)

Périmètre : **le commit P4b qui suit le commit P4a** (apps/web :
`space-cost.ts` + test, `StatusBar.tsx` + test, `getSpaceConversationAction`
étendue, `spaces/[id]/page.tsx`). À relire avec la passe 24 (P4a, l'estimateur).

## Ce que ça pose (plan « De la maquette au produit », P4)

- **`aggregateSpaceCost`** (pur, testé au centime) : les appels LLM du job et
  de tous ses descendants, groupés par agent (modèles, appels, jetons, part de
  cache, coût — `null` si aucun appel tarifé, et le nombre d'appels sans prix
  compté à part) ; l'attente humaine = Σ (`resolved_at − requested_at`) des
  approbations tranchées du pipeline ; le temps de preuve = Σ `duration_ms`
  des commandes de preuve ; la durée = du début du job à sa fin, ou à
  maintenant s'il court.
- **`StatusBar`** (client) : la barre permanente en bas — preuve (dernière
  séquence : verte, rouge, `infra_error`, ou « no proof »), modèles, agents,
  jetons avec part de cache, coût (« partial » si un appel n'a pas de prix,
  « n/a » si aucun), durée, envois en attente, « running… » si le job court.
  Jetons et coût ouvrent le panneau « What this work cost » : des phrases
  d'abord (part du cache, coût, attente, preuve), puis le détail par agent
  (DS `Table`) et la répartition cache lu / cache écrit / frais / sortie.
- La page passe `cost`, le verdict de la dernière séquence, le nombre de
  séquences, les envois en attente.

## Mesuré

`space-cost.test.ts` : deux agents, un appel sans prix, une approbation
tranchée en 3 min et une non tranchée, une preuve de 401 s, un job de 18 min →
chaque champ vérifié ; ordre par coût décroissant. `StatusBar.test.tsx` : la
barre dit ce qu'elle doit, et « n/a » plutôt que 0. Capture du rendu statique
avec le CSS compilé (scratchpad de session). `tsc` propre.

## Ce dont je doute moi-même

### La barre est `sticky bottom-0` dans le corps de `PageShell`

Elle colle au bas de la zone de défilement de la page, pas à la fenêtre si le
shell scrolle un conteneur interne. Vérifier `PageShell` : qui scrolle ?

### `durationMs` d'un job qui court = « maintenant » au rendu serveur

Le fil est relu toutes les 3 s (`LiveRefresh`) : la durée avance par sauts de
3 s. Acceptable ; le dire.

### Les appels sans prix

Un appel sur un modèle non tarifé (`groq`, `mistral`, et tout modèle absent du
catalogue) a `cost_usd` NULL : le total dit « partial », jamais un 0. Est-ce
assez visible, ou faut-il nommer le modèle fautif dans le panneau ?

### Le coût des lignes déjà écrites

`llm_calls.cost_usd` des runs d'hier a été calculé sans remise de cache par le
runner d'hier : le panneau les montre tels quels. Pas de recalcul rétroactif —
il faudrait relire les prix d'hier, pas ceux d'aujourd'hui.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
