<!-- artifact: https://claude.ai/code/artifact/1fd52dac-1542-4bfb-89c8-3d5aff9f248e -->

# De la maquette au produit — le plan des pierres

Objectif : l'espace de code tel que dessiné le 05/09 (artifact « L'espace de
code », `docs/design/espace-code/`) — une conversation où l'agent parle, demande,
travaille et montre ses résultats, avec une barre d'état permanente et une
étagère fixe. Vision : « Le livrable est la page »
(https://claude.ai/code/artifact/f2cd2ddd-639b-4a9b-9f85-4386cf45a574).

## Périmètre — fixé par Quentin le 05/09

**La barre latérale ne bouge pas.** Ses seize entrées restent telles quelles.
On ajoute UNE entrée, « Spaces », qui ouvre le nouvel espace. Fusionner Chat,
Runs et Code est une décision ultérieure, peut-être jamais prise : ce plan ne la
prépare pas et ne la présuppose pas.

**L'effort porte sur le déroulé du chat**, dans ce nouvel espace. Les écrans
existants (Runs, Code, Chat) ne sont pas touchés par les lots 1 à 3.

**De la maquette, on garde le fil de conversation. Rien d'autre.** La barre
latérale, le header, le design system et les pages existantes ne changent pas.
La maquette est une intention ; là où elle diverge de l'existant, l'existant
gagne.

## Ce qui arrive par Telegram — rappel de Quentin, 05/09

Le dessin montre l'espace comme si tout se passait sur le web. Or la plupart des
demandes arrivent par Telegram. Trois choses que le plan doit tenir, et que la
maquette ne montre pas.

**1. Où atterrit une demande venue d'un canal.** Aujourd'hui elle devient un job
(`channel: 'telegram'`, `chat_id`, `conversation_id`). Pour qu'elle apparaisse
dans un espace, il faut la rattacher. Règle proposée pour P6 : l'espace d'une
tâche venue d'un canal se déduit de **là où ses livrables ont atterri** — les
clés canoniques des intentions de mutation, déjà écrites avant chaque écriture.
Aucune commande à taper. Une tâche sans livrable dans le dossier d'un espace
reste dans le fil général. **À trancher avant P6** ; l'alternative est un espace
par conversation Telegram, plus simple et plus bête.

**2. Ce que Telegram reçoit en retour.** Chaque tour de l'agent est miroité dans
le canal : sa prose telle quelle, ses questions en boutons (P7 réutilise
`approvals/notify.ts`), ses livrables en carte (`job_deliveries` existe).
L'espace web et Telegram montrent la **même** conversation ; ce qui est répondu
d'un côté apparaît de l'autre. P2 affiche l'origine de chaque message — la
maquette le faisait pour les messages de Quentin (« depuis Telegram »), pas pour
ce que Nodal a envoyé.

**3. Ce que Telegram ne peut pas montrer.** Ni diff, ni tableau, ni groupe
replié. Le canal reçoit la prose, le fichier joint, et un lien vers l'espace.
« Le livrable est la page » se lit dans Telegram comme « le livrable est le
fichier joint, et une ligne ».

## Suivi

| # | Lot | Pierres | Ce que Quentin voit à la fin | État |
|---|-----|---------|------------------------------|------|
| 1 | **Rendre visible ce qui existe** | P1 contrat de rendu · P2 conversation · P3 cartes de preuve et d'envoi · P4 barre d'état et coût | Une entrée « Spaces » ouvre le nouvel espace ; sa page est la conversation dessinée, avec preuves, coûts, jetons. Runs, Code et Chat inchangés | ✅ **LOT 1 CLOS le 06/09** — P1 (passe 16), P2 (19), P3 (21), P4 (24-25 : « aucun constat neuf ») ; retours de Quentin traités (automatisations à part, fil nettoyé sur capture réelle, coût cache-aware) · ⚠️ à voir par Quentin dans son navigateur : /spaces et un fil récent |
| 2 | **L'espace où l'on reste** | P5 fichiers et diff · P6 l'espace | Un chantier durable, sa conversation continue, ses diffs cliquables | ⬜ |
| 3 | **L'agent qui demande** | P7 `ask_user` · P8 le tableur rendu | Des questions avec boutons dans la conversation ET dans Telegram ; un classeur qui s'affiche | ⬜ |
| 4 | **Ce qui reste cher** | P9 relecteurs (= PR④ de Vérifier & Corriger) · P10 aperçu vivant | Deux relecteurs cités ; l'application qui tourne au centre | ⬜ |

## Verdict de faisabilité — vérifié dans le code le 05/09

Chaque ligne du dessin, et d'où vient sa donnée. Rien n'est supposé.

| Ce que le dessin montre | D'où ça vient | Vérifié |
|---|---|---|
| L'agent parle entre ses actions | `agent_jobs.messages` — chaque message assistant porte `reasoningParts`, une partie `text`, et les `toolCallParts` (`apps/runner/src/job/execute.ts:2857`) | oui |
| Le raisonnement | mêmes parties, avec leur signature de provider (`execute.ts:2795`). **Tous les modèles n'en émettent pas** : l'écran doit le dire | oui, partiel |
| Chaque outil : entrée, sortie, durée | `tool_calls` — écrit par `packages/tools/src/execute.ts:763` pour la boucle principale, et par `code-task/live-events.ts:142` pour les étapes du harnais de code | oui |
| Jetons, cache lu, cache écrit, coût, modèle demandé vs effectif, bascule | `llm_calls` (`packages/db/src/schema/llm-calls.ts`) | oui |
| Le harnais de code : session, version, coût, sortie | `cli_runs` | oui |
| Un sous-agent et SES actions | job enfant : `parent_job_id`, `delegation_depth` ; ses `tool_calls` et `llm_calls` portent SON `job_id` | oui |
| Une approbation avec boutons, depuis Telegram | `tool_approvals` + `apps/runner/src/approvals/notify.ts` (cartes neutres vis-à-vis du canal) | oui, déjà en prod |
| Preuve rouge / verte, extrait, durées | `verification_runs` + `job_deliverable_verification_state` — PR① | oui, livré cette semaine |
| Les commandes de preuve proposées | `discoverVerifyCommands` — v7-C, livré le 05/09 | oui |
| Envois partis / en attente | `job_deliveries` — PR① | oui |
| **Le diff des fichiers écrits par le harnais** | le sha de l'instantané est calculé (`checkpoints.ts:199`) mais **pas persisté** ; il vit dans le dépôt git des instantanés, étiqueté | **trou à combler** (P5) |
| L'agent pose une question avec des options | aucun outil — `ask_user` n'existe pas | **à construire** (P7) |
| Deux relecteurs cités | protocole non construit — PR④ du plan Vérifier & Corriger | **à construire** (P9) |
| L'application qui tourne | rien | **à construire, en dernier** (P10) |

**Conclusion.** Trois lots sur quatre sont une couche d'affichage sur des lignes
qui existent. Le quatrième est cher et peut se faire attendre sans que le reste
perde son sens.

## Ce qu'on garde, ce qu'on remplace, ce qu'on jette

| | Quoi | Pourquoi |
|---|---|---|
| **On garde** | Toute la PR① : intention de mutation, état par livrable, primitive terminale, outbox, `verification_runs`, écran de configuration | C'est le moteur. Sans elle, les cartes de preuve n'ont rien à afficher |
| **On garde** | v7-A : chaque outil déclare ce qu'il produit | C'est la graine du contrat de rendu (P1). On l'étend, on ne le refait pas |
| **On garde** | v7-C : la découverte des commandes | C'est le contenu du panneau « Vérifié » de l'étagère |
| **On garde** | Les primitives du design system : `Table`, `MonoMicroTag`, `PrimaryButton`, `Banner`, `EdRow` | La maquette les reprend au pixel |
| **On garde** | `JobMessages.blocksFromContent` (le lecteur des trois formats de messages) | Il sait déjà lire les parties ; on change ce qu'on en fait |
| **On ne touche pas** | Les écrans Runs, Code et Chat, et la barre latérale | Décision de Quentin le 05/09 : le nouvel espace vit à côté, derrière une entrée de plus. `JobMessages` reste en place ; son lecteur de messages est réutilisé par la conversation |
| **On jette** | Rien | Aucun travail livré n'est contredit par le dessin |

## Les pierres

Chaque pierre suit la discipline du dépôt : tests sur lignes réelles, une
mutation par garde, `codex review` en boucle jusqu'au retour vide. Tailles : S
moins d'un jour, M deux à trois jours, L une semaine, XL indéterminée.

### P1 · Le contrat de rendu — M → L

**Ce que ça pose.** Chaque outil déclare DEUX choses. Sa **carte** — comment son
résultat s'affiche, une parmi `text · read · search · files · table · terminal ·
sent · checks · question · delegation · generic` — et, pour toute carte à
structure, son **présentateur** `present()` : comment on tire de SA sortie la
charge utile de CETTE carte. La forme de chaque charge utile est écrite une
fois pour toutes (`packages/shared/src/tool-cards.ts`, schémas zod plafonnés) ;
les briques qui la construisent sont dans `packages/tools/src/presenters.ts`.
L'écran dispatche sur la carte et lit la charge utile, jamais le nom de l'outil.
C'est le modèle de DeepSeek Harness (`presentResult` + le `meta` de
présentation attaché au résultat), et la condition posée le 05/09 : sans lui,
l'écran doit être édité à chaque outil ajouté et il meurt.

**Où ça vit.** Carte et charge utile sont **persistées sur la ligne
`tool_calls`** (`card`, `presented` — migration 0092) au moment de
l'exécution, par `executeTool`. L'écran lit la ligne, jamais le registre ; une
ligne d'hier se dessine comme le jour où elle a été écrite. Les lignes
antérieures et celles de l'enregistreur vivant du CLI (`cli:*`, qui n'a qu'un
événement, pas une sortie) portent `presented = NULL` : l'écran montre
l'entrée et la sortie brutes et le dit.

**Sur quoi ça s'appuie.** `MutationTarget.deliverableType` (v7-A) est déjà une
déclaration par l'outil. Le contrat de rendu est son frère pour la lecture.

**Ce que la revue a corrigé dans cette pierre** (passes 11 à 13, dans l'ordre) :
une carte inventée était rabattue en silence sur `generic` → elle lève, et le
registre la refuse au démarrage ; `query_memory` était `text` alors que sa
sortie est tabulaire → `table` ; `code_task` était `files` alors qu'il ne rend
aucun fichier → `delegation` ; trois `list_*` requalifiés `table` par excès de
zèle → `text` (leur sortie est une enveloppe) ; et le constat qui a élargi la
pierre : **une étiquette sans forme oblige quand même à dispatcher par nom**
(`xlsx_read` rend `{ sheets }`, `query_memory` un tableau nu, même carte) → la
charge utile typée et le présentateur par outil.

**Garde.** `cards.test.ts` énumère le registre : tout outil déclare sa carte,
la table complète nom → carte est épinglée (72 outils), toute carte à structure
a son présentateur, et le registre refuse au démarrage une carte inventée ou
sans présentateur. Les présentateurs sont vérifiés sur de **vraies sorties**
(`file-ops`, `run-command`, `xlsx`, `execute` : la ligne `tool_calls` porte
carte et charge). Mutations mesurées : présentateur retiré → rouge au
démarrage, en nommant l'outil ; lignes décalées dans `xlsx_read` → rouge ;
charge non persistée → rouge.

**Hors périmètre.** Aucun rendu ici — c'est le contrat, pas les composants.
Les ~140 adaptateurs de connecteurs restent `generic` : leur qualification est
une pierre à part.

### P2 · La conversation — L

> **État au 06/09** : codée — `apps/web/src/lib/conversation-feed.ts` (le
> modèle, pur), `app/(dashboard)/spaces/` (liste + fil), action
> `getSpaceConversationAction`, entrée « Spaces » dans la barre latérale (la
> seule touche à l'existant). Repli/carte décidé sur la carte persistée ET sur
> ce que la charge a à dessiner (`showsAlone`). Les messages `user` après la
> demande sont lus comme des rappels du runner — **à vérifier contre
> `thread-history.ts`** (historique préfixé d'une conversation Telegram),
> question posée à la passe 17. Vérification visuelle : la base de Quentin
> est en `local-auth`, je n'ai pas le mot de passe — la page est prouvée par
> `tsc`, le rendu HTML statique et l'action sur pglite, pas par Playwright.

**Ce que ça pose.** La page du nouvel espace rend la conversation dessinée : les
messages de l'utilisateur, la prose de l'agent, les groupes d'actions repliés
(« Réflexion et recherche · 4 étapes · 9,4 s · 12 480 jetons »), les cartes
dispatchées par P1, les sous-agents en groupes indentés avec leur pastille.

**Sur quoi ça s'appuie.** `messages` pour la prose et le raisonnement ;
`tool_calls` joint sur `tool_call_id` pour les durées et sorties ; `llm_calls`
par tour pour les jetons de chaque groupe ; les jobs enfants par
`parent_job_id`.

**Origine.** Chaque message porte d'où il vient — Telegram, le dashboard, une
automatisation — et chaque envoi de Nodal vers un canal apparaît dans le fil,
pas seulement les messages reçus.

**Règle de groupage.** Une suite d'appels d'outils entre deux parties `text` de
l'agent forme un groupe. Le titre du groupe est déduit des cartes qu'il contient
(« 3 fichiers écrits », « Réflexion et recherche »), jamais écrit en dur.

**Garde.** Un transcript de test qui contient chaque sorte de partie rend chaque
sorte de carte ; aucune partie connue ne retombe sur `generic`. Mutation :
retirer une carte du dispatch fait rougir le test sur la partie correspondante.

**Ce qui reste hors de P2.** Le diff cliquable (P5), le tableur rendu (P8), la
question à boutons (P7) : leurs cartes affichent un état « pas encore rendu »
honnête en attendant.

### P3 · Les cartes de preuve et d'envoi — S

> **État au 06/09 : close** — `VerificationSection` (le composant existant du détail Code) réutilisé tel quel sous le fil, alimenté par la même lecture (preuves du job et de TOUS ses descendants, trace D8, livrables non configurés) ; `DeliveriesCard` neuf depuis `job_deliveries`. Passes Codex 20-21.

**Ce que ça pose.** La carte de preuve (rouge : commandes, extrait, séquence
arrêtée ; verte : commandes, durées, fraîcheur) depuis `verification_runs`. La
carte d'envoi depuis `job_deliveries`. Le panneau « Vérifié » de l'étagère
depuis `code_projects` et la découverte v7-C, avec les six dernières preuves.

**Sur quoi ça s'appuie.** Cent pour cent PR① et v7-C.

**Garde.** Les tests existants de `VerificationSection` migrent vers la carte ;
un `verification_runs` rouge rend l'extrait, un vert ne le rend pas.

### P4 · La barre d'état et le coût — M

> **État au 06/09 : close (passes 24-25).** P4a : `ModelPricing.cacheReadPerMillionUsd` / `cacheWritePerMillionUsd` par modèle (source OpenRouter `GET /api/v1/models`, relevé le 06/09 — le rapport n'est pas universel : Anthropic 0,1×/1,25×, DeepSeek 0,5×, Kimi ≈ 0,17×), `estimateCallCostUsd` cache-aware dans `call-sink` et `execute.ts`, dix prix in/out rafraîchis ; un modèle sans prix de cache est facturé plein et le dit (`hasCachePricing`). P4b : `aggregateSpaceCost` (par agent, attente humaine, temps de preuve), `StatusBar` permanente + panneau « What this work cost ». La garde « au dixième / 1,25× » tient pour Anthropic ; pour les autres vendeurs c'est LEUR prix, pas un facteur.
>
> **Dépendance découverte le 06/09** : la garde (« cache lu au dixième, cache écrit 1,25× ») suppose un estimateur cache-aware. Or `estimateModelCostUsd` (`packages/shared/src/model-catalog.ts`) calcule `input × prix + output × prix` et ignore `cachedTokens` / `cacheCreationTokens` ; seul OpenRouter rapporte un coût déjà cache-aware. P4 se scinde donc : (a) la barre d'état depuis `llm_calls` tel quel (jetons, part de cache, coût rapporté, durée, envois en attente) ; (b) l'estimateur cache-aware, travail moteur à part (backlog « cache-aware »), sans lequel le coût des fournisseurs natifs reste surestimé.

**Ce que ça pose.** La barre du bas, permanente : preuve, modèle actif, agents,
jetons avec part de cache, coût, durée, envois en attente. Le panneau « Ce que
ce travail coûte » avec des **phrases** avant les chiffres, puis le détail par
agent, la répartition cache lu / cache écrit / effectif / sortie, le temps
d'attente humaine, le temps de preuve.

**Sur quoi ça s'appuie.** Agrégat sur `llm_calls` (`cost_usd`, `input_tokens`,
`cached_tokens`, `cache_creation_tokens`, `output_tokens`) et `cli_runs`, par
`job_id` puis par espace ; l'attente humaine = `tool_approvals.resolved_at −
requested_at`.

**Garde.** L'agrégat est comparé au centime à un jeu de lignes semé ; le cache
lu est bien facturé au dixième et le cache écrit à 1,25×, sinon le test rougit.

### P5 · Fichiers et diff — M

**Ce que ça pose.** La carte « 12 fichiers » : la liste cliquable, le diff de la
sélection.

**Sur quoi ça s'appuie.** Pour `file_write` / `file_edit`, `tool_input` porte
déjà l'ancien et le nouveau texte. Pour le harnais de code, il faut le sha de
l'instantané : **il n'est pas en base.** Deux pièces : (a) persister
`(job_id, turn, sha, workspace)` au moment où `takeCheckpointForTurn` le calcule,
(b) `git diff <sha> <sha suivant>` dans le dépôt des instantanés.

**Limite, à écrire à l'écran.** Hors d'un dépôt git, il n'y a pas de diff pour ce
que le harnais écrit. La carte dit alors « fichiers écrits, sans diff ».

**Garde.** Un `file_edit` semé rend son diff exact ; un instantané semé puis un
second rendent le diff git attendu ; un dossier sans git rend l'état « sans
diff » et pas une erreur.

### P6 · L'espace — M/L

**Ce que ça pose.** L'objet durable de la vision : une table `espaces` (nom,
dossier racine, sorte `code | documents`), `agent_jobs.espace_id`, la page de
l'espace = l'étagère + la conversation concaténée de ses jobs, la proposition de
créer un espace quand trois tâches atterrissent au même endroit. L'espace est
atteint par l'entrée « Spaces » de la barre latérale ; l'onglet Code ne change
pas.

**Sur quoi ça s'appuie.** `agent_workspaces` et `code_projects` en sont
l'ancêtre ; la sorte se déduit des marques de code déjà listées
(`PROJECT_MARKERS`).

**Ce qui change pour Vérifier & Corriger.** Les commandes de preuve deviennent
un réglage de l'espace de sorte code. La table `code_projects` reste ; l'espace
la référence.

**Rattachement d'une tâche venue d'un canal.** Voir « Ce qui arrive par
Telegram » : par les livrables, sauf décision contraire de Quentin avant P6.

**Garde.** Une tâche lancée depuis un espace y reste (ne remonte pas dans le
fil) ; une tâche Telegram dont le livrable atterrit dans le dossier d'un espace
apparaît dans cet espace ; trois tâches dans le même dossier déclenchent la
proposition, deux non.

### P7 · `ask_user` — M

**Ce que ça pose.** Un outil qui pose une question avec des options. Dans la
conversation : la carte à boutons. Dans le canal d'origine : la même carte,
via l'infrastructure des approbations (`notify.ts`, préfixe de rappel propre).
La réponse reprend le job exactement comme une approbation le fait.

**Ce que ça absorbe.** La seconde moitié de v7-C (approbation des commandes de
preuve dans le canal) est un cas de `ask_user`. Une plomberie, deux usages.

**Garde.** Un `ask_user` suspend le job ; un clic dans le canal le reprend avec
la réponse dans le transcript ; une réponse hors options est refusée.

### P8 · Le tableur rendu — S

**Ce que ça pose.** La carte `table` pour un `office_file` : les premières lignes
de la feuille demandée, les contrôles v7-B en pied. Un tableau de valeurs, pas
Excel : ni formules, ni fusion, ni mise en forme — dit tel quel.

**Sur quoi ça s'appuie.** `xlsx_read` existe.

### P9 · Les relecteurs — L

C'est la PR④ de Vérifier & Corriger, inchangée. Ici seulement sa carte : deux
relecteurs, leur verdict, leur citation. Rien à planifier de neuf, une
dépendance à nommer.

### P10 · L'aperçu vivant — XL

Lancer et tenir un serveur de développement par espace, l'afficher, gérer ports
et arrêts. C'est le produit entier de Lovable. **Dernier, et sans promesse.**
Tant qu'il n'existe pas, le centre de l'espace montre le dernier diff, et le
bouton « L'application » ouvre l'URL locale dans un onglet.

## Ce que ça fait aux seize onglets

Une entrée de plus, « Spaces ». Rien d'autre. Runs, Code et Chat restent tels
qu'ils sont. Les fusionner un jour est une décision de Quentin, pas une
conséquence de ce plan.

## Ce que ça fait au plan Vérifier & Corriger

Il continue. Ce plan est la **surface** ; l'autre est le **moteur**. Les points
de contact : v7-B nourrit la carte du tableur (P8) ; la seconde moitié de v7-C
est absorbée par P7 ; v7-D nourrira une carte « critères » plus tard ; PR④ est
P9. L'observation, la garde et le runtime CLI ne bougent pas.

## Les limites, dites avant de commencer

- Le raisonnement n'est visible que pour les modèles qui l'émettent ; l'écran
  le dira au lieu de faire semblant.
- Le diff du harnais de code n'existe que dans un dépôt git.
- Le tableur rendu est un tableau de valeurs.
- L'aperçu vivant peut ne jamais ressembler au dessin.
- La maquette est une intention, pas une spécification au pixel : chaque pierre
  sera validée à l'écran, par Playwright, avant d'être dite finie.
