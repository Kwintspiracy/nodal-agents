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
existants (Runs, Code, Chat) ne sont pas touchés par le lot 1. Chat évolue au
lot 2, sur décision de Quentin du 06/09 (section suivante).

**Mis à jour le 06/09 :** Quentin a décidé de faire évoluer la page Chat et
d'ajouter une entrée « Scheduled » (voir la section suivante). Le reste de ce
périmètre tient.

**De la maquette, on garde le fil de conversation. Rien d'autre.** La barre
latérale, le header, le design system et les pages existantes ne changent pas.
La maquette est une intention ; là où elle diverge de l'existant, l'existant
gagne.

## Ce qui a été décidé le 06/09 — le cadre du lot 2

Après avoir vu le lot 1, Quentin a tranché ce que la maquette laissait ouvert.
Ce cadre remplace la section « Ce qui arrive par Telegram » du 05/09 et ses
alternatives.

**Trois objets.** Le **dossier attribué à un agent** est son terrain : ce qu'il a
le droit de toucher, pas un espace. Un **projet** est un sous-dossier de ce
terrain, identifié comme tel — créé depuis Spaces, ou déclaré par une
conversation qui y a produit ; un espace *est* un projet, et Spaces liste des
projets, pas des jobs. Une **conversation** est un fil continu, dans le dashboard
ou dans un canal, qui porte son projet courant dès qu'elle a créé ou touché un
projet.

**La frontière entre un chat et un travail : « quelque chose est sorti du
chat ».** Lire, chercher, consulter et noter la mémoire, répondre en texte sur
n'importe quel canal — le canal est transparent, un sous-agent qui n'a fait que
parler aussi — c'est du chat. Un fichier, un document, un projet de code, une
écriture dans une base externe, une pièce jointe envoyée, un email ou tout envoi
vers un destinataire qui n'est pas un canal de la conversation, le harnais de
code : c'est un travail. La règle est récursive sur les agents à qui on a passé la main.
Elle se lit sur les cartes de P1, jamais sur un nom d'outil ; pour les outils
tiers il faut persister leur niveau de risque.

**L'agent de recherche — tranché par Quentin le 06/09 au moment du go.** À
02:15 il avait cité « utilise l'agent de recherche et ne fait pas la recherche
lui-même » comme une production ; à 02:20 il avait posé qu'un sous-agent qui n'a
fait que parler reste du chat. En donnant le go il a confirmé la seconde lecture :
« si un sous-agent est utilisé, ça ne correspond pas forcément à un projet ; s'il
ne fait que répondre à un message dans le chat, ce n'est pas un projet ». La règle
est donc **récursive** : un agent de recherche qui a seulement répondu reste du
chat ; celui qui a produit un document est un travail, et l'encart remonte au tour
parent. La garde de P7 est écrite pour cette lecture.


**Chat accueille toutes les conversations**, dashboard et Telegram, Slack,
Discord. Tout y commence. Au tour où quelque chose sort du chat, un encart dit
ce qui a été produit, le projet où il vit (nom, dossier) et renvoie à sa page. La page Chat existante change de
nature : décision de Quentin du 06/09, qui lève la consigne du 05/09 sur ce
point.

**Telegram : une conversation par chat**, jusqu'à ce que l'utilisateur en ouvre
une autre. Plus de découpage par silences. Ce qu'on redonne à lire au modèle
reste un budget.

**Les runs d'automatisation ont leur propre entrée de menu, « Scheduled ».**
Distincte d'Automations, qui reste la configuration.

**La référence produit** est l'application Claude : un Chat où tout commence, un
Code rangé par projets dont chacun est un dossier choisi par l'utilisateur. Les
dossiers `~/.claude/projects` des outils en ligne de commande sont leur rangement
interne, pas ce que l'utilisateur voit.

Ce que Telegram impose, du 05/09, reste vrai : chaque tour de l'agent est
miroité dans le canal (prose telle quelle, questions en boutons via P10,
livrables en carte via `job_deliveries`) ; l'écran et Telegram montrent la
**même** conversation ; le canal ne montre ni diff, ni tableau, ni groupe
replié — il reçoit la prose, le fichier joint, et un lien vers le projet.

## Suivi

| # | Lot | Pierres | Ce que Quentin voit à la fin | État |
|---|-----|---------|------------------------------|------|
| 1 | **Rendre visible ce qui existe** | P1 contrat de rendu · P2 conversation · P3 cartes de preuve et d'envoi · P4 barre d'état et coût | Une entrée « Spaces » ouvre le nouvel espace ; sa page est la conversation dessinée, avec preuves, coûts, jetons. Runs, Code et Chat inchangés | ✅ **LOT 1 CLOS le 06/09** — P1 (passe 16), P2 (19), P3 (21), P4 (24-25 : « aucun constat neuf ») ; retours de Quentin traités (automatisations à part, fil nettoyé sur capture réelle, coût cache-aware) · ⚠️ à voir par Quentin dans son navigateur : /spaces et un fil récent |
| 2 | **Le projet et la conversation** | P5 registre des projets · P6 conversation continue et projet courant · P7 Chat pour toutes les conversations, encart · P8 Spaces = projets, nouveau projet, chat du projet · P9 Scheduled | Chat regroupe dashboard et Telegram ; un projet naît d'un clic ou d'une production ; les automatisations ont leur page | 🟡 **go de Quentin le 06/09** — ordre : P5 · P9 (en parallèle) → P6 → P7 → P8 ; chaque pierre codée par Opus, relue par moi, puis `codex review`. ✅ P9 (`b9ff0f1b`, passe 26 traitée) · ✅ P5 (`fd2293c3`, passe 27 : 2 constats traités) · ✅ P6 (`ea984c1b`, passe 28 traitée dans `8ab609f1`) · ✅ P7 (`55ec67eb`, passe 29 traitée : issue des appels, plafonds par la fin, réponse à l'agent du fil, titres sans préfixe de groupe, fils groupés, lignes d'avant P1 dites « non classées ») · ✅ P8 (livré, passe 30 à suivre). **Lot 2 codé en entier le 06/09** ; reste la passe Codex 30 et l'œil de Quentin sur /chat, /spaces, /scheduled. La CI de la PR, rouge depuis le lot 1 (lint web, test GLM, cycle d'import P4b), est réparée au passage |
| 3 | **L'agent qui demande et montre** | P5b registre automatique · P10 `ask_user` · P11 fichiers et diff · P12 le tableur rendu | Les projets de l'onglet Code sont dans Spaces sans un clic ; « Où écrire ? » avec boutons dans le chat et dans Telegram, pour les documents seulement ; diffs cliquables ; un classeur qui s'affiche | 🟡 **go de Quentin le 06/09 (soir)** — ✅ P5b (`16d1f574` ; passes 32-35 traitées dans `4491ae46`, `aefdcec3`, `934091d4`, `4f084c21`, `268f68ef` ; passe 36 lancée) · 🔄 P10a `ask_user` (Opus en cours) · ⬜ P10b « où écrire ? » · ⬜ P11 · ⬜ P12 |
| 4 | **Ce qui reste cher** | P13 relecteurs (= PR④ de Vérifier & Corriger) · P14 aperçu vivant | Deux relecteurs cités ; l'application qui tourne au centre du projet | ⬜ |

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
| **Le diff des fichiers écrits par le harnais** | le sha de l'instantané est calculé (`checkpoints.ts:199`) mais **pas persisté** ; il vit dans le dépôt git des instantanés, étiqueté | **trou à combler** (P11) |
| L'agent pose une question avec des options | aucun outil — `ask_user` n'existe pas | **à construire** (P10) |
| Deux relecteurs cités | protocole non construit — PR④ du plan Vérifier & Corriger | **à construire** (P13) |
| L'application qui tourne | rien | **à construire, en dernier** (P14) |

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
| **On ne touche pas** | Les écrans Runs et Code, et la barre latérale. **Mis à jour le 06/09** : Chat évolue au lot 2 (P7) ; la barre gagne « Scheduled » (P9) | Décision de Quentin le 05/09 : le nouvel espace vit à côté, derrière une entrée de plus. `JobMessages` reste en place ; son lecteur de messages est réutilisé par la conversation |
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

> **État au 06/09 : close (passe 19).** `conversation-feed.ts` (le modèle,
> pur), `app/(dashboard)/spaces/` (liste + fil), `getSpaceConversationAction`,
> entrée « Spaces » dans la barre latérale. Repli/carte décidé sur la carte
> persistée ET sur ce que la charge a à dessiner (`showsAlone`). La question de
> la passe 17 est tranchée : la frontière du fil est le DERNIER message `user`
> égal à `job.task` ; ce qui précède (l'historique Telegram préfixé par
> `thread-history.ts`) se rend comme des messages ordinaires, ce qui suit
> comme des rappels du runner. Vérification visuelle sans mot de passe : CSS
> compilé récupéré sur le serveur, rendu statique d'un vrai job, capture
> Playwright ; les retours de Quentin sur le fil ont été traités sur cette
> capture.

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

**Ce qui reste hors de P2.** Le diff cliquable (P11), le tableur rendu (P12), la
question à boutons (P10) : leurs cartes affichent un état « pas encore rendu »
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
> **Dépendance découverte le 06/09, résolue par P4a** : la garde (« cache lu au dixième, cache écrit 1,25× ») suppose un estimateur cache-aware. Or `estimateModelCostUsd` (`packages/shared/src/model-catalog.ts`) calcule `input × prix + output × prix` et ignore `cachedTokens` / `cacheCreationTokens` ; seul OpenRouter rapporte un coût déjà cache-aware. P4 se scinde donc : (a) la barre d'état depuis `llm_calls` tel quel (jetons, part de cache, coût rapporté, durée, envois en attente) ; (b) l'estimateur cache-aware, travail moteur à part (backlog « cache-aware »), sans lequel le coût des fournisseurs natifs reste surestimé.

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

**Lot 2 · Le projet et la conversation**

### P5 · Le registre des projets — M

**Ce que ça pose.** Une table des projets : nom, dossier racine, sorte (`code` ou `documents`), agent responsable, créé par toi depuis Spaces ou déclaré par une conversation qui y a produit. Le **dossier racine d'un projet est un sous-dossier du terrain d'un agent** (`agent_workspaces`) : le terrain est un droit, le projet est un objet. Un sous-dossier qui n'est pas au registre n'est pas un projet.

**La règle.** Une production qui atterrit dans un projet enregistré s'y rattache sans rien demander. Hors de tout projet, l'agent demande **où** avant d'écrire (P10) ; la réponse crée le projet. Rien ne se crée en silence.

**Sur quoi ça s'appuie.** `agent_workspaces` (libellé + chemin, déjà par agent), `code_projects` et `PROJECT_MARKERS` (Vérifier & Corriger) pour la sorte `code`, les intentions de mutation et leurs clés canoniques pour savoir où une production a atterri.

**Garde.** Un `file_write` dans `terrain/projet-x/` d'un projet enregistré rattache le job à ce projet ; le même écrit dans `terrain/vrac/` sans projet ne crée rien et déclenche la question ; un chemin hors terrain reste refusé, comme aujourd'hui.

**À vérifier.** La sorte `documents` n'a pas de marqueur : créée à la main ou par la question, jamais devinée.

**Livré le 06/09 (`fd2293c3`, passe Codex 27).** Le registre est `code_projects` étendu (`registered_at` NULL = ligne de comptabilité, NOT NULL = projet ; `kind`, `agent_id`, `registered_from`, `registered_job_id`) et `agent_jobs.project_id`. Le rattachement lit les cibles de l'intention de mutation (contenance, le plus niché gagne, le premier projet du job gagne). Deux décisions prises en chemin, **à valider par Quentin** :

- *Le terrain lui-même peut être le projet* (`subfolder` vide dans « Nouveau projet ») : le cas d'un dépôt attaché tel quel. Codex note qu'un terrain-projet englobe alors TOUT ce que l'agent y écrit, `terrain/vrac` compris, et que sur le chemin du harnais de code (dont la cible est le terrain entier) chaque session s'y rattache. Si Quentin tient à « projet = sous-dossier strict », il suffit de refuser le sous-dossier vide.
- *Le rattachement se fait après le succès de l'écriture*, pas avant (contrairement à l'intention de mutation, qui reste conservatrice) : un outil qui échoue ne « produit » rien dans le projet.

### P6 · La conversation continue et son projet courant — M

**Ce que ça pose.** Une conversation est un fil : un par chat Telegram, Slack ou Discord, un par conversation du dashboard. Il dure **jusqu'à ce que tu en ouvres une autre** (un bouton dans le dashboard, une commande dans le canal, à nommer). Elle porte un **projet courant**, posé quand une production atterrit dans un projet ou quand elle naît depuis la page d'un projet, et redit au modèle à chaque tour.

**Ce qui change.** Le découpage par silences disparaît comme identité de conversation (décision du 06/09). Il reste un **budget de relecture** : ce qu'on redonne au modèle. La conversation peut avoir trois mois, le prompt non — deux choses différentes, l'identité du fil et la mémoire qu'on en relit.

**Sur quoi ça s'appuie.** `conversations` + `chat_messages` (dashboard), `agent_jobs.conversation_id` (285 jobs Telegram sur 286 le portent, mesuré le 06/09), `resolveConversationId` et `thread-history.ts` pour la relecture.

**Garde.** Deux messages Telegram à une semaine d'écart sont dans la même conversation ; « nouvelle conversation » en ouvre une autre, la précédente reste lisible ; une production dans un projet pose le projet courant et le tour suivant le voit dans son prompt ; la relecture reste sous le budget quelle que soit la longueur du fil.

**Livré le 06/09 (commit P6, passe Codex 28 à suivre).** `conversations` est la table de TOUS les canaux (migration 0094 : `channel`, `chat_id`, `current_project_id`, backfill d'une ligne par conversation de canal existante — 54 sur la base dev) ; **pas de clé étrangère** depuis `agent_jobs.conversation_id` (95 jobs de la base dev portent l'uuid d'une conversation supprimée, la page Runs perdrait leur regroupement). La commande est **`/new`** (nu : la tâche reste `/new`, le prompt dit « premier tour » ; suivi d'un texte : c'est le texte) ; un fil neuf ne reprend pas le projet courant du précédent. La relecture lit les jobs de tête de la conversation sous `MAX_TURNS` et `BUDGET_CHARS` ; le silence de 4 h a disparu. Le bloc `## Conversation` du prompt dit le nombre de tours précédents et le projet courant (nom, dossier, sorte). Un job né dans une conversation ancrée porte son `project_id` dès l'insert (canaux et escalade `run_task`). Un tour de chat du runtime CLI pose le projet courant sans job. Hors périmètre, à faire plus tard : l'ancienne variable `THREAD_IDLE_RESET_MINUTES` ne survit que dans le script de backfill 0059.

### P7 · Chat, la maison de toutes les conversations — L

**Ce que ça pose.** La page Chat liste **toutes** les conversations, tous canaux, avec leur origine. En ouvrir une rend le fil de P2, le même code. Au tour où quelque chose est sorti du chat, un **encart** dit ce qui a été produit, le projet où il vit (nom, dossier) et le lien vers sa page. Répondre depuis le web dans une conversation venue d'un canal passe par l'outil d'envoi de ce canal.

**La frontière.** Chat : lire, chercher, consulter **et noter** la mémoire, répondre en texte sur n'importe quel canal de la conversation (le canal est transparent), déléguer à un agent qui n'a fait que parler. Travail : un fichier, un document, un projet de code, une écriture dans une base externe, une pièce jointe envoyée, un email ou tout envoi vers un destinataire qui n'est pas un canal de la conversation, le harnais de code. **Récursif** sur les descendants. Se lit sur les cartes de P1 ; les outils tiers (`generic`) exigent de persister leur niveau de risque sur `tool_calls`, une colonne de plus. Les outils natifs se classent par leur **carte**, jamais par leur niveau de risque : `save_memory` est `write` pour la garde d'exécution mais `text` pour la carte, donc chat ; le niveau de risque ne sert qu'aux outils tiers, qui n'ont que `generic`.

**Hors périmètre.** La page Runs et son classificateur `classifyJob` (qui compte une recherche web comme une tâche) restent tels quels.

**Garde.** Un « bonjour » : sans encart. Une recherche web répondue dans le chat : sans encart. Un `save_memory` : sans encart. Un `file_write` dans un projet : encart avec le lien. Un email avec les résultats : encart. Un connecteur en écriture : encart ; en lecture : sans. Un sous-agent qui n'a fait que parler : sans ; un sous-agent qui a écrit : encart sur le tour parent.

**Tranché par Quentin le 06/09 (au go du lot 2).** **L'agent de recherche** suit la règle récursive : seul ce que le sous-agent a produit compte. « S'il ne fait que répondre à un message dans le chat, ce n'est pas un projet. » La garde « un sous-agent qui n'a fait que parler : sans encart » est donc la bonne ; déléguer n'est jamais en soi une production.

**À vérifier.** **Deux sources pour un fil.** Une conversation du dashboard vit dans `conversations` + `chat_messages` ; le contrat du schéma dit qu'un tour pur ne crée pas de job et qu'un tour devenu action porte `jobId`. Le fil de P2 lit un job : P7 doit lire les deux (les tours dans `chat_messages`, les actions par leur job) — à vérifier dans le code du chat avant de découper P7. Et répondre depuis le web dans un fil Telegram, Slack, Discord : canal par canal, ce que l'outil d'envoi permet aujourd'hui.

**Livré le 06/09 (commit P7, passe Codex 29 à suivre).** `/chat` = la liste de TOUTES les conversations (origine, agent, titre ou première demande, projet courant, tours, dernière activité ; recherche, suppression, « New conversation ») ; `/chat/[id]` = le fil de P2 sur toute la conversation (`conversation-thread.ts` : les jobs de tête d'un canal, ou les `chat_messages` du dashboard avec le job escaladé sous chaque tour, sans les `history` préfixés, la consigne passée au job repliée en « handoff »), la preuve et les envois de tous les jobs, la barre d'état sur tout le fil, et la saisie en bas pour le dashboard. La frontière chat / travail (`chat-or-work.ts`) se lit sur les cartes : `files`, `sent` hors du canal de la conversation, `terminal`, `cli:*`, `generic` avec `risk_level` `write`/`destructive` (migration 0095, écrit par `executeTool`) ; `read` = chat ; sans niveau = incertain, dit tel quel ; récursive sur les descendants (lecture (b)). L'encart « Produced » nomme les fichiers (plafond 8), le projet (`agent_jobs.project_id`) et renvoie à `/spaces/<id>` (page de P8). Le chat à deux volets et ses trois actions de lecture ont disparu. **Limites** : les lignes d'avant P1 n'ont pas de carte, donc les fils anciens n'ont pas d'encart ; répondre depuis le web dans un fil venu d'un canal reste hors périmètre (le fil le dit).

### P8 · Spaces : la liste des projets et la page du projet — L

**Ce que ça pose.** Spaces liste des **projets**, plus des jobs : nom, dossier, sorte, agent, dernière activité, état de la preuve. Un bouton **Nouveau projet** : nom, dossier sous un terrain, sorte. La page du projet : l'étagère (dossier, fichiers, preuve, le panneau existant), ses conversations, et **la saisie en bas**, une conversation dédiée au projet, comme le panneau de chat d'un IDE. Un job créé depuis là naît avec le projet courant.

**Ce qui change.** La page `/spaces/[id]` actuelle (le fil d'un job) devient le fil d'une conversation, lue depuis Chat ou depuis le projet. Rien du rendu ne se perd : P2 à P4 sont le fil, la preuve, la barre d'état.

**Sur quoi ça s'appuie.** P2-P4 ; `ChatClient` et `sendChatMessageAction` pour la saisie ; P5 pour le registre ; P6 pour le projet courant.

**Garde.** Créer un projet crée la ligne et son dossier ; parler depuis la page crée un job dont le prompt porte le projet ; un job venu de Telegram qui a produit dans ce dossier apparaît dans les conversations du projet.

**Livré le 06/09 (commit P8, passe Codex 30 à suivre).** `/spaces` liste les projets enregistrés (nom, sorte, agent, dossier, travaux, dernière activité, dernier verdict de preuve par clé d'identité) ; « New project » = une modale non dismissable (agent → terrain → sous-dossier avec aperçu du chemin final, sorte). `/spaces/[id]` = l'étagère (dossier, fichiers sur un niveau avec `.git`/`node_modules` comptés, preuve : configuration déclarée + dernières séquences), les conversations du projet (celles de ses travaux et celles ancrées par `current_project_id`), puis le fil de la conversation du projet et la saisie en bas — le premier envoi crée cette conversation, ancrée au projet, agent ROOT. Le fil d'un run a déménagé vers `/scheduled/[id]` ; `listSpacesAction` et la table des jobs de Spaces ont disparu. **Deux arbitrages pour Quentin** : le lien d'une délégation dans un fil pointe vers `/scheduled/<jobId>` faute de route neutre pour le fil d'un job (un délégué n'est pas un run) ; la configuration de la preuve n'a pas d'URL propre (elle vit dans la table de l'écran Code), l'étagère renvoie vers `/code`. **Passe Codex 30, traitée** : un échec de lecture du fil est dit et retire la saisie ; la preuve ne charge que ses trois dernières séquences ; un dossier illisible dit sa cause (absent, pas un dossier, permission) ; **la conversation du projet est celle ouverte depuis sa page** (`origin = 'project'`, migration 0097), pas la plus récente ancrée ; un lien symbolique est listé comme tel, sans être suivi ; la troncature du fil lit N + 1. Reporté au lot 3 : la conversation du projet naît avec le ROOT, pas avec l'agent responsable du projet. **Passe Codex 31** : un seul constat, sans population — une conversation de projet créée avant 0097 ne serait plus reconnue, mais l'action qui en crée et la migration partent dans la même PR, et la base dev n'a aucune conversation ancrée (mesuré) ; dit dans la migration. Le lot 2 est clos côté code ; il attend l'œil de Quentin.

### P9 · Scheduled — S

**Ce que ça pose.** Une entrée de menu **Scheduled** : les automatisations et leurs runs, une ligne par automatisation, repliée, ses runs dessous — ce que la section Scheduled de Spaces fait aujourd'hui, à sa place. Un lien vers Automations pour la configuration. Plus aucun run d'automatisation dans Spaces ni dans Chat.

**Sur quoi ça s'appuie.** `listSpacesAction` (deux requêtes, deux limites), `groupSpaces`, `ScheduledSection` : le code existe, il change de page.

**Garde.** Aucun run cron dans Spaces ni dans Chat ; un run ouvre son fil.

**Livré le 06/09 (`b9ff0f1b`, passe Codex 26 → `0cb5889b`).** Entrée « Scheduled » (icône `CalendarCheck`), page `/scheduled`, `listScheduledRunsAction` ; Spaces sans cron (garde mutée). La passe 26 a fait remonter deux dettes du lot 1, corrigées : l'id d'une automatisation supprimée survit désormais dans la provenance du job (deux homonymes supprimées restaient une seule ligne), et les trois `<button>` bruts de ClampedText/StatusBar sont passés par le DS. **Décision à valider par Quentin** : le contrat documenté de `TextButton` a été élargi à la *disclosure inline* (« Show more », les segments jetons/coût de la barre d'état) plutôt que de créer un composant DS de disclosure compact (qui exigerait sa parité Figma) ; « Back to the conversation » est un `RowActionButton`.

**Lot 3 · L'agent qui demande et montre**

### P5b · Le registre se remplit tout seul — S

**Ce que ça pose.** Question de Quentin le 06/09 au soir : « en quoi les projets qui sont dans le menu Code n'ont pas leur place dans la page Spaces ? » Réponse : ils y ont leur place, la séparation venait de mon découpage (P5 a livré « créé depuis Spaces » et reporté « déclaré par une conversation qui y a produit » à P10, alors que l'onglet Code fait déjà cette seconde moitié à sa façon). **Une seule définition** : un dossier où une production de code atterrit et qui porte un manifeste est un projet, déclaré par cette conversation. Le registre se remplit au rattachement (racine dérivée par la règle de l'intention, manifeste présent → ligne enregistrée, origine « conversation », agent = celui qui produit, job = celui qui a produit) ; un backfill au démarrage du runner enregistre ce que l'onglet Code montre déjà ; le chemin CLI lit les chemins édités par le harnais. « Rien ne se crée en silence » ne vise plus qu'un dossier sans manifeste : la question de P10 se restreint aux documents.

**Garde.** Un `file_write` dans `terrain/app/src/` avec `terrain/app/package.json` enregistre `terrain/app` et y rattache le job ; le même dans `terrain/vrac/` n'enregistre rien ; une ligne de comptabilité avec preuve devient le projet sans perdre sa preuve ; un projet rangé s'enregistre en restant rangé ; le backfill est idempotent.

**Reste à part.** L'onglet Code lit encore sa dérivation ; le faire lire le registre est une pierre ultérieure.

**Livré le 06/09 (`16d1f574`, puis `4491ae46` et `aefdcec3` pour la passe Codex 32, `934091d4` pour la passe 33, `4f084c21` pour la passe 34).** Codé par moi : l'agent Opus est tombé sur sa limite de session au premier geste (reset 19h10), et Sonnet est interdit (Quentin, 06/09 : « tu as interdiction d'utiliser sonnet à la place de opus »). Ce qui est en place : `projects/markers.ts` (le manifeste et les chemins réels, partagés entre l'intention et le registre), `projects/register.ts` (`INSERT … ON CONFLICT DO UPDATE … WHERE registered_at IS NULL`, une instruction, `display_name` et `hidden` jamais touchés), la déclaration dans `attach.ts` AVANT la recherche du projet contenant, le chemin CLI qui lit les chemins écrits par le harnais, le backfill au boot du runner (`REGISTRY_BACKFILL`). Sur la base dev : 3 projets déclarés (`podium-app`, `igdb-app`, `notes-app`), 5 jobs rattachés ; les 9 autres « projets » de l'onglet Code sont `Dev` lui-même (sans manifeste) et huit dossiers du coffre Obsidian, masqués et sans manifeste — des documents, pas des projets.

**Ce que la passe Codex 32 a corrigé dans la règle.** (1) *Seules les cibles fichier déclarent* : un tour CLI réussi sans édition (« je vais d'abord analyser », en mode écriture) déclarait le dossier attaché à manifeste ; une cible dossier est un périmètre, pas une production — elle rattache à un projet déjà déclaré, elle n'en déclare aucun. (2) *Déclaration et rattachement en une transaction* : sans job et sans conversation trouvée, la déclaration est annulée ; deux racines tombent ensemble. (3) `agent_id` = l'unique détenteur, sinon NULL (l'ordre des lignes ne désigne personne). (4) `registered_at` = l'instant de la déclaration (Spaces l'affiche comme date d'ajout), et pour que la page d'un projet montre son activité, *le backfill rattache l'historique* (`agent_jobs.project_id`) — aussi pour un projet déclaré d'un clic. (5) Les chemins du harnais se résolvent sans le disque (un fichier écrit puis supprimé reste une production). (6) Compteurs du backfill par raison. **Passe 33** (aucun constat bloquant, les huit constats de 32 confirmés traités) : la course entre l'enregistreur d'événements de la CLI (insertions jamais attendues) et la lecture des chemins écrits — les écritures d'audit en vol sont attendues avant de lire ; et `realPathOf` d'un chemin disparu remonte à l'ancêtre existant (un fichier écrit puis supprimé sous un alias retombe sous sa racine réelle). **Passe 34** : un P0 vrai — l'attente des écritures d'audit n'avait pas de borne, une connexion figée gelait un tour déjà terminé ; bornée à 5 s, dite par un code ; le test de la course est dit temporel (fenêtre 1,5 s et preuve que le tour a attendu) ; la remontée de `realPathOf` s'arrête au partage d'un chemin UNC, jamais le serveur seul. **Passe 35** : le test de la course est refait SANS horloge (`268f68ef`) ; le P0 restant — une insertion figée n'est pas annulée à la borne et garde sa connexion — n'est pas propre à P5b : c'est la robustesse du client de base (`statement_timeout` exclu à dessein, keepalive TCP 60 s, `lock_timeout` 30 s), la même exposition pour toute requête du runner et pour les insertions d'audit d'avant P5b. Arbitrage ci-dessous.



**Arbitrages pour Quentin.** *Connexions figées* : Codex (passe 35) pointe qu'une requête sur une connexion morte sans RST tient sa connexion du pool jusqu'aux sondes keepalive de l'OS ; ce n'est pas P5b, c'est le client — poser un `statement_timeout` par session (sauf backfills), ou un délai de lecture socket, est une décision d'infrastructure à prendre à part. *Jonctions* : deux dossiers attachés qui pointent vers le même dépôt physique donnent deux projets (c'est D10 du plan « Vérifier & Corriger », toujours ouvert) — interdire les racines qui se recouvrent, ou accepter deux identités. *Historique borné* : le rattachement des jobs passés lit la fenêtre du scan (1 500 dernières écritures) ; les jobs plus anciens restent sans projet. *Un tour de chat CLI ne déclare jamais* (sans job, l'audit ne dit pas quelles écritures sont les siennes) : un dépôt attaché à un agent en runtime CLI attend un tour de JOB pour apparaître dans Spaces.

### P10 · `ask_user` — M

**Ce que ça pose.** Un outil qui pose une question avec des options. Dans la conversation : la carte à boutons. Dans le canal d'origine : la même carte, via l'infrastructure des approbations (`notify.ts`, préfixe de rappel propre). La réponse reprend le job exactement comme une approbation le fait. **Premier usage : « où écrire ? »** quand une production sort du chat hors de tout projet (P5).

**Ce que ça absorbe.** La seconde moitié de v7-C (approbation des commandes de preuve dans le canal) est un cas de `ask_user`. Une plomberie, deux usages.

**Garde.** Un `ask_user` suspend le job ; un clic dans le canal le reprend avec la réponse dans le transcript ; une réponse hors options est refusée ; la réponse à « où écrire ? » crée le projet et pose le projet courant.

**Découpée en deux le 06/09 (soir).** *P10a — la plomberie* (Opus, en cours) : l'outil `ask_user` (2 à 6 options, `card: 'question'`), un troisième plancher dans la porte d'approbation (`asksUser` : ni une règle `auto_approve` ni l'autonomie ne sautent une question), `approval_requests.kind ('approval'|'question')` + `answer` (migration 0098), la résolution qui refuse une réponse hors options, la carte Telegram à un bouton par option (`apr:<id>:o<n>`), la page Approvals et la carte `QuestionCard` dans le fil des trois pages, avec la réponse une fois donnée. *P10b — « où écrire ? »* (à suivre) : `register_project` (un projet de documents déclaré depuis la conversation, rattaché aussitôt), la guidance du prompt système (demander avant d'écrire hors de tout projet déclaré et hors manifeste), et `computeApproval` de `register_project` qui exige une question répondue dans le même job — sauf autonomie totale.

### P11 · Fichiers et diff — M

**Ce que ça pose.** La carte « 12 fichiers » : la liste cliquable, le diff de la sélection.

**Sur quoi ça s'appuie.** Pour `file_edit`, `tool_input` porte l'ancien fragment (`old_string`) et le nouveau : le diff se rend directement. Pour `file_write`, l'entrée ne porte que le chemin et le **nouveau** contenu (vérifié le 06/09, `file-write.ts`) : l'état antérieur doit venir de l'instantané du tour. Pour le harnais de code comme pour `file_write`, il faut donc le sha de l'instantané : **il n'est pas en base.** Deux pièces : persister `(job_id, turn, sha, workspace)` quand `takeCheckpointForTurn` le calcule (aujourd'hui seulement journalisé), puis `git diff` dans le dépôt des instantanés.

**Limite.** Hors d'un dépôt git, il n'y a pas de diff pour ce que le harnais écrit ni pour un `file_write` qui écrase : la carte dit alors « fichiers écrits, sans diff ». Seul `file_edit` rend son diff partout.

**Garde.** Un `file_edit` semé rend son diff exact ; un instantané semé puis un second rendent le diff git attendu ; un `file_write` qui écrase dans un dossier sans git rend l'état « sans diff » et pas une erreur.

### P12 · Le tableur rendu — S

**Ce que ça pose.** La carte `table` pour un `office_file` : les premières lignes de la feuille demandée, les contrôles v7-B en pied. Un tableau de valeurs, pas Excel : ni formules, ni fusion, ni mise en forme, dit tel quel. La charge utile de P1 dit déjà si la première ligne est un en-tête (`header: 'unknown'` pour un classeur lu) : la carte le demande ou le dit, elle ne devine pas.

**Sur quoi ça s'appuie.** `xlsx_read` et sa carte `table` (P1).

**Lot 4 · Ce qui reste cher**

### P13 · Les relecteurs — L

**Ce que ça pose.** C'est la PR④ de Vérifier & Corriger, inchangée. Ici seulement sa carte : deux relecteurs, leur verdict, leur citation. Rien à planifier de neuf, une dépendance à nommer.

### P14 · L'aperçu vivant — XL

**Ce que ça pose.** Lancer et tenir un serveur de développement par projet, l'afficher, gérer ports et arrêts. C'est le produit entier de Lovable. **Dernier, et sans promesse.** Tant qu'il n'existe pas, le centre du projet montre le dernier diff, et le bouton « L'application » ouvre l'URL locale dans un onglet.

## Ce que ça fait aux seize onglets

Deux entrées de plus, « Spaces » et « Scheduled ». Et une page qui change de
nature : **Chat**, qui accueille désormais toutes les conversations — décision
de Quentin du 06/09. Runs et Code restent tels qu'ils sont ; les fusionner un
jour est une décision de Quentin, pas une conséquence de ce plan.

## Ce que ça fait au plan Vérifier & Corriger

Il continue. Ce plan est la **surface** ; l'autre est le **moteur**. Les points
de contact : v7-B nourrit la carte du tableur (P12) ; la seconde moitié de v7-C
est absorbée par P10 ; les intentions de mutation disent où une production a
atterri (P5) ; le niveau de risque déclaré par les outils, persisté sur
`tool_calls`, sert la frontière chat / travail (P7) ; PR④ est P13.
L'observation, la garde et le runtime CLI ne bougent pas.

## Les limites, dites avant de commencer

- Le raisonnement n'est visible que pour les modèles qui l'émettent ; l'écran
  le dira au lieu de faire semblant.
- Le diff du harnais de code n'existe que dans un dépôt git.
- Le tableur rendu est un tableau de valeurs.
- L'aperçu vivant peut ne jamais ressembler au dessin.
- La maquette est une intention, pas une spécification au pixel : chaque pierre
  sera validée à l'écran, par Playwright, avant d'être dite finie.
- La frontière chat / travail dépend du niveau de risque que les outils tiers
  déclarent : un connecteur qui se déclare mal se classe mal — et l'écran dira
  d'où vient la classification.
- Répondre depuis le web dans un fil venu d'un canal dépend de l'outil d'envoi
  de ce canal ; à vérifier canal par canal avant de le promettre.
