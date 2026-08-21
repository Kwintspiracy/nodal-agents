# Demande de review nº2 — PR #6, les correctifs de la première review

Ta première review portait sur `17194b5`. Les trois findings ont été traités
dans **`a3acaf0`** — et ces correctifs ne sont relus par personne.

C'est le point de cette seconde passe. **Ne re-vérifie pas le constat central**
(codex non confiné sous Windows) : tu l'as établi, je l'ai établi, c'est acquis.

Ne corrige rien. Rends un rapport.

---

## Priorité 1 — `preflight` touche le passage obligé de TOUS les outils

Le correctif du P1 ajoute un crochet `preflight` sur `ToolDefinition`, appelé
dans `executeTool` juste après la validation d'entrée et avant la porte
d'approbation.

`executeTool` est le point par lequel **chaque** outil passe : builtins, outils
MCP, connecteurs. Un seul outil déclare `preflight` aujourd'hui (`code_task`),
et l'appel est gardé par `if (tool.preflight)`. Mais le rayon d'impact est
maximal, et c'est un correctif de sécurité écrit vite.

Attaque cet ordre. Questions concrètes :

- Une règle `block` doit-elle l'emporter sur `preflight` ? Aujourd'hui
  `preflight` passe **avant**, donc un outil bloqué par règle rend l'erreur du
  preflight au lieu de `blocked`. Est-ce le bon message pour l'utilisateur ?
- La ligne d'audit `tool_calls` est-elle bien écrite sur ce chemin, avec le bon
  contenu ? Un refus qui ne laisse pas de trace serait pire que pas de refus.
- Un outil MCP ou un connecteur peut-il se retrouver affecté ?
- `preflight` peut être synchrone ou asynchrone (`void | Promise<void>`).
  Vérifie qu'un jet synchrone est bien capturé.

`packages/tools/src/tests/preflight-order.test.ts` prétend prouver l'ordre.
Neutralise-le (`if (false && tool.preflight)`) et vérifie que les rouges sont
les bons.

## Priorité 2 — `--ignore-user-config` : ce que je perds au passage

Le P0 est corrigé en remplaçant `-c 'mcp_servers={}'` par
`--ignore-user-config`. Ça marche pour les MCP — mesuré, zéro ligne contre deux.

**Mais le drapeau ignore TOUT `~/.codex/config.toml`, pas seulement les MCP.**
Je n'ai pas évalué ce que ça retire d'autre. Ce que je sais : Nodal passe `-m`
et `model_reasoning_effort` explicitement **quand l'agent les définit**. Quand
il ne les définit pas, un utilisateur qui avait réglé son modèle par défaut dans
`config.toml` ne l'obtient plus.

À trancher : **est-ce acceptable, ou est-ce une régression silencieuse ?** Et
existe-t-il un moyen plus étroit de neutraliser uniquement les serveurs MCP —
une clé de config qui remplace au lieu de fusionner, un `CODEX_HOME` jetable,
autre chose ?

Si tu ne trouves rien de plus étroit, dis-le : le compromis est alors assumé et
doit apparaître dans la documentation.

## Priorité 3 — la sonde

`scripts/probe-codex-sandbox.mjs`. Elle a été écrite pour combler le trou qu'on
partage : nous sommes tous les deux sous Windows.

- **Lance-la.** Elle doit dire `NOT CONFINED on win32`.
- Fait-elle vraiment ce qu'elle prétend, ou peut-elle rendre un faux vert ? Un
  faux `CONFINED` serait le pire résultat possible : il ferait rouvrir codex sur
  une plateforme qui ne confine pas.
- Nettoie-t-elle derrière elle ? Le fichier d'évasion est écrit **hors** du
  répertoire jetable.
- Que rend-elle si codex est absent, non authentifié, ou en timeout ? Le code de
  sortie 2 doit être clairement distinct de 0 et 1.

## Priorité 4 — le crochet de format

`.githooks/pre-commit`, correctif du P2 (flux NUL).

- Reproduis ton cas d'origine. Attention : `*.md` est dans `.prettierignore`,
  donc `docs/a b.md` ne prouve rien — il faut un `.ts`.
- Le crochet bloque-t-il encore correctement le cas ordinaire sans espace ?
- `grep -z` est-il portable sur le shell Git de Windows ?

## Ce que je sais ne pas avoir couvert

- **Linux et macOS**, toujours. Si tu as une distribution WSL installable, la
  sonde répond en trois minutes.
- Aucun e2e complet dashboard → approbation → refus. Le comportement est prouvé
  au niveau de `executeTool` avec une vraie base de test.

## Format attendu

Comme la première fois : **VÉRIFIÉ / CONTREDIT / NON TESTÉ** par point, avec la
commande, la sortie brute, la plateforme et la version. Ta section « non testé »
de la review nº1 était la partie la plus utile du rapport.

Et si tu trouves quelque chose hors de cette liste, c'est le plus précieux : la
liste dit ce que je crains, donc pas ce que j'ai raté.
