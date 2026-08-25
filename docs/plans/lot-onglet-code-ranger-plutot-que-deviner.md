<!-- artifact: https://claude.ai/code/artifact/6d2d8b02-dd70-42b0-93e5-83ab8ea17702 -->

# Lot « l'onglet Code cesse de deviner » — 26/08/2026

| # | Lot | PR | État |
|---|-----|----|----|
| 1 | Masquer retire du contexte des agents | #39 | ✅ codé, testé, relu |
| 2 | La fonction de masquage (ex-archivage) | #39 | ✅ codé, testé, relu |
| 3 | Les dossiers supprimés qui restaient affichés | #39 | ✅ codé, testé, relu |
| 4 | Renommer un projet | #39 | ✅ codé, testé, relu |
| 5 | Retrait du filtrage (migration 0086) | #39 | ✅ codé, testé, relu |

**PR #39** — https://github.com/Kwintspiracy/nodal-agents/pull/39

## La décision

L'onglet Code ne devine plus rien. Il montre les dossiers où les agents ont
écrit, et donne au propriétaire les deux gestes que le produit ne peut pas
poser à sa place : **renommer** et **masquer**.

### Les sept définitions essayées, et pourquoi elles sont tombées

| # | Approche | Pourquoi écartée |
|---|---|---|
| 1 | l'extension des fichiers | « une exclusion par langage ratera tôt ou tard du vrai code » |
| 2 | le skill porté par l'agent | ne marche qu'avec NOS skills |
| 3 | la structure du dossier (`package.json`, `.git`) | « on va 100 % avoir des faux positifs » |
| 4 | une case sur l'agent | répond au « qui », pas au « où » |
| 5 | une case sur le dossier (0085) | déplace la devinette d'un cran : le dossier coché EST-il le projet, ou en contient-il ? |
| 6 | une nature devinée par dossier | liste sans fin : Obsidian, ComfyUI, Blender, Unity, Godot, un CMS… |

Ce qui les remplace n'est pas une septième devinette, c'est un GESTE.

**Conséquence assumée** : un coffre de notes apparaît tant qu'on ne l'a pas
masqué. C'est visible, et ça se règle en un clic — au lieu d'un vrai projet
absent sans que rien ne le signale.

## Ce qui a été livré

- **Migration 0086** : `agent_workspaces.is_dev_folder` disparaît ;
  `code_project_archives` devient `code_projects` et porte les deux gestes. Les
  projets déjà archivés restent masqués. Appliquée en live le 26/08.
- **Masquer porte jusqu'au contexte** : `apps/runner/src/job/code-projects.ts`
  lit désormais `code_projects`. Un projet rangé quitte le bloc `## Runtime` de
  tous les agents.
- **Le nom choisi voyage aussi** : les agents entendent le projet comme le
  propriétaire l'appelle.
- **Contrôle d'existence côté web** : un dossier supprimé ne fabrique plus de
  projet fantôme. La session, elle, reste — dans « Other sessions ».
- **Renommage en place** dans la carte projet (TextInput du DS, aucun dialogue).

## Ce que la revue a corrigé — onze passes de `codex review --base main`

C'est la colonne la plus utile à relire : chaque ligne est un constat qui aurait
été redécouvert plus tard, à l'usage.

| Constat | Gravité |
|---|---|
| La casse repliée hors Windows confondait `/srv/App` et `/srv/app` | P2 |
| Un partage réseau UNC n'était pas reconnu comme chemin Windows | P2 |
| Masquer ne prenait effet qu'au bout d'une minute (le cache portait les préférences) | P2 |
| **Masquer pouvait devenir irréversible** (deux lignes de casses différentes) | P1 |
| Un doublon hérité de `0083` suffisait à rendre le masquage définitif | P2 |
| Les labels ne sont uniques que par AGENT — une écriture déléguée était attribuée à l'orchestrateur | P1 |
| Le contexte des agents ne lisait pas les labels, ratait toute écriture relative multi-dossiers | P1 |
| **L'onglet cachait la panne qu'il existe pour montrer** : une nouvelle app dont tout est refusé disparaissait | P1 |
| Le repli faisait réapparaître le travail supprimé sous le dossier conteneur | P2 |
| La liste et le détail se contredisaient sur les écritures refusées | P2 |
| Le skill « dev » interdisait littéralement de créer un fichier | P1 |
| Le message de collision de slug demandait un renommage impossible (slugs immuables) | P2 |
| Une lecture de préférences en échec remontrait tous les projets masqués | P2 |

## Vérification

- `pnpm test` 32/32 paquets · `pnpm typecheck` 33/33 · `pnpm lint` propre ·
  `pnpm deps:check` 1696 modules sans violation · `pnpm build` passe.
- **Par mutation** sur chaque garde du lot : débrancher, le test doit rougir.
  Une seule fois un test s'est révélé décoratif — deux dossiers temporaires de
  même longueur rendaient l'ordre de recherche favorable par hasard. Rendu
  discriminant, avec le pourquoi écrit dedans.

### Ce que le build a appris sur cette machine

Le `pnpm build` a échoué trois fois avant de passer, pour des raisons
d'environnement, pas de code :

1. **Tas saturé** — `apps/web/.next` pesait **25,7 Go** (le seuil de purge noté
   est ~2 Go). Purgé ; le build demande `--max-old-space-size=12288`.
2. **Modules introuvables en cascade** (`discord.js`, `@whiskeysockets/baileys`,
   `@notionhq/client`…) — conséquence du `pnpm install` qui plante sur Node
   26.4.0 : les liens workspace sont faits à la main, et `apps/web` n'avait pas
   les dépendances externes des paquets qu'il charge. **47 jonctions** ajoutées.
3. Restent des avertissements « Failed to copy traced files » à l'étape de
   traçage standalone — dus aux mêmes jonctions manuelles. Le build aboutit.

⚠️ **À surveiller** : ces 47 jonctions sont dans `node_modules`, donc perdues au
prochain `pnpm install` réussi. Elles ne masquent aucun problème de code.

## Ce qui attend un geste de Quentin

- **Merger la PR #39** une fois la CI verte.
- **Vérifier en live** : ouvrir l'onglet Code, renommer un projet, en masquer
  un, et confirmer que l'agent ne le mentionne plus. Je n'ai pas pu le faire —
  l'install est en `local-auth`, je n'ai pas de session.
- Les tokens Discord + Slack fuités le 08/08 restent à révoquer (hors lot).

## Ce qui attend une décision

- **Une session dont le projet a été supprimé tombe dans « Other sessions ».**
  C'est le choix fait ici : le projet disparaît (ta demande), la session reste
  (elle a eu lieu). Si le tiroir devient bruyant à l'usage, l'autre option est
  de masquer aussi ces sessions — mais ce serait effacer de l'histoire.
