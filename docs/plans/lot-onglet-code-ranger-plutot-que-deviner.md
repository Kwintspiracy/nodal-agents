<!-- artifact: https://claude.ai/code/artifact/6d2d8b02-dd70-42b0-93e5-83ab8ea17702 -->

# Lot « l'onglet Code cesse de deviner » — 26/08/2026

| # | Lot | PR | État |
|---|-----|----|----|
| 1 | Masquer retire du contexte des agents | #39 | ✅ codé, testé, relu |
| 2 | La fonction de masquage (ex-archivage) | #39 | ✅ codé, testé, relu |
| 3 | Les dossiers supprimés qui restaient affichés | #39 | ✅ codé, testé, relu |
| 4 | Renommer un projet | #39 | ✅ codé, testé, relu |
| 5 | Retrait du filtrage (migration 0086) | #39 | ✅ codé, testé, relu |
| 6 | Un agent travaille dans le dossier qu'on lui a donné | #39 | ✅ codé, testé, relu |
| 7 | La délégation en ligne laisse une trace dans le fil | #39 | ✅ codé, testé, relu |
| 8 | **Codex se choisit comme harnais d'un agent** | #39 | ✅ codé, testé, relu |
| 9 | **Pourquoi Codex n'écrivait rien sur Windows** | #39 | ✅ cause isolée, corrigée, mesurée |

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

## Lot 6 — l'agent écrit dans le dossier qu'on lui a donné (27/08)

Le blocage nommé par Quentin : *« rien de tout ce qu'on a fait n'a d'intérêt si
l'utilisateur ne peut pas trouver l'application qu'il développe »*. Quatre runs
de suite ont livré dans `…/Dev/shared/outputs/…` alors que `Dev` était attaché.

**Ce que la base disait** : 349 des 381 écritures récentes sont relatives sans
label correspondant, le partagé contenait 403 fichiers, et le prompt système
affichait `## Workspace` au SINGULIER pendant que les outils, eux, en voyaient
deux. L'agent n'ignorait pas la consigne : il ne voyait qu'un seul dossier, le
partagé, et y rangeait tout.

Corrigé au bon endroit :

- le prompt liste **ce que les outils ont vraiment** (`JobContext.workspaces`),
  plus une déduction parallèle ;
- l'inventaire dit enfin à quoi sert le partagé : **la main tendue entre agents**,
  pas la sortie destinée au propriétaire ;
- la sonde git vise le dossier **attaché**, plus le partagé par défaut ;
- le skill `workspace-hygiene` cesse de faire croire qu'il faut inventer un
  `shared/` à l'intérieur du dossier attaché.

**Une correction d'architecture, demandée par Quentin** : j'avais commencé par
retirer le partagé aux agents qui ont un dossier. Il a coupé court — *« dès
qu'on leur donne un dossier, ils ne peuvent plus rien partager avec les
autres ? »*. Puis, plus large : *« on essaie de contourner pour tout, soit
automatique. Est-ce que c'est vraiment la bonne manière ? »* Le rustine dans le
runtime a été **retirée** (invariant #3) et remplacée par ce que le prompt dit
et par des paragraphes de personnalité à coller côté agents.

**Vérifié en live** : job `e1bcd9fe` a produit
`C:\Users\kwint\Documents\Dev\igdb-app\index.html` — un dossier par app à la
racine de `Dev`, le chemin annoncé égal au chemin réel, aucun `Dev/shared/`.

## Lot 7 — pourquoi un agent racontait un travail qu'il n'a pas fait (27/08)

Quatre fois dans la journée, un orchestrateur a annoncé sur Telegram « app
livrée et validée par Reviewer C (2 passes) » — avec le nom du relecteur et le
nombre de passes. Aucune délégation, aucune écriture, aucun fichier. Ce n'est
pas un mensonge : c'est une **confabulation**, un motif complété.

La cause est structurelle, et les deux registres anti-confabulation existants la
laissaient passer :

- celui de `thread-history` ne se déclenche que sur `STATE_CHANGING_TOOLS`, où
  les outils de délégation ne peuvent **pas** figurer — ils s'appellent
  `assign_<slug>`, et écrire un slug d'agent dans le runtime est exactement ce
  que l'invariant #1 interdit ;
- `loadTaskLedger` ne lit que `agent_tasks`, la table du tableau de tâches. La
  délégation **en ligne** crée un `agent_jobs` enfant et n'y touche jamais.

Dans l'historique, un vrai compte rendu et un compte rendu inventé arrivaient
donc **nus tous les deux**, et chaque fabrication rejoignait le fil pour
renforcer le motif au tour suivant.

`loadInlineDelegationLedger` lit les enfants par `parent_job_id` et rend leurs
propres `tools_used` :

```
[Delegated to Reviewer C (completed) — actions: file_write ×2, review_verdict]
```

Le cas le plus utile est `no tool used` : la délégation a eu lieu et n'a rien
produit, là où la prose peut affirmer le contraire. Et un tour **sans**
délégation ne porte aucune ligne — c'est ce contraste qui manquait.

**Coût mesuré** sur cette install : 162 des 300 tours conversationnels ont une
délégation en ligne. Rendre aussi le résultat coûtait 531 caractères par tour
(27 % du budget d'historique sur huit tours) ; réduit aux actions, ~75. Le
résultat est déjà dans la prose du parent.

**Agnostique** (question de Quentin) : aucun slug, aucun nom d'agent, aucune
configuration. Tout utilisateur qui délègue en bénéficie.

## Lot 8 — Codex se choisit comme harnais, au même titre que Claude (27/08)

Demande de Quentin, sans détour : *« je veux pouvoir mettre un agent qui utilise
Codex, que ce soit pour une review ou pour autre chose. C'est pas ton
problème. »* Ma première réponse — « ton besoin est déjà couvert par `code_task`
» — était juste sur le fond et à côté de la plaque sur la demande.

`codex` était un **siège réservé** depuis le 19/08 : la contrainte SQL
l'acceptait, le Zod de l'action le refusait, le runner échouait fort dessus, et
aucun module de tour n'existait. Huit jours.

Ce que le lot ajoute :

- `cli-runtime/codex-turn.ts` — le tour Codex. L'argv et la lecture des
  événements d'outils sont **empruntés** à l'outil `code_task`, qui pilote déjà
  ce binaire ; deux façons de lancer le même CLI auraient dérivé.
- `cli-runtime/spawn-turn.ts` — la mécanique de processus (lancement, arbre tué
  sous Windows, délai, garde anti-boucle), sortie de `claude-turn.ts` au lieu
  d'être recopiée.
- `cli-runtime/provider.ts` — LE tableau `runtime → CLI`. La garde vivait en
  double ; elle vit une fois.

**Trois différences avec Claude, mesurées** sur le binaire installé
(`codex exec --help`), pas lues sur une page d'aide : aucun drapeau de persona
(le prompt voyage en tête de stdin), un format d'événements propre, et **aucun
coût rapporté** — le champ reste `null`, jamais un 0 qui ferait croire à un tour
gratuit. Conséquence assumée : le plafond quotidien en dollars ne borne pas un
agent Codex, et l'écran cesse de le proposer là où il ne borne rien.

Corrigés au passage, parce qu'ils étaient figés sur Claude : les défauts de
modèle et d'effort étaient écrits sous la clé `claude` quel que soit le runtime
(le réglage semblait pris et ne changeait rien), la carte runtime nommait Claude
Code et testait son binaire, le libellé de la liste d'agents serait retombé sur
le modèle Nodal dormant.

⚠️ **Ce n'était pas livré tant que ce n'était pas visible.** La stack tournait en
mode production, donc servait un build figé au 26/08 : tout était compilé,
testé, poussé — et absent de l'application. Rebâti et redémarré le 27/08 ; la
présence de l'option est vérifiée dans le bundle servi, pas supposée.

## Lot 9 — pourquoi Codex n'écrivait rien (27/08)

Un agent Codex en mode écriture n'écrivait rien. `--sandbox workspace-write`
était bien passé, le tour se terminait **normalement**, et le modèle répondait
« l'environnement interdit toute écriture » — aucune erreur, aucune commande
refusée. Il annonçait l'impossibilité et s'arrêtait.

**Cause isolée** par quatre runs, même tâche, même dossier, une variable à la
fois :

| argv | écrit ? |
|---|---|
| `--sandbox workspace-write --ignore-user-config` | non |
| `--sandbox workspace-write` (config chargée) | **oui** |
| `… --ignore-user-config -c approval_policy="never"` | non |
| `… --ignore-user-config -c windows.sandbox="elevated"` | **oui** |

Sur Windows, Codex n'a **aucun mécanisme de confinement par défaut** : il faut
lui dire lequel employer. Ce réglage vit dans la config du propriétaire, et
`--ignore-user-config` — qui protège ses serveurs MCP personnels — le jetait
avec le reste. D'où l'asymétrie : `codex` lancé à la main marche, Nodal non.
L'hypothèse « c'est la politique d'approbation » est **réfutée**.

**Le contrôle de sécurité, fait AVANT de livrer** : lecture seule + `elevated`
refuse d'écrire dans son propre dossier ; écriture + `elevated` refuse le parent
immédiat et tout autre dossier de Documents. Seul TEMP s'ouvre, que
`workspace-write` accorde par conception. Le réglage ne desserre rien — il nomme
*comment* confiner.

**Deux corrections de fond, au-delà du drapeau :**

1. Un commentaire de `sandbox.ts` **accusait** ce réglage d'avoir désactivé le
   confinement le 21/08. C'était faux, et ça a coûté une journée : le réglage
   manquant paraissait dangereux, donc personne ne l'a reposé — et Codex ne
   pouvait rien écrire du tout sur Windows, ni en runtime ni via `code_task`.
2. **La sonde censée garder tout ça tentait son évasion dans TEMP**, le seul
   endroit autorisé par conception. Elle criait « not confined » exactement
   quand tout allait bien : une garde qui pousse à fermer une fonctionnalité qui
   marche. Sa cible est désormais le dossier de l'utilisateur. Elle recopiait
   aussi l'argv du produit à la main, et la copie avait dérivé ; un test tient
   maintenant les deux en phase.

## Ce que la revue a corrigé — vingt-trois passes de `codex review --base main`

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
| Un partagé vide faisait disparaître le bloc entier — donc la consigne, sur une install neuve | P1 |
| `create_task` pose son enfant sous le même parent : chaque tâche comptée **deux fois** dans l'historique | P2 |
| Le runner groupait les projets sur le chemin littéral : un projet Windows en deux casses = deux projets annoncés | P2 |
| Un partagé **illisible** se faisait passer pour vide — l'agent recréait ce qu'il n'avait pas pu voir | P2 |
| **Une restriction d'outils était ignorée** : basculer un agent restreint vers Codex lui RENDAIT les outils retirés — élévation de permissions par menu déroulant | P1 |
| **La sortie des outils partait en clair dans l'audit** — contenu de chaque fichier lu, jeton compris. Trou préexistant, Claude compris | P1 |
| Les outils Codex n'étaient pas comptés par le garde anti-boucle : sept types sur neuf échappaient au plafond | P1 |
| Les écritures d'un agent Codex n'apparaissaient nulle part — ni onglet Code, ni projets annoncés aux agents | P1 |
| Un `file_change` arrivant en fin de tour n'était jamais enregistré | P1 |
| Les dossiers secondaires n'étaient pas ouverts en écriture : le prompt promettait ce que le bac à sable interdisait | P1 |
| Les verrous ne portaient que sur `cwd` — deux agents pouvaient écrire dans le dossier partagé en même temps (job, puis chat une revue plus tard) | P1 |
| Les verrous **fuyaient** si l'assemblage du prompt échouait : tous les dossiers bloqués une demi-heure | P1 |
| Une session réutilisait l'identifiant de session de l'AUTRE CLI après une bascule de runtime | P2 |
| Le budget en dollars était promis alors que Codex ne rapporte aucun coût | P2 |
| `turn.started` déclarait une dérive de protocole à **chaque tour réussi** | P2 |
| Le chat du tableau de bord n'avait pas le registre des délégations en ligne | P2 |
| Un changement multi-fichiers ne comptait que le premier fichier | P2 |
| Un tour **tué par le délai** se terminait « réussi » | P2 |
| Le prompt était omis à la reprise : l'agent gelé sur l'état du premier message | P2 |
| Le panneau Changes restait vide alors que le compteur annonçait des fichiers | P2 |
| L'appariement multi-fichiers cassé **par le correctif précédent** | P2 |

## Vérification

- `pnpm test` 32/32 paquets · `pnpm typecheck` 33/33 · `pnpm lint` propre ·
  `pnpm deps:check` 1696 modules sans violation · `pnpm build` passe.
  Rejoué au complet le 27/08 après les lots 6 et 7 : toujours vert.
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

- **Merger la PR #39** une fois la CI verte. La CI **est** verte sur `20246cdd` ;
  elle n'a pas encore vu les commits suivants. (L'hypothèse « quota Actions
  épuisé » de la nuit était fausse : la CI était simplement en attente.)
- **Coller les paragraphes de personnalité** dans Alfred et Lead-Dev (la sonde du
  26/08 montre que « Never dictate WHERE » et « Report the path you were GIVEN »
  sont déjà chez Alfred).
- **Vérifier en live** : ouvrir l'onglet Code, renommer un projet, en masquer
  un, et confirmer que l'agent ne le mentionne plus. Je n'ai pas pu le faire —
  l'install est en `local-auth`, je n'ai pas de session.
- Les tokens Discord + Slack fuités le 08/08 restent à révoquer (hors lot).

## Micro-PR de nettoyage — APRÈS le merge (décision Quentin, 26/08)

**Renommer l'outil `code_task`.** Le nom laisse croire à « une fonction qui
code », alors que c'est un **appel au harnais CLI installé** (Claude Code ou
Codex), sous l'abonnement du propriétaire. Candidats : `cli_code`,
`run_coding_cli` (rime avec `run_command`, son cousin le plus proche),
`cli_delegate`. Le skill `code-task` suit.

Reporté volontairement : le nom est une DONNÉE, pas seulement du texte — il vit
dans `tool_calls.tool_name`, `approval_rules`, `approval_requests` et le slug du
skill. Le faire avant le merge mêlerait une migration de renommage à un lot déjà
long.

Portée mesurée le 26/08 : 137 occurrences dans 26 fichiers de code + 14 de test ;
25 fichiers pour le slug `code-task`. En base sur cette install : 16 `tool_calls`,
1 règle d'approbation (Reviewer C), 6 demandes, 1 skill. Migration nécessaire pour
que l'historique et la règle de Reviewer C survivent.

## Ce qui attend une décision

- **Une session dont le projet a été supprimé tombe dans « Other sessions ».**
  C'est le choix fait ici : le projet disparaît (ta demande), la session reste
  (elle a eu lieu). Si le tiroir devient bruyant à l'usage, l'autre option est
  de masquer aussi ces sessions — mais ce serait effacer de l'histoire.
