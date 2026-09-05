<!-- artifact: https://claude.ai/code/artifact/8744ad8c-e7ec-455a-8ae7-4ca25d826ede -->

# Vérifier & Corriger — la preuve entre dans la boucle

Plan v6.6 du 03/09/2026 — **BOUCLE DE RELECTURE SUR PLAN CLOSE (11 passes
Codex) ; découpage de PR① en cours — D8/D9 tranchées le 03/09 (écrivains sur
les cinq surfaces au choix de l'utilisateur, UI de configuration et de lecture
en ①)** — **REMIS EN TÊTE DE FILE par Quentin le
02/09** («
tout un aspect sur la loop de vérif n'est pas fait, pas codé, même pas
démarré » — planifier, selon les best practices des harnais agentiques). La
v5 (02/09) relit la v4 à l'aune de ces pratiques et lui ajoute trois choses
(§ « v5 »). La **v6 (03/09)** répond à deux questions de Quentin — « et les
tâches qui ne sont pas du code ? », « la relecture doit-elle toujours être
faite par un autre LLM ? » — et à son exigence produit : **l'utilisateur
définit ses relecteurs et décide, par type de tâche, s'il en faut 0, 1, 2 ou
3**. Six papiers lus pour ça (§ « v6 »). **D5-D7 tranchées le 03/09 ; la v6
passe par une passe Codex avant le découpage de PR①.** Historique : v1 → Codex passe 1 (16 constats) → v2 → passe 2
(16 constats) → v3 + **décisions D1-D4 tranchées par Quentin** → passe 3
(7 constats, liste fermée) → v4 → passes 4-6 → PRÊT → backlog 31/08 → v5.

État du code vérifié le 02/09 sur `main` (`4bb9b6c4`) : **rien de ce plan
n'existe** — aucune colonne `verify_*`, aucune table d'état, aucun
`review_rounds` ni `repair_attempts`, aucun read-before-write (`FS_STALE`) ;
le cron `deliver-results.ts` écrit toujours `status` en direct sur
`agent_jobs` ; `runInShell` n'est toujours pas exporté. Les ancrages de la v4
tiennent.

Vision actée en discussion (31/08) : le code est le PREMIER vérificateur
branché sur une tuyauterie prévue pour tous les livrables — lot futur
« vérificateurs par type de livrable » (xlsx qui s'ouvre et recalcule,
invariants contre la source, artifact qui rend, critique LLM pour le
non-prouvable). Les reviewers restent : la machine vérifie le prouvable, le
jugement couvre l'intention, le design et la qualité des tests eux-mêmes.

## Suivi

| # | PR | Contenu | État |
|---|----|---------|----|
| 0 | Passes Codex sur la v6 | Passe 7 (03/09) : 11 questions, 9 TROU/FAUX, 8 bloquants — fermés en v6.1. Passe 8 : 6 fermés, 5 partiels (résidus v4 dans PR④, la primitive et le cron), **1 neuf bloquant** (deux contrats de hash) — fermés en v6.2 : hash unique normatif, PR④ réécrite, `review_pending` dans l'union, prédicats par livrable, reprise idempotente du cron, écrivains du modèle atomique. Passe 9 : tout fermé, **1 neuf bloquant** (crash entre `completedAt` et la livraison canal = root jamais relivré — bug latent EXISTANT, vérifié) → v6.3 : outbox `job_deliveries` sur le modèle atomique, réclamation à deux populations, section v3 marquée historique. Passe 10 : tout fermé, **2 neufs bloquants dans le correctif de la passe 9** (pas de claim atomique ; latence de 120 s pour les jobs interactifs) → v6.4 : claim par `UPDATE … RETURNING` avec lease, drain immédiat post-commit, tick en reprise seule. Passe 11 (dernière sur plan) : drain FERMÉ ; claim NON FERMÉ (lease 60 s < timeouts réels des adaptateurs, vérifié) + 1 neuf (borne 3 hors du claim) → v6.5 : `attempts < 3` dans le WHERE, timeout d'envoi imposé par l'outbox (90 s), lease = 2× (180 s). **Boucle sur plan CLOSE — 11 passes, 14 bloquants fermés. Prochaine action : découpage de PR①.** | ✅ **close** |
| ① | Fondations + observation outillée | Schéma exact — état par **(job, livrable)** (v6-A) ; **vérificateurs pluggables**, le code (liste ordonnée de commandes, v5-A) en est le premier ; `projectKey` partagé + migration ; primitive terminale typée (cron compris) ; **outbox de livraison `job_deliveries`** (v6.3 — ferme un bug existant) ; moteur pur testé ; **écrivains d'intention sur les cinq surfaces + réglage utilisateur des surfaces (D8)** ; **UI de configuration et de lecture (D9)** ; infra de tests de course sur vrai Postgres. **Garde NON branchée** : la preuve tourne, se journalise et se lit — c'est la phase d'observation (v5-C). | ⬜ en découpage (03/09) |
| ② | **La vérification se choisit toute seule** (v7 — nouveau, remonté devant tout le reste) | Le type de livrable se DÉDUIT de ce qui est produit ; les vérifications **sans pouvoir** tournent toujours, sans configuration ni approbation ; les commandes du projet sont **découvertes** et approuvées **dans le canal d'où vient la demande** ; les exigences de la demande deviennent des critères vérifiables. Détail : § « v7 — vérifier sans configurer ». | **v7-A faite** (05/09) — restent B, C, D |
| ②→③ | Observation | Une semaine de vrais jobs sur la stack de Quentin, preuve journalisée et lisible sans bloquer : taux de rouge, faux rouges, durée des preuves. Les seuils de la garde se calent sur ces chiffres. **Déplacée après v7** : sans elle, l'observation ne mesure que les projets configurés à la main, c'est-à-dire aucun. | ⬜ |
| ③ | Garde active + `code_task` | Garde branchée sur la primitive (états de décision, libellé « succès non vérifié »), preuve code_task sous verrou décisionnelle, compteurs persistants (`red_streak`), **extrait de feedback borné** (v5-B), **contrôle d'oracle sur les tests écrits par l'agent** (v6-B). | ⬜ |
| ④ | Runtime CLI | Finally unique (heartbeat + verrous), multi-projets, réparation unique, livraison conditionnée au résultat typé. | ⬜ |
| ⑤ | Protocole revue à N relecteurs | Snapshot `job_protocol='review'`, verdict immuable **et fondé** (chaque constat cite sa preuve, v6-D), `review_rounds`, preuves de lignée ; **pool de relecteurs et politique par type de tâche (0-3) en base, lancés par le harnais en parallèle, un seul passage chacun** (v6-C) ; textes de skills. | ⬜ |
| suite | Écritures périmées | Read-before-write typé (`FS_NOT_OBSERVED` / `FS_STALE_VERSION`) sur les outils fichiers — même famille (« corriger » sans s'écraser), hors de ce plan, juste après lui | ⬜ backlog harnais n°1 |

## v7 — vérifier sans configurer (05/09, demande de Quentin)

### Le constat qui déclenche cette version

Quentin, devant l'écran livré en ① : « je m'en fous des commandes, pourquoi
devrais-je en donner ? Imagine, je lance un projet **via Telegram** : je ne suis
pas sur l'interface, je ne peux rien cocher. Il faut que le système comprenne ce
que je demande et choisisse les vérifications correspondantes. Et pour un fichier
Excel, ça marche comment ? »

Trois choses sont vraies dans cette phrase, vérifiées dans le code avant d'écrire
cette section :

1. **Le canal d'entrée n'est pas l'interface.** Une tâche arrive par Telegram,
   Discord, un cron, un webhook. Il n'y a pas de moment où l'utilisateur voit un
   écran. Or ① fait de la configuration un PRÉREQUIS : sans commandes approuvées,
   `loadConfig` rend `not_configured` et rien ne tourne. Sur le chemin réel de
   Quentin, la vérification ne se déclencherait donc jamais.
2. **Le type de livrable est codé en dur.** `intent.ts` pose
   `deliverableType: 'code_project'` pour toute écriture, quel que soit l'outil —
   un `.xlsx` écrit dans un projet marque le projet sale et relance ses tests
   alors que le code n'a pas bougé. Défaut introduit en fermant le P0 « outils
   Office sans intention » de la revue Codex.
3. **Le non-code n'a rien**, et il était prévu en dernier (lot ⑤, après trois
   autres). L'ordre livrait d'abord ce qui exige de configurer, et remettait à
   plus tard ce qui ne demanderait rien.

### Le principe

> **Ce qu'il faut vérifier se déduit de ce qui a été produit et de ce qui a été
> demandé. L'utilisateur ne configure rien. Il n'est sollicité que lorsque
> vérifier exige d'exécuter du code du dépôt — et alors, on le lui demande LÀ OÙ
> IL EST.**

La ligne de partage n'est pas « code / non-code » mais **« avec pouvoir / sans
pouvoir »** :

| | Ce que Nodal fait | Permission |
|---|---|---|
| **Sans pouvoir** | Ouvre le fichier produit, recalcule, compare, relit ce qui a été envoyé, vérifie qu'un chiffre cité existe dans la source | **Aucune.** Nodal lit ce qu'il a lui-même produit ; rien du dépôt ne s'exécute |
| **Avec pouvoir** | Lance `pnpm test`, `pytest`, un `Makefile` | **Une fois par projet**, parce qu'un agent qui modifie `package.json` contrôle ce que la commande lance (D1) |

C'est cette ligne qui rend le cas Telegram possible : par défaut, tout ce qui se
vérifie sans pouvoir est vérifié, sans écran, sans question.

### Ancrages (lectures du 05/09)

- **GUISpector** (arXiv 2510.04791) — des exigences en langage naturel non
  structuré sont converties, par un LLM en zero-shot, en une représentation
  structurée dont des critères d'acceptation. C'est exactement le geste de la
  brique D ci-dessous ; le papier confirme que l'extraction marche, pas que les
  critères extraits soient tous vérifiables — d'où le filtre mécanique qu'on
  ajoute.
- **« Define Done, Not Effort »** (digitalapplied, 2026) — le levier le plus fort
  d'un prompt d'agent est le critère d'acceptation écrit, assorti d'un contrôle
  que l'agent peut lancer.
- **Prédicats exécutables / evidence-grounded verification** (arXiv 2607.01793,
  2607.12650) — la vérification doit produire un prédicat exécutable et un
  artefact ré-exécutable hors ligne, jamais un score de confiance. Cohérent avec
  les invariants déclarés de v6-A et avec `verification_runs`.
- Rappel de v6 : *All Smoke No Alarm* (2606.18168) — 80 % des tests d'agents sans
  oracle fort. Un critère tiré d'une demande est un oracle FAIBLE tant qu'il n'est
  pas mécaniquement vérifiable : c'est la raison du filtre, pas une précaution de
  style.

### Les quatre briques

**A — Le type de livrable se déduit de ce qui est produit.** Mécanique, zéro LLM.
Le hook `resolveMutationTargets` rend aujourd'hui un chemin ; il rendra aussi un
TYPE. `xlsx_*` / `docx_*` / `pptx_*` ⇒ `office_file`. Une écriture de fichier dans
un projet ⇒ `code_project` seulement si le fichier appartient au projet (source,
config, test) ; sinon `other`. `telegram_send_message` et les autres envois ⇒
`outbound_action`. Le littéral en dur d'`intent.ts:431` disparaît : le type vient
de l'appelant, comme la cible. Ferme le défaut n°2 ci-dessus.

**B — Les vérifications sans pouvoir tournent toujours.** Un vérificateur
`office_file` : le fichier s'ouvre vraiment, les formules recalculent, les
totaux d'une colonne égalent la somme de ses lignes, aucune cellule n'est en
`#REF!` / `#DIV/0!`. Un vérificateur `outbound_action` : le message est
réellement arrivé (l'outbox le sait déjà). Aucune de ces vérifications n'exécute
quoi que ce soit du dépôt ⇒ aucune approbation, aucun réglage, aucun écran.
C'est la brique qui donne de la valeur à quelqu'un qui n'ouvre jamais
l'interface.

**C — Les commandes du projet sont découvertes, puis approuvées là où tu es.**
Découverte mécanique : `package.json` (scripts `test`, `typecheck`, `lint`,
`build`), `pyproject.toml`, `Makefile`, `cargo`. Proposition **cochée par
défaut** sur l'écran. Et si la demande vient d'un canal : quand un projet
découvert n'a pas encore d'approbation, Nodal envoie **dans ce canal** la carte
d'approbation — le mécanisme existe déjà (boutons inline ✅ / ❌,
`apps/runner/src/telegram/approval-callback.ts`), il n'y a pas à l'inventer. Un
seul geste, une seule fois par projet. Tant que ce n'est pas approuvé, l'état
reste « pas encore vérifiable », dit tel quel, et le job n'est jamais bloqué.

**D — Les exigences de la demande deviennent des critères vérifiables.** « Fais-moi
le tableau avec les totaux par mois » porte un invariant. Un agent extrait les
critères candidats de la demande (ancré : GUISpector), puis **un filtre mécanique
ne garde que ceux qu'une machine sait vérifier sur le livrable produit** — les
autres sont jetés, jamais devinés, jamais transformés en jugement flou. Les
critères retenus sont affichés dans le détail du run, avec leur verdict. Un
critère non retenu est dit lui aussi : « je n'ai pas su vérifier ça
mécaniquement ». Cette brique dépend de A et B ; elle vient en dernier des
quatre.

### Découpage en PR (à raffiner en tickets avant de coder)

| PR | Contenu | Dépend de | État |
|---|---|---|---|
| **v7-A** | Le type de livrable vient du hook, plus de littéral dans `intent.ts` ; `office_file` traverse la tuyauterie jusqu'à l'écran, avec un vérificateur qui rend « pas encore vérifiable » | ① | FAIT le 05/09 (`22255204` + `5198a8ee`) |
| **v7-B** | Vérificateur `office_file` (ouvre, recalcule, invariants de structure) et `outbound_action` (constat d'envoi depuis l'outbox), tous deux **sans pouvoir**. **`outbound_action` est descendu de A vers B** : son constat vient de l'outbox, pas d'une intention de mutation, et la primitive ne traite que les livrables mutables | v7-A | à faire |
| **v7-C** | Découverte des commandes d'un projet + proposition cochée + carte d'approbation dans le canal d'origine | v7-A | à faire |
| **v7-D** | Extraction des critères depuis la demande + filtre mécanique + rendu dans le détail du run | v7-A, v7-B | à faire |

Chaque PR suit la discipline de ① : tests sur données réelles, une mutation par
garde, `codex review` en boucle jusqu'au retour vide.

### v7-A — livrée le 05/09, et ce qu'elle a corrigé dans le plan

Ce que le plan disait, et qui était faux :

| Le plan disait | Ce que le code a montré |
|---|---|
| `outbound_action` traverse la tuyauterie en v7-A | **Non.** Son constat vient de l'**outbox**, pas d'une intention de mutation, et la primitive terminale ne traite que les livrables **mutables** (générations sale / vérifiée). Descendu en v7-B, avec son propre chemin |
| `office_file` traverse **sans vérificateur** | **Impossible.** `finalize.ts` résout un vérificateur pour CHAQUE livrable : un type sans vérificateur fait **lever** la finalisation d'un job parfaitement normal. Il en faut donc un, qui rend « pas configuré » |
| Le type se déduit de ce qui est produit | Vrai, mais **pas depuis le chemin**. Une première version classait par extension : `data/fixtures/users.csv` devenait un document, donc éditer une donnée de test ne relançait plus les tests. Le type vient de l'**outil**, jamais d'un suffixe |

Ce que v7-A a livré :

- le type de livrable est **obligatoire** sur une cible de mutation — un outil
  mutant ajouté sans le déclarer est une erreur du compilateur ;
- deux règles de canonicalisation, choisies par un `switch` **exhaustif** : le
  projet englobant pour un projet de code, le fichier lui-même pour un
  document ;
- un type déclaré sans règle est **refusé**, et l'écriture n'a pas lieu ;
- pas de ligne `code_projects` pour un document — il apparaîtrait comme un
  projet dans l'onglet Code ;
- l'écran ne renvoie plus un document vers « sa carte de projet dans Code ».

Preuve par mutation : reclasser le hook Office en projet de code fait rougir
les deux tests d'intention. Côté finalisation, un fichier témoin constate
qu'aucune commande du projet ne tourne pour un document.

### Ce que v7 ne fait PAS

Elle ne branche pas la garde (toujours en ③), ne touche pas au protocole de
revue (⑤), et n'invente aucun jugement : un critère qui ne se vérifie pas
mécaniquement est écarté, pas confié à un LLM qui donnerait un avis. La ligne
« la machine d'abord, un relecteur différent ensuite, jamais un juge unique »
reste celle de v6.

## Principes

1. **Pas de devinette** (inv. #4) : commande configurée par l'owner, par
   projet, en base — jamais détectée.
2. **La preuve est un fait** (inv. #2) : verdict dans l'état du job, le
   transcript, l'audit — jamais du texte écrit par le runner.
3. **Fail-closed partout où une garde décide** : intention de mutation écrite
   AVANT la mutation ; verdict persisté avant la finalisation ; panne de
   persistance ⇒ `VERIFY_PERSISTENCE_FAILED`, jamais un passage.
4. **Le texte suit la machine** ; **tests par mutation** ; toute course a son
   **test d'interleaving à deux connexions DB réelles**.

---

## v5 — ce que la revue des best practices ajoute (02/09)

Sources relues le 02/09 : Osmani (*Agent Harness Engineering*), Datadog
(*Closing the verification loop*), Faros (*Harness Engineering 2026*),
Anthropic (*Building effective agents*), plus les leçons dsh et PuppyOne déjà
en mémoire. Ce que la v4 couvre déjà : la preuve lancée par le harnais, pas
par l'agent ; une condition d'arrêt testable (« vert »), pas « améliore le
code » ; des boucles bornées par la machine (réparation ×1, rouge ×2, revue
×2) ; le verdict comme fait persisté ; l'audit dans `verification_runs`.
Trois pratiques manquaient, toutes vérifiées absentes de la v4 :

### v5-A · Des capteurs gradués, du moins cher au plus cher — fail fast

Toutes les sources le disent de la même façon : **compilation et analyse
statique d'abord** (secondes, diagnostic précis), tests ensuite (minutes,
diagnostic large). La v4 n'avait qu'une commande. La v5 remplace
`verify_command` par **une liste ordonnée** `verify_commands` (json, 1 à 5
entrées, chacune `{command, timeoutSeconds}`) exécutée en séquence, **arrêt
au premier rouge**. Un `pnpm typecheck` rouge en 8 s évite un `pnpm test`
de 4 min et donne à l'agent l'erreur la plus précise en premier. Le
manifeste hashé (D1) couvre la liste entière — modifier l'ordre ou une
entrée invalide l'approbation. `verification_runs` reçoit une ligne **par
commande**, avec son rang ; le verdict du projet est celui de la séquence
(vert ssi toutes vertes). Une seule commande reste le cas nominal — la liste
n'impose rien.

### v5-B · Le feedback réinjecté est borné et exploitable

Faros : « catches hallucinations immediately » suppose que l'agent *lise*
l'erreur ; dsh leçon 3 : un résultat d'outil de 50 Ko est un résultat que le
modèle ne lit pas. La v4 bornait ce qui est *stocké* (queues bornées), pas ce
qui est *réinjecté* en réparation. La v5 fixe le contrat : l'agent reçoit
**un extrait** — les N dernières lignes (N = 80) plus toute ligne matchant
`error|fail|✗|Error:|FAIL` (cap 40), dédupliquées, précédées de la commande
qui a rougi, de son code de sortie et de sa durée — et **le chemin du log
complet** (`verification_runs.id`, lisible par `file_read` si le dossier de
logs est dans le périmètre, sinon dit tel quel). Le même extrait alimente le
`tool_result` de `code_task` (PR②) et la demande de réparation CLI (PR③). Un
seul module produit l'extrait ; testé par des cas nommés (sortie vide, sortie
de 10 Mo, sortie sans ligne d'erreur ⇒ tail seul).

### v5-C · Une phase d'observation avant d'activer la garde

Anthropic (*shadow mode*) et Datadog (*observability closes the loop*) : on
n'active pas une garde qu'on n'a pas mesurée. La v4 activait la garde en PR②
sans données. La v5 impose **une semaine d'observation entre ① et ②** sur la
stack de Quentin : PR① fait tourner la preuve sur chaque projet muté et la
journalise dans `verification_runs`, **sans jamais changer l'issue d'un job**.
On mesure : taux de rouge réel, faux rouges (commande absente, dépendances,
environnement), durée médiane et P95 des preuves. Ces chiffres calent les
seuils de ② (timeout par défaut, `red_streak`) et donnent la première ligne
du rapport de PR② : « sur X jobs observés, la garde aurait bloqué Y, dont Z
à raison ». Aucune colonne supplémentaire : l'observation, c'est PR① sans la
primitive branchée sur la garde — le résultat typé est calculé et journalisé,
la finalisation ne le lit pas encore.

## v6 — validation générale et relecteurs configurables (03/09)

Six papiers lus le 03/09, en réponse à deux questions de Quentin et à une
exigence produit. Ce qu'ils établissent, avec les chiffres :

| Source | Ce qu'elle mesure | Conséquence pour Nodal |
|---|---|---|
| *Relational Conformance in Multi-Artifact Agent Releases* (2607.14155) | Des livrables non-code (tableur, rapport, certificat) chacun valide seul et **contradictoires ensemble** ; correction = **invariants déclarés dans un manifeste, vérifiés mécaniquement, recalcul indépendant sans les helpers du générateur, aucun LLM dans la vérification** | la machine vérifie bien plus que « le fichier existe » : elle vérifie tout ce qu'on sait énoncer comme invariant (v6-A) |
| *All Smoke, No Alarm* (2606.18168) | **80,2 %** des tests écrits par des agents de code n'ont pas d'oracle fort (ils exécutent sans vérifier) ; 33 596 PR, 5 agents ; Claude Code 67 % d'oracles forts, Codex 18 % | « tests verts » écrits par l'agent ne prouve rien sans contrôle d'oracle (v6-B) |
| *Multi-Agent Code Verification via Information Theory* (2511.16708) | gains **+14,9 / +13,5 / +11,2 pp** pour les relecteurs 2, 3, 4 — **rendements décroissants** ; relecteurs à **rôles différents** (corrélation 0,05-0,25) ; meilleur duo 79,3 % | 1 à 3 relecteurs est la bonne plage ; **différents**, pas trois copies (v6-C) |
| *Replacing Judges with Juries — PoLL* (2404.18796) | un panel de **3 modèles de familles disjointes** bat un seul gros juge, **7× moins cher**, moins de biais intra-modèle ; limite : tâches simples | familles différentes obligatoires ; l'UI doit le voir (v6-C) |
| *More Rounds, More Noise* (2603.16244) | la revue **multi-tours dégrade** : F1 0,376 → 0,263, **+62 % de faux positifs** — les relecteurs « fabriquent des constats quand les vraies erreurs sont épuisées » ; single-pass, contextes séparés > itératif | relecteurs **en parallèle, un seul passage chacun, jamais de conversation** avec le codeur ; une correction ⇒ une revue **fraîche** (v6-C) |
| *Adversarial Review* (2608.18167) | +10 pp avec un critique qui exige des **citations** ; échec typique = « faux consensus » (le critique cède sans preuve) ; règles : désaccord typé *evidence* vs *concern*, artefact **gelé** pendant la revue, interface étroite | un verdict = des constats **fondés** (chaque constat cite ligne / cellule / message) ; un *concern* sans preuve ne bloque pas (v6-D) |
| LLM-as-a-judge (2410.21819, 2606.13685, W&B, Deepchecks) | biais de position (jusqu'à 75 %), de verbosité, **auto-préférence 10-25 %**, surconfiance ; GPT-4/humain ≈ 80 % = humain/humain 81 % ; mitigations : rubriques écrites, ordre randomisé, ensembles, **calibration** | un juge LLM ne prouve pas, il juge ; il se calibre ou c'est un rite (v6-C) |

**Réponse à « toujours un autre LLM ? » : non.** L'ordre est : la machine
tranche tout ce qui s'énonce comme invariant ; un LLM *différent* juge ce qui
reste ; l'humain tranche l'irréversible. **Mais la frontière passe à
l'intérieur de « correct »** (exemple Excel de Quentin) : « Total = Σ
lignes », « entrées = source lue », « marge ∈ [0,1] », « pas de `#REF!` » sont
des invariants — la machine ; « est-ce la bonne méthode pour ce client » est
un jugement — le relecteur. Et le relecteur a **deux moments** : *avant*
(énoncer les invariants que la machine vérifiera — *contracts before code*)
et *après* (juger le reste, **en voyant les résultats machine**).

### Périmètre : une tâche est un job qui produit un livrable

Précision de Quentin (03/09) : **un tour de chat n'est pas une tâche.** La
boucle s'applique aux jobs qui produisent un livrable — du code, un fichier,
une action sortante, un document livré — jamais à une réponse
conversationnelle. Le type `other` désigne un livrable fichier/objet non
typé, pas « tout ce qui n'est pas du code ». Un job sans livrable finit comme
aujourd'hui, sans preuve ni relecture, et l'UI n'affiche aucun état de
vérification pour lui.

### v6-A · Livrable, pas projet — identité générique, deux modèles d'état, vérificateurs pluggables

**Identité (ferme Q2).** L'état de décision est par
**`(job_id, deliverable_type, canonical_key)`**, UNIQUE ensemble.
`canonical_key` est **opaque pour le cœur** et produite par un
*canonicaliseur* propre au type ; l'ordre déterministe des verrous est
`(deliverable_type, canonical_key)` croissant. **PR① ne définit que le
canonicaliseur `code_project`** (= `projectKey`, déplacé de
`apps/runner/src/job/code-projects.ts:122` vers `packages/shared` pour être
partagé runner/web) ; les autres types sont réservés dans l'enum **sans clé
provisoire** — un type sans canonicaliseur enregistré est refusé
(`DELIVERABLE_TYPE_UNSUPPORTED`), jamais accepté avec une clé inventée. Test
d'architecture : la primitive terminale ne mentionne aucun type de livrable.

**Deux modèles d'état (ferme Q1).** Les livrables **mutables** (`code_project`,
`office_file`, `document`) suivent le modèle générationnel de la v4 :
intention de mutation → `dirty_generation`, preuve verte →
`verified_generation`. Les livrables **atomiques** (`outbound_action` :
envoyer, créer, publier) n'ont pas de « sale puis prouvé » : ils ont
**« tenté puis constaté »**. Pour eux, `dirty_generation` et
`verified_generation` sont NULL (CHECK par type) et une colonne `outcome`
porte la machine d'état
**`prepared → attempted → confirmed | rejected | outcome_unknown`**.
**Écrivains et moments (v6.1, passe 8)** :
- `prepared` : le **tool** d'écriture (via le helper partagé de la matrice
  des écrivains), dans une transaction committée **avant** tout appel
  réseau — c'est là que la clé d'idempotence est posée ;
- `attempted` : le **même tool**, committé **immédiatement avant** l'appel
  réseau (deux écritures distinctes : `prepared` peut être relu par un autre
  job, `attempted` dit « l'appel est parti ou part à l'instant ») ;
- `confirmed` : le **constat**, composant du harnais appelé par le tool
  après la réponse — après relecture symétrique concluante, ou validation
  de l'accusé structuré (id retourné, persisté comme reçu) ;
- `rejected` : le constat, quand l'absence est **établie** (la relecture
  répond et ne trouve pas l'objet ; l'API répond une erreur définitive) —
  distinct d'une erreur de constat (relecture en panne ⇒ reste `attempted`) ;
- `outcome_unknown` : **seule la finalisation** l'écrit, en transformant un
  `attempted` résiduel ; le **reaper ne touche jamais** une ligne
  `attempted` et **ne rejoue jamais** l'action (la clé d'idempotence est
  refusée par le helper si la ligne existe déjà).

Projection dans le résultat terminal : `confirmed` ⇒ réglé ; `rejected` ⇒
dû (`verification_due` : l'action n'a pas eu lieu, le job ne peut pas dire
« envoyé ») ; `outcome_unknown` ⇒ non vérifiable (`completed_unverified` avec
raison `outcome_unknown`), jamais un succès vérifié.

**Constat d'une action (lot ⑤).** Deux niveaux, dits tels quels dans l'UI :
*relecture indépendante* quand le connecteur a une lecture symétrique (le
harnais rappelle l'outil de lecture et compare à l'intention — inventaire du
03/09 : Airtable 3 écritures/4 lectures, Gmail 9/11, Calendar 3/4, Sheets
4/6, Notion 8/8, Drive 2/4, Google Docs 8/2) ; *accusé structuré* quand la
lecture n'existe pas (un bot Telegram ne relit pas son propre message : la
preuve est le `message_id` retourné par l'API, persisté comme reçu). Un
connecteur sans l'un ni l'autre ⇒ `outcome_unknown`.

**Invariants déclarés (ferme Q7).** Un **manifeste unique versionné** par
livrable-cible : `{verifierConfig (= verify_commands pour le code),
invariants, canonicalKey, cwd, shellPolicyVersion, envAllowlistVersion}`,
sha-256 `v1:` sur le JSON canonique — **une seule approbation atomique** ;
modifier une commande, un invariant ou l'ordre invalide l'approbation entière
(D1). Un agent peut **proposer** un manifeste (D7) ; seul l'owner approuve.
Le vérificateur recalcule **sans les helpers du générateur** (règle du papier
2607.14155).

**Registre de lectures (ferme Q10 pour `document`).** L'ancrage « chaque
source citée a été ouverte » ne peut PAS s'appuyer sur `task-ledger.ts`
(titre, statut, noms d'outils, résultat — `task-ledger.ts:46-50`) ni sur
`STATE_CHANGING_TOOLS` (liste d'outils mutants, `thread-history.ts:126-151`)
: ni l'un ni l'autre ne trace une lecture. Il faut une table
`deliverable_reads(job_id, resource_key, digest, tool_call_id, read_at)`
alimentée par les outils de lecture, et le lien affirmation→source porté par
le livrable. Lot ⑤, pas PR①.

Les trois familles, dites dans l'UI : **prouvable** (invariants verts) ·
**constaté** (relecture indépendante ou accusé structuré) · **jugé par N
relecteurs**. Un run affiche laquelle s'applique.

### v6-B · Contrôle d'oracle sur les tests écrits par l'agent

Quand la preuve `code_project` est verte **et** que le diff ajoute des
fichiers de test, le vérificateur applique le contrôle syntaxique du papier
2606.18168 (présence d'assertions fortes par framework ; taxonomie W1→S1) et
marque le run `green_weak_oracle` si les tests ajoutés n'assertent rien. En
observation d'abord (v5-C) ; la sévérité (bloquant ou avertissement) se
décide sur les chiffres. Mutation en option ultérieure — trop coûteuse pour
la v1.

### v6-C · Relecteurs configurables — pool, politique par type, 0 à 3

- **Un relecteur est un agent** (existant : recette « Relecteur », lecture
  seule, porte `review_verdict`), sur le modèle choisi par l'utilisateur.
  Pas de nouvelle entité « LLM de review » : c'est un agent, donc de la
  donnée (inv. #1). Le **pool** = les agents relecteurs de l'espace.
- **Politique par type de tâche**, réglage d'espace, en base : pour chaque
  type de livrable (v6-A), **0, 1, 2 ou 3** relecteurs requis ; lesquels
  (liste ordonnée, ou « n'importe lesquels du pool ») ; **familles de
  modèle distinctes exigées** entre eux et avec le codeur — l'UI avertit,
  le harnais refuse (`REVIEW_POOL_SAME_FAMILY`). 0 = machine seule, dit
  tel quel (« non relu »).
- **Un seul flux, déclenché par le harnais (ferme Q3).** La revue est une
  **étape de la primitive terminale**, après la preuve machine : quand le
  résultat de preuve est admissible (`completed` ou `completed_unverified`)
  et que la politique du type de livrable exige N > 0 relecteurs, la
  primitive **suspend** la finalisation (`review_pending`), appelle
  `requestReview(snapshot_id, policy)` qui crée **exactement N** jobs
  `job_protocol='review'` (snapshot posé à la création, comme en v4), et
  reprend à l'agrégation. **Un agent ne peut plus initier un relecteur
  isolé** : le skill `request-review` ne délègue plus vers un slug, il
  appelle `requestReview` — inv. #3, une porte. Une délégation LLM vers un
  agent porteur de `review_verdict` hors de ce chemin est refusée
  (`REVIEW_MUST_GO_THROUGH_HARNESS`). Aujourd'hui `delegate.ts:78-110`
  construit le prompt et insère UN child — c'est le **point futur
  d'insertion**, pas un calcul de whitelist existant (correction Q10).
- **Snapshot gelé par type (ferme Q4).** Table
  `deliverable_snapshots(id, deliverable_type, canonical_key, digest,
  storage_ref, created_at)`. `digest` = sha-256 des octets gelés :
  `code_project` = HEAD + hash du diff sale (v4) ; `office_file` et
  `document` = **copie du blob** dans le stockage local Nodal + sha-256 ;
  `outbound_action` = reçu normalisé immuable. Les N jobs de revue
  référencent le **même `snapshot_id`** — jamais la ressource mutable par son
  adresse courante. `content_id` de la v4 devient `snapshot_id`.
- **Exécution** : N jobs **en parallèle**, chacun sur le même `snapshot_id`
  + les **faits machine** (preuves, invariants, oracle) ; **un seul passage
  chacun** ; contexte de production et contexte de revue séparés ; le codeur
  ne parle jamais aux relecteurs.
- **Cycles (ferme Q5).** Table `review_cycles(id, deliverable_state_id,
  snapshot_id, round_number, outcome)`. Un cycle = N verdicts attendus sur
  un snapshot. L'agrégation **clôt le cycle une seule fois** ;
  `review_rounds` sur le job demandeur **s'incrémente une fois par cycle**
  dont l'agrégat exige une correction — jamais par verdict (2 `request_changes`
  sur 3 = un cycle, un incrément). Une correction ⇒ nouveau snapshot ⇒
  nouveau cycle ⇒ N revues fraîches. À 2 ⇒ `REVIEW_ROUNDS_EXHAUSTED`,
  escalade vers l'humain (inchangé).
- **Agrégation (D5, tranchée).** Un constat *bloquant fondé* (avec citation)
  de n'importe quel relecteur ⇒ le cycle exige correction ; approuver exige
  que **tous** les relecteurs requis aient rendu un verdict et qu'aucun
  bloquant fondé ne reste ; les *concerns* sans preuve sont remontés, jamais
  bloquants.
- **Échec d'un relecteur (ferme Q6), fail-closed.** Un relecteur requis sans
  verdict (job failed, budget, provider, timeout) **empêche l'approbation**.
  Le cycle reste `review_pending` ; **une relance** du seul job manquant sur
  le même snapshot ; si elle échoue aussi ⇒ cycle `review_incomplete`, job
  demandeur `blocked` avec code typé `REVIEW_INCOMPLETE` et escalade humaine.
  Un échec technique **n'est ni un `request_changes` ni un cycle consommé**
  (`review_rounds` inchangé).
- **Familles de modèle (ferme Q9).** Le catalogue n'a aucune notion de
  famille (`ModelCatalogEntry` : modelId, label, capabilities, contextWindow,
  pricing, route, providerOrder — `packages/shared/src/model-catalog.ts:116`
  ; `modelGroupLabel` rend `null` pour les ids natifs sans slash, l. 1275).
  Ajout : **`modelFamily`** (ex. `anthropic:claude`, `openai:gpt`,
  `google:gemini`, `zai:glm`), indépendant du transport (un Claude natif et
  un Claude via OpenRouter ⇒ même famille), **obligatoire** pour qu'un modèle
  soit éligible relecteur. Résolution `(provider, modelId)` → famille ;
  famille inconnue quand la politique exige la diversité ⇒ refus fail-closed
  (`REVIEW_POOL_FAMILY_UNKNOWN`) ; même famille qu'un autre relecteur ou que
  le codeur ⇒ `REVIEW_POOL_SAME_FAMILY`.
- **Calibration** (v2 du lot, pas v1) : taux d'accord de chaque relecteur
  avec les décisions finales de l'owner, affiché sur sa fiche.

### v6-D · Un verdict fondé

Schéma actuel de `review_verdict`
(`packages/tools/src/builtin/review-verdict.ts:18-100`) : findings
`{file, line?, issue, severity: 'blocker' | 'major' | 'minor'}`, verdict
`approve | request_changes`. On **garde `blocker`** (pas `blocking`) et on
ajoute, par constat : `kind` (`evidence | concern`) et une **citation
générique** — `{file, line}` | `{sheet, cell}` | `{messageId}` |
`{resourceKey, locator}` — **obligatoire pour `evidence`**. Un verdict
`request_changes` dont aucun constat `blocker` n'est `evidence` est refusé
par l'outil (`REVIEW_VERDICT_UNGROUNDED`). Textes des skills `code-review` /
`request-review` alignés.

### Décisions v6 — TRANCHÉES par Quentin le 03/09/2026

- **D5 — Agrégation à N relecteurs** : un constat *bloquant fondé* (avec
  citation) de n'importe quel relecteur bloque ; l'approbation exige que
  tous les relecteurs requis aient rendu leur verdict et qu'aucun bloquant
  fondé ne reste. Les *concerns* sans preuve sont remontés, jamais bloquants.
- **D6 — « Type de tâche » = ce que la tâche demande de produire** (type de
  livrable : code · fichier Office · action sortante · document · autre) —
  et non l'agent ni le skill. Un même agent qui code le matin et envoie un
  récap le soir relève de deux politiques. C'est la même clé que celle des
  vérificateurs : un seul réglage.
- **D7 — Invariants : un agent peut en proposer, seul l'owner approuve** (D1
  s'applique : manifeste hashé, approbation durable).

### Décisions PR① — TRANCHÉES par Quentin le 03/09/2026 (découpage)

Trouvées par la lecture d'exécutabilité du plan (workflow Understand, 03/09)
: onze passes Codex avaient vérifié la cohérence du plan, pas ce qu'il
faut pour que PR① **mesure** quelque chose.

- **D8 — Écrivains d'intention en ① : les cinq surfaces, et l'utilisateur
  décide lesquelles sont sous vérification.** Le helper partagé et la
  matrice des écrivains (v4, prévus en ②) passent en ① ; un **réglage
  d'espace** liste les surfaces (`code_task` write, runtime CLI write,
  `file_write`/`file_edit`, `run_command`/`run_skill_script`) avec une case
  chacune — cochée = les travaux venant de cette surface posent l'intention
  et sont prouvés. **Défaut : toutes activées** (à confirmer par Quentin) ;
  une surface décochée est dite telle quelle dans le détail de run (« non
  vérifié : surface hors vérification »), jamais silencieuse (inv. #4).
- **D9 — Il faut une UI en ①.** « Aucune UI active » est retiré. PR①
  embarque l'UI de **configuration** — sur la fiche projet de l'onglet Code
  : commandes de preuve (liste ordonnée), geste d'approbation owner avec
  l'avertissement (« ces commandes exécutent du code du dépôt »), état
  `pending_approval` / approuvé ; et dans les réglages d'espace : le réglage
  D8 — et l'UI de **lecture** : dans le détail d'un run, les
  `verification_runs` (commande, rang, code de sortie, durée, verdict). La
  **garde reste non branchée** en ① (v5-C : observation) ; les états de
  décision (« succès vérifié / non vérifié / bloqué ») et leur libellé
  arrivent en ② avec la garde. Une sous-commande CLI n'est pas retenue.

### Ce que la v5 ne change PAS

Les décisions D1-D4 ; le découpage en quatre PR ; le protocole
transactionnel ; le modèle de données hors `verify_commands`. Les points
« à étudier » du backlog harnais (règles textuelles → machine : couvert par
④ ; exposition `llm_calls` : hors plan ; restauration testée : à auditer)
restent où ils sont.

---

## Le modèle central

### Table `job_deliverable_verification_state` (v4 : `job_project_verification_state`)

L'état de DÉCISION, par (job, livrable). Le texte v4 ci-dessous est écrit
pour le livrable `code_project` ; la v6.1 (§ v6-A) généralise l'identité et
ajoute le modèle atomique. Lire `project_key` comme « `canonical_key` du type
`code_project` » et `code_projects` comme « la table cible de ce type ».

| Colonne | Rôle |
|---|---|
| `job_id` FK cascade · `deliverable_type` · `canonical_key` — **UNIQUE ensemble** (v6.1) | identité |
| `outcome` (v6.1, livrables atomiques seulement, CHECK par type) | `prepared · attempted · confirmed · rejected · outcome_unknown` |
| `idempotency_key` (v6.1, atomiques) | posée à `prepared`, avant l'appel |
| `display_path_snapshot` | lisibilité audit |
| `dirty_generation` int | incrémentée par l'INTENTION de mutation |
| `verified_generation` int, CHECK `verified <= dirty` | posée par une preuve verte |
| `decision_status` enum `dirty·green·red·pending_approval·not_configured·infra_error` | l'état lisible |
| `command_hash_snapshot` | le manifeste prouvé |
| `red_streak` int | preuves rouges CONSÉCUTIVES sur ce projet (remis à zéro par un vert) — à 2, la finalisation refuse (`VERIFY_ATTEMPTS_EXHAUSTED`) |
| `repair_attempts` int | respawns de réparation INITIÉS PAR LE HARNAIS (runtime CLI). `0` = aucun. Incrémenté AVANT l'unique respawn ; toute réparation est refusée dès `repair_attempts >= 1`, y compris après reprise du processus (D2) |
| `tested_epoch` int | epoch global testé par la dernière preuve |
| `updated_at` | — |

Suppression du job ⇒ cascade (l'audit survit dans `verification_runs`).

### L'intention de mutation — AVANT d'écrire

`dirty_generation` s'incrémente avant le premier accès mutant. Un CLI qui
écrit puis sort non-zéro, une sortie illisible, un runner qui tombe : le
projet est déjà sale. Une tentative qui n'écrit rien reste conservativement
sale. Une réparation ré-incrémente avant le respawn.

### Matrice des écrivains dirty

| Surface | Résolution de la cible | Écrivain de l'intention | Verrou |
|---|---|---|---|
| `code_task` write | projet du `cwd` résolu | le tool, avant le spawn | verrou workspace existant |
| runtime CLI write | tous les projets sous les workspaces attachés | run-job.ts, avant `binding.run` | verrous existants (tous dossiers) |
| `file_write` / `file_edit` | chemin absolu résolu → projet englobant | helper partagé, entre résolution et appel filesystem | transactionnel (voir protocole) |
| `run_command` / `run_skill_script` | tous les projets du périmètre d'écriture (conservatif) | le tool, avant le spawn | idem |

Test d'architecture : tout tool `mutatesWorkspace` appelle le helper.

### Quand la preuve tourne — le contrat PAR SURFACE (lève l'ambiguïté D3/PR②)

| Surface | Moment de la preuve | Effet |
|---|---|---|
| `code_task` write | immédiatement après le run, sous le verrou encore tenu | DÉCISIONNELLE : pose `verified_generation = G` et `tested_epoch` ; la finalisation ne re-prouve pas si génération et epoch sont restés courants |
| runtime CLI write | idem, dans le finally unique, avant libération | idem + cycle de réparation D2 |
| boucle nodal pure (`file_write`…) | à la FINALISATION du job (D3) — jamais par écriture | décisionnelle |

Une seule règle en découle : **la finalisation exige `verified ≥ dirty` et
epoch courant, quel que soit le moment où la preuve a tourné** — la preuve
immédiate n'est pas un « diagnostic », c'est la preuve de sa génération.

### Le protocole transactionnel (course intra-job ET inter-jobs)

`READ COMMITTED` laisse passer deux courses : intention non committée vs
finalisation (même job), et epoch lu périmé pendant qu'un AUTRE job incrémente
(constat bloquant #2 de la passe 3 — verrouiller la seule ligne `agent_jobs`
ne sérialise pas deux jobs). Protocole imposé :

- **Toute intention** : `SELECT ... FOR UPDATE` sur la ligne `agent_jobs` DU
  job, PUIS sur les lignes `code_projects` concernées **en ordre déterministe
  (project_key croissant)** ; vérifier non-terminal ; incrémenter
  `verification_epoch` (code_projects) et `dirty_generation` (état) ; commit.
- **Toute validation/finalisation** : mêmes verrous, même ordre — les
  intentions et finalisations de TOUS les jobs se sérialisent sur les lignes
  `code_projects`.
- **Validation verte** : `UPDATE ... SET verified_generation = G,
  decision_status='green', tested_epoch = E WHERE dirty_generation = G` —
  zéro ligne ⇒ `VERIFY_STALE_GENERATION`.
- **Tests** : interleaving à deux connexions réelles, intra-job ET
  inter-jobs (un job B écrit pendant la preuve du job A ⇒ A ne finalise pas
  vérifié).

### La primitive terminale typée

Union de retour (v6.1, passe 8) : `completed | completed_unverified |
review_pending | already_terminal | verification_due |
verification_persistence_failed`.

Prédicats **par livrable** (v6.1) — un livrable est *réglé* si : mutable ⇒
`green` (génération et epoch courants) ; atomique ⇒ `confirmed`. Il est
*non vérifiable* si : mutable ⇒ `not_configured` ; atomique ⇒
`outcome_unknown`. Il est *dû* si : mutable ⇒ sale non prouvé, rouge ou
périmé ; atomique ⇒ `rejected`, ou `attempted` avant la finalisation (voir
§ écrivains).

- **`completed`** : chaque livrable du job est réglé, et la politique de
  revue de son type est satisfaite (N = 0, ou cycle clos sans bloquant
  fondé).
- **`completed_unverified`** (D4 permissif-honnête) : chaque livrable est
  réglé OU non vérifiable, au moins un est non vérifiable, revue satisfaite.
  La livraison est AUTORISÉE ; le run s'affiche « succès **non vérifié** »
  avec la raison (`not_configured` / `outcome_unknown`) — libellé distinct,
  jamais confondable avec un succès vérifié. Prédicat PAR LIVRABLE : « A
  vert, B non configuré » ⇒ `completed_unverified`.
- **`review_pending`** (v6.1) : les preuves sont admissibles (`completed` ou
  `completed_unverified` hors revue) mais la politique exige N > 0 et le
  cycle courant n'est pas clos. La primitive a créé le cycle (idempotent :
  `UNIQUE(deliverable_state_id, snapshot_id, round_number)` — un second
  appel sur le même snapshot ne crée rien et rend `review_pending`), le job
  reste non terminal, non livré. La clôture du cycle (agrégation) rappelle
  la primitive, qui rend alors `completed` / `completed_unverified`, ou
  `verification_due` (correction exigée) ou `blocked` typé
  (`REVIEW_ROUNDS_EXHAUSTED`, `REVIEW_INCOMPLETE`).
- **`verification_due`** : au moins un livrable dû ⇒ boucle de réparation ou
  `blocked`.
- **`verification_persistence_failed`** : la persistance de la décision a
  échoué ⇒ jamais un succès.
- La livraison canal est interdite hors `completed` / `completed_unverified`.

**Une seule porte** : toutes les transitions terminales succès passent par la
primitive — chemin `return_result`, chemin sans tool call (`execute.ts:2919`),
runtime CLI (`run-job.ts:400`), et le cron task-board
(`deliver-results.ts:184-211`) qui calcule `rootStatus` et écrit `status` +
`completedAt` en direct dans une seule réclamation. Test d'architecture :
aucune écriture directe de `status='completed'` hors de la primitive.

**Le cron, reprise idempotente (v6.1, passe 8).** Le cron ne pose plus
`completedAt` lui-même : il **réclame** le root (même garde qu'aujourd'hui,
`completedAt IS NULL AND status NOT IN terminal`) en posant un marqueur
`finalizing_at`, calcule le résultat compilé, puis appelle la primitive.
`completed` / `completed_unverified` ⇒ la primitive écrit le statut terminal
et `completedAt`, puis le cron livre — **par l'outbox** (ci-dessous), jamais
en direct. `review_pending` ⇒ le résultat compilé est
**persisté sur le root** (`result`, sans `completedAt`), le marqueur reste,
rien n'est livré ; le tick suivant **ignore** un root dont un cycle est
ouvert (jointure `review_cycles.outcome IS NULL`) — il ne recrée rien. La
clôture du cycle efface le marqueur ; le tick suivant réclame à nouveau,
rappelle la primitive (le cycle clos est trouvé, pas recréé), et livre ou
bloque. Test nommé : deux ticks concurrents sur un root `review_pending` ⇒
un seul cycle, zéro livraison ; après clôture ⇒ une seule livraison.

**La livraison est une action sortante — outbox (v6.3, passe 9).** Bug
latent **existant** vérifié le 03/09 (`deliver-results.ts:196-211` réclame
en écrivant `status` + `completedAt`, la livraison canal vient après, l. 245
et suiv., et aucune colonne ne trace qu'elle a eu lieu) : un crash entre le
commit terminal et l'envoi laisse un root terminal **jamais relivré**, car la
garde `completedAt IS NULL` l'exclut à jamais. Fermeture : la livraison canal
suit le **modèle atomique de v6-A** via une table `job_deliveries(job_id,
channel, chat_id, outcome, idempotency_key, receipt, attempts, updated_at)`
— `prepared` écrit par la primitive **dans la même transaction** que le
statut terminal (l'intention de livrer est commise avec la décision) ;
`attempted` juste avant l'envoi ; `confirmed` avec le reçu du canal
(`message_id`), `rejected` sur erreur définitive du canal. Le tick réclame
désormais **deux populations** : les roots non terminaux (comme
aujourd'hui) **et** les `job_deliveries` en `prepared` ou `attempted` sans
reçu (avec `attempts` borné à 3 puis `rejected` + alerte owner). Un
`attempted` sans reçu est relancé avec la **même** clé d'idempotence : un
canal qui la supporte ne double pas ; un canal qui ne la supporte pas
(Telegram) reçoit au pire un doublon plutôt que rien — dit tel quel dans le
plan, jamais silencieux.

**Claim atomique (v6.5, passes 10-11).** Une ligne de livraison n'est
envoyée que par le runner qui l'a **réclamée** :

```sql
UPDATE job_deliveries
   SET outcome='attempted', claimed_by=<runner_instance_id>,
       claimed_at=now(), attempts=attempts+1
 WHERE id=?
   AND attempts < 3
   AND (outcome='prepared'
        OR (outcome='attempted' AND claimed_at < now() - <lease>))
RETURNING id
```

Zéro ligne ⇒ un autre runner l'a, ou la borne est atteinte : on passe. La
**borne de 3 est dans le claim** (passe 11) — sous concurrence, `attempts`
ne dépasse jamais 3. Une ligne `attempted` avec `attempts >= 3` et lease
expiré est passée à `rejected` par le tick (`UPDATE … SET outcome='rejected'
WHERE outcome='attempted' AND attempts >= 3 AND claimed_at < now() - <lease>`)
avec alerte owner. Test d'interleaving à deux connexions réelles : deux
drains simultanés ⇒ un seul envoi ; frontière 3/4 : le 4e claim ne rend
aucune ligne.

**Timeout d'envoi imposé par l'outbox, lease dérivé (passe 11).** Les
adaptateurs n'ont pas de timeout homogène — vérifié : Telegram 60 s pour un
document (`packages/delivery/src/channels/telegram.ts:367-394`), WhatsApp
attend `handle.send` **sans timeout** (`whatsapp-adapter.ts:240-247`),
Discord laisse le SDK attendre ses `retry_after`
(`discord-adapter.ts:221-245`). L'outbox n'en dépend donc pas : `drainDeliveries`
enveloppe **chaque envoi** dans un timeout dur `DELIVERY_SEND_TIMEOUT_MS`
(défaut 90 s, > 60 s Telegram ; `AbortController` quand l'adaptateur le
supporte, `Promise.race` sinon — l'envoi orphelin est journalisé) et le
**lease = 2 × ce timeout** (180 s), invariant garanti par construction et
non par la discipline de chaque adaptateur. Test nommé : un adaptateur
simulé qui ne répond jamais ⇒ `attempted` reste réclamable seulement après
180 s, jamais avant.

**Drain immédiat, tick en reprise (v6.4, passe 10).** Le ticker tourne
toutes les 120 s par défaut (`apps/runner/src/cron/ticker.ts:30`, `:54`) ;
faire attendre un tick à un résultat interactif serait une régression
(aujourd'hui `run-job.ts:400-419` envoie juste après `completeJob`). Donc :
tout chemin qui commet un statut terminal appelle **`drainDeliveries(jobId)`
immédiatement après le commit**, dans le même processus — c'est lui qui fait
le claim et l'envoi dans la seconde. Le tick ne fait que **reprendre** ce que
le drain immédiat n'a pas confirmé (crash, lease expiré). Pour les jobs
interactifs, la latence reste celle d'aujourd'hui ; seul le cas de crash
attend un tick. Chemins concernés : `return_result`, chemin sans tool call
(`execute.ts:2919`), runtime CLI (`run-job.ts:400`), cron task-board. La
livraison directe (`getAdapter(channel).sendText` hors outbox) est retirée
de ces chemins — test d'architecture : aucun `send*` de canal pour un
résultat terminal hors de `drainDeliveries`.

Tests nommés : crash simulé après le commit terminal et avant le drain ⇒
livré au tick suivant, une seule fois ; crash après `attempted` ⇒ relivré
après expiration du lease, même clé ; deux drains concurrents ⇒ un envoi ;
erreur définitive ⇒ `rejected`, root reste `completed`, alerte owner ;
chemin interactif ⇒ livré sans attendre le tick (mesuré < 2 s dans le test).

---

## Progression de PR① — branche `feat/verifier-corriger-pr1`

Découpage complet : `docs/validation/pr1-decoupage-tickets.md` (24 tickets,
ordre T01 → T02 → T05 → T04 → T03 → T20 → T06 → T07 → T15 → T19 → T16 → T17 →
T18 → T08 → T09 → T10 → T11 → T12 → T13 → T14 → T21 → T22 → T23 → T24).

| Ticket | État | Commit | Ce que la vérification a montré |
|---|---|---|---|
| T01 projectKey unique | ✅ | `fc9f285b` | le scanner a trouvé **deux copies de plus** que le ticket (dont une qui ignorait l'UNC) |
| T02 types + hash du manifeste | ✅ | `d0103e33` | sha-256 pure JS en parité avec node:crypto ; mutation « tri des clés » rouge |
| T06+T07 moteur shell + séquence | ✅ | `8e6518cc` | tree-kill réparé (mutation rouge) ; la mutation StringDecoder ne rougissait qu'avec un caractère de **3 octets** — 65 536 est pair |
| T14 harnais Postgres réel | ✅ (harnais) | `345009b4` | démarrage = un TEST, pas un beforeAll (un beforeAll qui lève « saute » les tests) ; sous vitest, l'anchor de résolution est sans effet — dit tel quel |
| T15 partie partagée | ✅ | `4174aba5` | défaut « tout activé », divergence voulue avec parseRootGrants documentée |
| T05, T04, T03 migrations | ✅ | `4ad07413` | agent Sonnet + vérificateur indépendant : 4 mutations rejouées rouges ; le DROP de l'ancien UNIQUE cherche son nom réel dans `pg_constraint` ; appliquées sur PG 18 réel par le harnais |
| T20 manifeste survivant | ✅ | `7101d648` | la mutation « égalité brute » du ticket n'existe pas pour jsonb (ordre des clés normalisé) ; deux autres rouges |
| T15 partie base | ✅ | `9491b837` | seed = un test, pas un beforeAll |
| T21 écrivains web des colonnes verify_* | ✅ | (suivant) | une mutation n'avait touché que la moitié de la garde (ligne repliée par Prettier) et laissait le test vert — refaite |
| T23 réglage « Verification surfaces » | ✅ | `3f1c10c8` | ConfirmDialog sur le DÉCOCHAGE (inverse du frein) ; 3 mutations rouges |
| T24 section « Verification » du détail de run | ✅ | `668ab271` | mention D8 depuis la TRACE, pas le réglage courant (mutation « relire entities » rouge) ; dernier tick du poller |
| T08 outbox | ✅ | `f3828696` | 6 mutations rouges ; revue : `runnerInstanceId` dans un module FEUILLE (cycle d'import à un pas), alerte owner résolue sur le canal réel (resolveOwnerChatId était épinglé Telegram) ; `attempts < 3` dans le claim seul non isolable (le CHECK de la table est le filet) |
| T16 helper d'intention (5 surfaces) | ✅ | `266d324a`, `73381cf0` | 4 mutations rouges ; revue : `already_terminal` REFUSE l'écriture (un cancelled qui écrit n'est pas annulé) ; file_edit et run_skill_script étaient sans test ; `.git` est un manifeste (le test du plafond en avait fait un projet) ; un tour de chat sans job ⇒ `skipped` nommé |
| T19 registre + T09 primitive | ✅ | `1ca6e6dd`, `89ac12f0` | revue : signature en OBJET (T10-T12 l'écrivent littéralement), `VERIFY_TERMINAL_WRITE_LOST` levé (un return null committait) ; **le statut seul dit terminal** (un job réessayé garde son `completed_at`, trouvé par F1/Leg1) ; **réclamation `finalizing_at` en tx1** ⇒ une preuve par job (le point « incomplet » du découpage) ; **epoch bougé pendant la preuve ⇒ dirty** (VERIFY_STALE_EPOCH) |
| T17 surface runtime CLI (run-job + run-chat) | ✅ | `dfd75c12` | 3 mutations rouges ; le scan statique du filet des verrous borne la distance try → prompt (commentaires sortis du try) |
| T11 bascule runtime CLI | ✅ | `5c1ce997` | envoi direct retiré ; course perdue ⇒ already_handled (l'ancien code envoyait) ; crash entre commit et drain ⇒ prepared survit ; mutation « envoi direct » rouge (deux sendText) |
| T10 bascule execute.ts | ✅ | `845c63ea` | asymétrie already_handled corrigée ; hook `beforeRespond` du client LLM simulé pour la course perdue |
| T12 bascule cron | ✅ | `3d92d964` | payload figé (synthèse UNE fois), marqueur périmé relâché, M4 réécrit sur l'outbox ; mock delivery devenu PARTIEL (l'outbox veut le vrai DeliveryError) |
| T14 tests d'interleaving (PG réel) | ✅ | `babb72db` | mutation « réclamation toujours accordée » rouge ; connexions à CHAUFFER sinon la course n'a pas lieu ; plan amendé (échoue si absent, jamais sauté) |
| T18 tests d'archi de l'intention | ✅ | `19ec727e` | agent Opus (Agent tool), vérifié indépendamment ; par ÉNUMÉRATION du registre (checkpoint-wiring avait oublié runSkillScriptTool) ; 3 mutations rouges — deux tentatives de mutation « spawn » étaient FAUSSES (un import, puis `spawnMut(`), la troisième (`spawn(` littéral) rougit |
| T22 panneau de configuration (fiche projet) | ✅ | `ef5dde37` | agent Opus, vérifié ; `verifyManifestHash` (hash COURANT) ajouté aux prefs comme jeton ; `isOwner` aligné sur le prédicat des ÉCRITURES (pas d'exemption local-trust : un panneau actif que le serveur refuse mentirait) ; e2e code-verification écrit, NON EXÉCUTÉ |
| T13 tests d'archi (status hors primitive, send* hors outbox, primitive sans type) | ✅ | `b940db0d` | scanner multiligne + 4 règles prouvées sur arbre temporaire ; allowlist des envois non terminaux = exactement les 6 fichiers du grep ; 3 mutations rouges ; `completeJob` reste l'écriture interne, la règle compagne sur ses appelants tient « une seule porte » |
| Stack redémarrée sur 0088-0091 | ✅ | — | migrations appliquées sur la base de dev sans erreur (fusion des doublons comprise), web 200, runner ok ; les 6 `io_worker` orphelins des suites Postgres réel ont dû être tués avant |
| e2e code-verification + settings-verification-surfaces | ⬜ NON EXÉCUTÉS | — | la stack de dev est en local-auth (config Quentin) et le global-setup Playwright exige local-trust ou l'endpoint better-auth ; ils tourneront en CI (qui boote en local-trust) |
| PR #46 ouverte, `codex review` passe 1 | 🔄 | `8cdfc0b1` | rapport `docs/validation/rapport-review-pr46-passe1.md`. **P0 tenu : les 20 outils Office écrivaient SANS intention** (aucun marqueur `mutatesWorkspace` ; le test d'énumération ne pouvait pas le voir) ⇒ hook partagé `officeMutationTargets`, surface `fileOps`, représentant docx_create au seam. **P0 tenu (outbox)** : `now` figé au début du drain datait la k-ième réclamation trop tôt ⇒ horloge relue par ligne ; l'issue (confirmed/rejected) n'était pas gardée par `claimed_by`/`attempts` ⇒ `stillOurs`, code `DELIVERY_CLAIM_LOST` ; drain de reprise borné à 20. **P0 partiel, assumé** : un envoi orphelin après timeout + reprise après bail = doublon possible (aucun adaptateur n'accepte d'annulation ni d'idempotence) — dit par le plan, non corrigeable en ①. **P1 refusé** : l'alerte owner `DELIVERY_REJECTED …` est une notification SYSTÈME (comme approvals/notify), pas la voix de l'agent — l'invariant #2 vise l'agent. **P1 accepté comme limite** : les règles d'archi sont lexicales (comme tous les scanners du dépôt) ; ce sont des filets, complétés par les tests de câblage. **CI rouge trouvée au passage** : sur le runner GitHub Windows, `os.tmpdir()` rend la forme 8.3 et `realpath` la longue ⇒ aucune cible ne tombait dans une racine, l'intention n'était jamais posée ⇒ canon `realpath` des deux côtés, test par jonction/symlink |
| `codex review` passe 2 | ✅ | (ce lot) | rapport `docs/validation/rapport-review-pr46-passe2.md` : **un seul constat, P0, TENU** — le canon `realpath` de la passe 1 nommait le projet par son dossier RÉEL alors que l'onglet Code dérive ses projets des racines telles qu'écrites (lien, jonction, forme 8.3) ⇒ deux lignes `code_projects` pour un même dossier. Correctif : comparer sur les chemins réels, NOMMER par la racine lexicale (`rebaseOntoLexicalRoots`) ; le test par lien attend désormais la clé du lien. La CI Windows le confirmait : les lignes existaient sous `runneradmin` alors que les tests attendaient `RUNNER~1` |
| `codex review` passe 3 | ✅ | (ce lot) | rapport `docs/validation/rapport-review-pr46-passe3.md` : un constat P0 (déduit), TENU — deux racines qui se contiennent (un lien vers le conteneur + un projet du conteneur attaché à part) : la première dans l'ordre de configuration nommait le projet par le lien ; désormais la plus SPÉCIFIQUE (plus long chemin réel) nomme, test à deux racines. ⚠️ Trois passes ont trouvé chacune une finesse dans le correctif de la précédente, dans la même fonction : si la passe 4 en trouve une quatrième, la spec d'identité d'un projet (racine lexicale vs réelle, racines imbriquées) est à trancher avec Quentin, pas à itérer |
| `codex review` passe 4 | ✅ | (ce lot) | rapport `docs/validation/rapport-review-pr46-passe4.md` : encore une finesse dans la même fonction (une racine réelle PARENTE court-circuitait une racine LIÉE plus spécifique via le raccourci lexical) — tenue par UNE règle unique sur les chemins réels (racine au plus long chemin réel), test ajouté. **BOUCLE ARRÊTÉE ICI, par la règle du skill** : quatre passes ont affiné la même fonction ; ce qui reste n'est pas une règle de plus mais un choix de produit — **D10 à trancher par Quentin : deux racines attachées qui recouvrent le même dossier physique (via un lien) donnent deux identités de projet selon le label employé, des deux côtés (onglet Code compris). Interdire les racines qui se recouvrent à l'attachement, ou accepter deux identités ?** Ma reco : interdire à l'attachement (validation dans l'action web + `nodal-agents` CLI), avec un message qui nomme les deux racines |
| CI verte | 🔄 | (ce lot) | Deux échecs RÉELS trouvés par la CI, invisibles en local. (a) `pnpm deps:check` refusait un **cycle d'import** `code-project.ts → registry.ts → code-project.ts` (le registre importe la valeur, le vérificateur importait les types) ⇒ le contrat sort dans `verification/types.ts`, plus de cycle, job Linux VERT. (b) Les trois suites `*.pg.test.ts` échouaient sur le runner Windows avec « START_FAILED: undefined » ⇒ harnais instrumenté (étape nommée, tous les logs, 3 essais sur ports neufs), ce qui a donné le diagnostic : `initdb` passe, `pg_ctl start` rejette 9 fois sur 9 ports — **PostgreSQL refuse de démarrer sous un compte administrateur**, celui des runners `windows-latest`. Exclues de ce seul job, avec message ; Linux les exécute à chaque run (amendement inscrit ci-dessus) |
| Reste | ⬜ | — | D10 (racines qui se recouvrent) ; copies runner de projectRootFor / TERMINAL_STATUSES à retirer ; merge quand Quentin a mergé #45 ; **suivi remonté par l'agent T22** : aucun geste ne permet de revenir à ZÉRO commande de preuve (l'action exige 1 à 5, le bouton « retirer » disparaît à une entrée) — il faut une action « Remove proof commands » (verify_commands NULL + approbation effacée), petite |

Constat neuf à fermer dans T09 (verdict « incomplet » de la critique finale) :
la **sérialisation intra-job** de deux finalisations concurrentes du même
job après la décision n°5 (preuve hors transaction) — la transaction 2 doit
reprendre `FOR UPDATE` sur `agent_jobs` et la garde `status NOT IN terminal`
+ `completedAt IS NULL` fait qu'une seule gagne ; test à deux connexions sur
le harnais T14.

## Décisions de découpage — tranchées le 03/09 (ingénierie, pas produit)

Le découpage (workflow Understand, 14 tickets + critique) a laissé 24
questions ouvertes. D8/D9 sont de Quentin (ci-dessus) ; les autres sont des
choix d'ingénierie, tranchés ici pour que PR① soit exécutable.

1. **Trois migrations** `0088` (project_key + colonnes verify), `0089` (état
   + verification_runs), `0090` (outbox + `finalizing_at`) — testables
   séparément. ⚠️ `0086:46` a posé l'UNIQUE **sans nom** : le DROP doit viser
   `code_projects_entity_id_project_path_key`, pas le nom Drizzle.
2. **`verify_approved_by`** : `uuid` FK `users.id` `ON DELETE SET NULL`.
3. **`job_deliveries.channel`** : CHECK sur les 4 canaux à adaptateur
   (telegram, discord, slack, whatsapp) — un canal sans adaptateur ne peut
   pas être livré, refus à la préparation.
4. **`verification_runs` en ① : best-effort, jamais bloquant.** v5-C prime :
   « sans jamais changer l'issue d'un job ». Une panne d'écriture est
   journalisée fort (code + log), le job finit quand même. Le fail-closed
   `VERIFY_PERSISTENCE_FAILED` n'entre en vigueur qu'en ②, avec la garde.
   Ferme la contradiction T09 ↔ v5-C.
5. **La preuve tourne HORS transaction.** Tenir `FOR UPDATE` sur
   `agent_jobs` + `code_projects` pendant un spawn de plusieurs secondes
   heurterait `lock_timeout` 30 s / `idle_in_transaction` 60 s
   (`client.ts:54-57`) et bloquerait le heartbeat. Séquence : transaction 1
   (verrous, lecture du manifeste, `dirty_generation = G`) → **commit** →
   preuve → transaction 2 (`UPDATE … WHERE dirty_generation = G`, zéro ligne
   ⇒ `VERIFY_STALE_GENERATION`). Le garde de génération existe précisément
   pour ça. Aucun plafond artificiel de 25 s.
6. **Timeout d'envoi = 240 s, lease = 2 × = 480 s, dérivé en code** (`const
   LEASE_MS = 2 * DELIVERY_SEND_TIMEOUT_MS`) — l'invariant du plan devient
   vrai par construction. 240 s couvre le pire cas Telegram réel (30 s +
   3 × 60 s de `retry_after`, `telegram.ts:165-172`) ; à 90 s l'envoi serait
   orphelin et relivré en doublon.
7. **Reçu vide** (Telegram `'0'`, WhatsApp `''`) : `confirmed` avec
   `receipt: {messageId: null, reason: 'no_id_returned'}`. L'appel a résolu
   sans erreur — c'est l'accusé ; laisser `attempted` provoquerait un doublon
   après le lease.
8. **Alerte owner sur CHAQUE `rejected`**, pas seulement à l'épuisement des
   3 essais (constat du critique). Mécanisme : `resolveOwnerChatId` +
   transport résolu + message **codé** (inv. #2 : un code et des données,
   jamais une phrase du runner) ; pas d'owner joignable ⇒ log
   `DELIVERY_ALERT_NO_OWNER_CHAT`.
9. **Registre de vérificateurs** (ce qui manquait au découpage) :
   `VerifierRegistry` par `deliverable_type` — `canonicalize`, `loadConfig`,
   `runProof`. `finalizeJobSuccess` n'appelle que le registre : le test
   d'archi « aucun littéral de type de livrable dans la primitive » devient
   vrai, et le vérificateur `code_project` porte seul ce qui est propre au
   code. Ferme la contradiction T09 ↔ T13.
10. **sha-256 du manifeste : implémentation pure en JS** dans
    `packages/shared` (synchrone, aucun import `node:`, `shared` est bundlé
    côté client), avec un test de parité contre `node:crypto`.
    `SHELL_POLICY_VERSION` / `ENV_ALLOWLIST_VERSION` y vivent aussi (le web
    ne dépend pas de `@nodal-agents/tools` — vérifié), avec un test-snapshot
    dans `tools` qui rougit si l'allowlist change sans bump.
11. **Harnais Postgres réel : échoue si absent, jamais `skip`** (inv. #4 — un
    test vert par absence est un faux vert). Binaire embedded-postgres
    atteint par jonction (`pnpm install` cassé sur Node 26.4.0).
12. **Cron** : `failed` → `failJob` ; `cancelled` → helper `cancelRootJob` ;
    seul le succès passe par la primitive. `finalizing_at` orphelin relâché
    après 10 min par la phase cron. `synthesizeForChannel` : repli **explicite
    et journalisé** (code), jamais silencieux.
13. **Hors ①**, confirmé : l'extrait borné v5-B (②), le contrôle d'oracle
    v6-B (②), l'envoi-outil `telegram_send_message` pendant un run (lot ⑤ —
    `execute.ts` ne contient aucun `sendText` terminal, le plan le disait à
    tort), les lignes `verification_runs` des commandes non exécutées après
    un rouge (aucune ligne), la politique de capture de `run_command` pour
    l'agent (reste `head` ; la preuve utilise `tail`).
14. **Bench** : les trois nouveaux scanners d'architecture entrent dans
    `packages/bench/src/sections/architecture.ts`.

## PR① — fondations fermées

- **Schéma** : la table d'état, `verification_runs` (observabilité
  best-effort : jobId set-null, projectKey, manifeste, **rang de la commande
  dans la séquence (v5-A)**, exitCode, queues bornées, durée, verdict,
  génération et epoch testés), colonnes `code_projects` : **`verify_commands`
  (json, liste ordonnée `{command, timeoutSeconds}`, v5-A)**,
  `verification_epoch`, `verify_approved_manifest_hash`,
  `verify_approved_at/by`.
- **Garde NON branchée (v5-C)** : la primitive terminale calcule et journalise
  le résultat typé ; la finalisation ne le consulte pas avant PR②. Test
  nommé : un projet rouge en PR① finit quand même `completed`, et la ligne
  `verification_runs` porte `red`.
- **Contrat de hash du manifeste** (constat #6 passe 3, **normatif = v6-A**,
  passe 8) : sha-256, versionné (préfixe `v1:`), sur la sérialisation JSON
  canonique UTF-8 (clés triées, pas d'espaces) du manifeste unique
  `{verifierConfig, invariants, canonicalKey, cwd, shellPolicyVersion,
  envAllowlistVersion}` — pour `code_project`, `verifierConfig` = la liste
  ordonnée `verify_commands` entière (v5-A) ; `invariants` = `[]` tant que
  l'owner n'en a pas déclaré (le champ est toujours présent dans le hash).
  Changer une commande, l'ordre, ou un invariant invalide l'approbation
  entière. Il n'existe **qu'un** hash et **qu'une** approbation par cible. Le module de hash est partagé
  runner/web — une seule implémentation.
- **`project_key` canonique partagé** + migration déterministe (ferme Q11).
  État actuel : `code_projects(id, entity_id, project_path, display_name,
  hidden, created_at, updated_at)`, `UNIQUE(entity_id, project_path)`
  (`packages/db/src/schema/code-projects.ts:28-46`, migration 0086) ; la clé
  n'existe qu'en fonction runtime `projectKey()` (`apps/runner/src/job/
  code-projects.ts:122`, casse Windows normalisée). Migration : (1) déplacer
  `projectKey` dans `packages/shared` ; (2) ajouter `project_key` nullable ;
  (3) backfill par l'algorithme partagé ; (4) fusion des doublons sous verrou
  — **règle** : la ligne gagnante est la plus récemment modifiée
  (`updated_at`), départagée par `id` croissant ; elle fournit
  `display_name`, `hidden` et **son `project_path` survit comme chemin
  d'affichage** ; le **manifeste** (liste `verify_commands` complète +
  invariants, comparés canoniquement — plus jamais `verify_command` /
  `verify_timeout_seconds`) ne survit que s'il est **identique sur toutes
  les lignes fusionnées**, avec l'approbation reprise de la ligne au
  `verify_approved_at` le plus ancien ; sinon effacé ⇒ `pending_approval` ;
  (5) `project_key NOT NULL`, `UNIQUE(entity_id, project_key)`, l'ancien
  UNIQUE retiré.
- **Primitive terminale typée** + bascule des quatre écrivains terminaux.
- **Moteur pur** extrait de `runInShell`, testé seul : tree-kill ATTENDU et
  vérifié, quoting Windows testé, env allowlist documentée, pas de secrets
  inline.
- **Tests nommés** : moteur (timeout, tree-kill, caps, quoting) ;
  interleaving intra-job et inter-jobs ; migration de fusion (doublons
  divergents ⇒ pending_approval) ; test d'archi « status='completed' hors
  primitive interdit » ; mutation de chaque garde ⇒ rouge.
- **Écrivains d'intention (D8, déplacés de ②)** : helper partagé + matrice
  des écrivains sur les cinq surfaces ; réglage d'espace des surfaces sous
  vérification (défaut : toutes) ; une surface décochée ⇒ pas d'intention,
  dit tel quel dans le run. Test : chaque surface pose l'intention AVANT la
  mutation (mutation du helper ⇒ rouge) ; surface décochée ⇒ aucune ligne
  d'état, mention visible.
- **UI (D9)** : fiche projet (onglet Code) — commandes de preuve, approbation
  owner avec avertissement, état `pending_approval` ; réglages d'espace —
  surfaces D8 ; détail de run — lecture des `verification_runs`. Aucun état
  de décision affiché (ils n'existent qu'avec la garde, ②).
- **Infra de tests de course** : le dépôt n'a aucun test sur vrai Postgres
  (tous sur PGlite mono-connexion, `packages/db/src/tests/helpers.ts:22`) ;
  ① crée une suite `*.pg.test.ts` sur le Postgres embarqué du dev
  (`apps/cli/src/lib/postgres.ts`), qui **échoue si le harnais est absent**
  — jamais sautée, jamais verte par absence (décision de découpage n°11 ;
  le binaire `embedded-postgres` est atteint par jonction depuis `apps/cli`).
  Livrée : `real-postgres.pg.test.ts`, `finalize-interleaving.pg.test.ts`,
  `outbox-interleaving.pg.test.ts` (T14).
  **Amendement du 04/09, mesuré en CI** : ces suites tournent sur le job
  **Linux** à chaque run (10 tests) et sur une machine Windows ordinaire,
  mais PAS sur le runner `windows-latest` de GitHub — PostgreSQL refuse de
  démarrer sous un compte ADMINISTRATEUR, et c'est sous ce compte que GitHub
  exécute ses jobs Windows (`initdb` passe, `pg_ctl start` rejette : neuf
  essais, neuf ports, aucun log). Elles sont donc exclues de ce seul job, avec
  un message dans son journal (`apps/runner/vitest.config.ts`). La règle
  « jamais verte par absence » reste tenue : la garantie est portée par Linux,
  à chaque push.

## PR② — garde active + `code_task`

- Garde branchée sur la primitive : les états de décision deviennent
  l'issue du job ; libellé « succès non vérifié ».
- Preuve `code_task` sous verrou tenu (fenêtre L442-460), décisionnelle
  (contrat par surface) ; champ `verification` sur `CodeTaskOutput` ⇒ verdict
  dans le tool_result du demandeur.
- `red_streak` par (job, projet) : à 2, `VERIFY_ATTEMPTS_EXHAUSTED` ⇒
  `blocked`.
- **UI de décision** (la configuration est en ①, D9) : états
  `not_configured` / `green` / `red` affichés comme issue ; **le libellé
  « succès non vérifié » de `completed_unverified` est rendu ici** (détail de
  run existant), distinct du succès vérifié.
- **Tests nommés** : un test par écrivain (les cinq surfaces posent
  l'intention AVANT la mutation — prouvé par mutation du helper) ; preuve
  verte pose `verified_generation` ; preuve rouge ⇒ `verification_due` ;
  multi-projets `green + not_configured` ⇒ `completed_unverified` (le test D4) ;
  aucun outil agent ne peut écrire les colonnes verify (archi).

## PR③ — runtime CLI

- Fin de tour restructurée : heartbeat ET verrous tenus pendant preuve →
  réparation → re-preuve, un **unique finally**. Aujourd'hui
  (`run-job.ts:302-332`) le heartbeat démarre l. 302, `binding.run` l. 308,
  et la libération est dupliquée dans le `catch` (l. 326-328) et sur le
  chemin normal (l. 332) — **il n'y a pas de `finally`**, c'est à créer.
- Intention avant `binding.run` (tous projets attachés) ; preuve de CHAQUE
  projet sale ; `red` déterministe ⇒ réparation UNIQUE : `repair_attempts`
  incrémenté AVANT le respawn, refus dès `>= 1` (reprise de process
  comprise), budget re-contrôlé, cap d'outils cumulatif, une ligne `cli_runs`
  par tentative, même session. Re-rouge ⇒ `failJob` typé, finalText optimiste
  NON livré. `timeout`/`spawn_error` ⇒ `infra_error` immédiat, pas de
  réparation.
- Livraison conditionnée au retour `completed`/`completed_unverified` de la
  primitive.
- **Tests nommés** : le finally unique (heartbeat vivant pendant la preuve —
  mutation : le déplacer ⇒ rouge via le reaper simulé) ; multi-projets (rouge
  sur A + vert sur B ⇒ pas de livraison) ; réparation unique (2e rouge ⇒
  failJob, jamais de 2e respawn — y compris après kill/restart du runner) ;
  `infra_error` sans réparation ; non-livraison sur `verification_due`.

## PR④ — protocole de revue

*(Réécrit en v6.1 — passe 8 : le texte v4 gardait le déclencheur par
whitelist, l'incrément par verdict et `content_id`.)*

- **Création par le harnais, jamais par délégation** : les jobs de revue
  sont créés **uniquement** par `requestReview(snapshot_id, policy)` depuis
  la primitive terminale (v6-C) ; chacun naît avec `job_protocol='review'`,
  `snapshot_id`, `review_cycle_id` et l'identité du job demandeur persistés
  à la création. `handleDelegation` (`delegate.ts:78-112`, aujourd'hui un
  seul child, pas de whitelist) gagne une garde : une délégation vers un
  agent porteur de `review_verdict` ⇒ `REVIEW_MUST_GO_THROUGH_HARNESS`. Le
  skill `request-review` appelle `requestReview`. La finalisation lit le
  snapshot du child, jamais une whitelist recalculée.
- **Verdict immuable, premier gagnant, fondé** : persisté fail-closed,
  unicité par job de revue ; second appel valide ⇒
  `REVIEW_VERDICT_ALREADY_RECORDED` ; un job `protocol='review'` ne réussit
  qu'avec exactement cette ligne ; schéma v6-D (`kind`, citation,
  `REVIEW_VERDICT_UNGROUNDED`).
- **Cycles et `review_rounds`** : `review_cycles` (v6-C) ; l'agrégation
  clôt le cycle une fois et incrémente `review_rounds` du job demandeur
  **une fois par cycle exigeant correction** — jamais par verdict. À 2,
  `requestReview` refuse avant toute création — `REVIEW_ROUNDS_EXHAUSTED`,
  escalade humaine. Échec technique d'un relecteur : `REVIEW_INCOMPLETE`,
  cycle non consommé (v6-C).
- **Preuves de lignée** : objet persisté `{verification_run_id, job_id,
  deliverable_type, canonical_key, generation_or_outcome, manifest_hash,
  snapshot_id}`. `requestReview` n'injecte dans chaque job de revue que les
  preuves **courantes** (mutable : verified = dirty et epoch courant ;
  atomique : `confirmed`) rattachées au **même `snapshot_id`**, au moment
  transactionnel de la création.
- **Textes** en dernier : `code-task`, `request-review`, `dev`,
  `verify-before-done`, `code-review`.
- **Tests nommés** : le snapshot du child survit à un changement de skills
  en cours de job ; deux verdicts concurrents ⇒ un seul persisté, l'autre
  `ALREADY_RECORDED` (deux connexions) ; job review sans verdict ne finalise
  pas ; délégation directe vers un relecteur refusée ; 3e cycle refusé avant
  création ; 2 `request_changes` sur 3 ⇒ **un** incrément ; relecteur en
  échec ⇒ `REVIEW_INCOMPLETE` sans incrément ; une preuve d'un snapshot
  antérieur n'est pas injectée ; deux relecteurs de même famille ⇒
  `REVIEW_POOL_SAME_FAMILY`.

## Hors périmètre v1 (explicite)

Chat CLI en écriture (`run-chat.ts`, sans jobId) — lot de suite après PR③.
Détection automatique de commande. UI au-delà du détail de run. Sandbox
nouvelle. Variables d'env owner-managed pour les preuves.

## Décisions — TRANCHÉES par Quentin le 30/08/2026

- **D1 — Consentement : manifeste hashé** (contrat de hash en PR①), durable,
  pas de prompt par exécution.
- **D2 — Réparation runtime CLI : 1 tour auto max** (`repair_attempts`,
  `0 = aucun`, refus dès `>= 1`).
- **D3 — Boucle nodal pure : preuve à la finalisation** ; les surfaces CLI
  gardent leur preuve immédiate décisionnelle (contrat par surface).
- **D4 — Projet muté sans commande : PERMISSIF-HONNÊTE** — résultat terminal
  distinct `completed_unverified`, livraison autorisée, libellé « succès non
  vérifié » rendu en PR②, prédicat par projet. L'avis bloquant de Codex est
  noté et écarté.

## Traçabilité passe 11 → v6.5 (03/09) — boucle sur plan close

| Constat passe 11 | Traitement v6.5 |
|---|---|
| claim NON FERMÉ : lease 60 s ≤ timeout Telegram document (60 s), WhatsApp et Discord sans timeout local — vérifié aux trois ancrages | timeout d'envoi imposé par l'outbox (90 s, `AbortController`/`Promise.race`), lease = 2× = 180 s, invariant par construction ; test « adaptateur muet » |
| neuf bloquant : borne de 3 tentatives absente du claim | `attempts < 3` dans le `WHERE` ; passage à `rejected` + alerte par le tick ; test frontière 3/4 |
| drain immédiat : FERMÉ | — |

**Décision de méthode (03/09)** : la passe 11 était annoncée comme la
dernière sur plan. Les passes 9-11 ont chacune trouvé un défaut dans le
correctif de la précédente, tous dans la même section (l'outbox) et de plus
en plus fins (une clause SQL). C'est le signe que la spécification a atteint
ce qu'un texte peut fixer : la suite se tranche dans PR① avec du code, des
tests d'interleaving réels et la boucle `codex review` sur la PR.

## Traçabilité passe 10 → v6.4 (03/09)

| Constat passe 10 | Traitement v6.4 |
|---|---|
| neuf bloquant : pas de claim atomique sur `job_deliveries` (deux ticks envoient la même ligne) | `UPDATE … WHERE outcome='prepared' OR lease expiré … RETURNING`, `claimed_by`/`claimed_at`, `attempts` incrémenté dans le claim, test à deux connexions |
| neuf bloquant : passage exclusif par le tick = jusqu'à 120 s de latence interactive (vérifié : `ticker.ts:30`, `run-job.ts:400-419` envoie aujourd'hui immédiatement) | `drainDeliveries(jobId)` appelé juste après tout commit terminal ; le tick ne fait que reprendre ; test « livré sans attendre le tick » |
| bloquant passe 9 et résidu : FERMÉ | — |

## Traçabilité passe 9 → v6.3 (03/09)

| Constat passe 9 | Traitement v6.3 |
|---|---|
| neuf bloquant : `completedAt` écrit avant la livraison, garde qui exclut le root à jamais — **vérifié dans le code actuel** (`deliver-results.ts:196-211` puis l. 245+, aucune colonne de livraison) | outbox `job_deliveries` sur le modèle atomique (`prepared` dans la transaction terminale, `attempted`, `confirmed` avec reçu, `rejected`), tick à deux populations, clé d'idempotence, 3 tentatives, alerte owner ; livraison directe retirée des autres chemins ; 3 tests nommés |
| résidu : paragraphe « passe 2 → v3 » cite prédicat par projet, `content_id`, manifeste 5 champs | marqué historique, les trois remplacements nommés |
| Q1, Q3, Q5, Q7, Q10, hash : FERMÉ | — |

## Traçabilité passe 8 → v6.2 (03/09)

| Constat passe 8 | Traitement v6.2 |
|---|---|
| neuf bloquant : deux contrats de hash (PR① cinq champs vs v6-A manifeste unique) | PR① réécrit : le manifeste unique est normatif, `invariants` toujours présent (`[]` par défaut), un hash, une approbation |
| Q1 partiel : écrivains de `attempted`/`confirmed` non désignés | § écrivains et moments : tool (`prepared`, `attempted`), constat (`confirmed`, `rejected`), finalisation seule (`outcome_unknown`), reaper ne touche ni ne rejoue |
| Q3 partiel : `review_pending` absent de l'union ; reprise du cron non spécifiée | union étendue ; contrat de reprise idempotente du cron (marqueur, cycle unique, tick qui ignore un cycle ouvert, test à deux ticks) |
| Q5 / Q10 partiels : PR④ gardait whitelist, incrément par verdict, `content_id` | PR④ réécrite sur `requestReview`, `review_cycles`, `snapshot_id` |
| Q7 partiel | idem neuf bloquant |
| cohérence 5 : primitive formulée « par projet » | prédicats réglé / non vérifiable / dû définis par livrable, mutable et atomique |

## Traçabilité passe 7 → v6.1 (03/09)

| # | Constat Codex (vérifié à la source) | Traitement v6.1 |
|---|---|---|
| Q1 | modèle dirty/verified inadapté aux actions atomiques | deux modèles d'état ; `outcome` `prepared → attempted → confirmed \| rejected \| outcome_unknown`, clé d'idempotence avant l'appel, projection terminale (v6-A) |
| Q2 | pas d'identité canonique hors code | `(job_id, deliverable_type, canonical_key)`, canonicaliseur par type, PR① = `code_project` seul, types réservés sans clé provisoire (v6-A) |
| Q3 | deux déclencheurs de revue coexistent | un flux : étape de la primitive terminale, `requestReview`, délégation directe refusée (v6-C) |
| Q4 | pas de snapshot hors git | `deliverable_snapshots`, digest par type, blob copié, `snapshot_id` remplace `content_id` (v6-C) |
| Q5 | `review_rounds` ambigu avec N relecteurs | `review_cycles`, un incrément par cycle (v6-C) |
| Q6 | échec d'un relecteur non traité | fail-closed, une relance, `REVIEW_INCOMPLETE`, jamais un cycle consommé (v6-C) |
| Q7 | manifeste commandes vs invariants ambigu | manifeste unique, une approbation atomique (v6-A) |
| Q8 | TIENT | — |
| Q9 | famille de modèle absente du catalogue | `modelFamily` obligatoire pour les relecteurs, refus fail-closed (v6-C) |
| Q10 | `delegate.ts` présenté comme calcul existant ; `task-ledger`/`STATE_CHANGING_TOOLS` ne tracent pas les lectures ; `review_verdict` = `blocker` sans `kind`/citation ; `run-job.ts` sans `finally` | corrigés là où ils sont cités ; registre `deliverable_reads` ; `blocker` gardé, citation générique (v6-A, v6-D, PR③) |
| Q11 | migration cite `verify_command`/`verify_timeout_seconds`, `project_path` survivant non défini | migration réécrite en 5 étapes sur le schéma réel (PR①) |
| — | précision Quentin : un tour de chat n'est pas une tâche | section « Périmètre » (v6-A) |

## Traçabilité lectures 03/09 → v6

| Lecture | v5 | v6 |
|---|---|---|
| Relational conformance (2607.14155) | état par projet, vérificateur = commande | état par livrable, vérificateurs pluggables, invariants déclarés et recalculés indépendamment (v6-A) |
| All Smoke, No Alarm (2606.18168) | « tests verts » = prouvé | contrôle d'oracle sur les tests ajoutés (v6-B) |
| Multi-agent verification (2511.16708) + PoLL (2404.18796) | 1 relecteur | 0-3 relecteurs, rôles et familles différents, pool en base (v6-C) |
| More Rounds, More Noise (2603.16244) | boucle codeur↔relecteur bornée à 2 | parallèle, single-pass, contextes séparés ; une correction = revue fraîche (v6-C) |
| Adversarial Review (2608.18167) | verdict structuré | verdict fondé : citation obligatoire, evidence vs concern (v6-D) |
| LLM-as-a-judge (biais, calibration) | — | familles distinctes exigées, calibration en v2 (v6-C) |

## Traçabilité best practices → v5

| Pratique (source) | v4 | v5 |
|---|---|---|
| Capteurs gradués, fail fast (Osmani, Faros, *Code as Agent Harness*) | une commande | liste ordonnée, arrêt au premier rouge (v5-A) |
| Feedback lisible par l'agent (dsh leçon 3, Faros) | stockage borné seulement | extrait borné + chemin du log, un module, cas nommés (v5-B) |
| Shadow mode / mesurer avant d'imposer (Anthropic, Datadog) | garde activée en ② sans données | observation ①→② sur vrais jobs, seuils calés dessus (v5-C) |
| Condition d'arrêt testable (loop engineering) | ✓ vert/rouge, bornes ×1/×2 | inchangé |
| Preuve par la machine, verdict = fait (PuppyOne, inv. #2) | ✓ | inchangé |
| Invariants explicites avant le code (Datadog) | hors périmètre — côté utilisateur | inchangé, dit tel quel |
| Read-before-write (dsh leçon 2, PuppyOne) | hors plan | hors plan, **lot suivant** dans le suivi |

## Traçabilité passe 3 → v4

| # passe 3 | Traitement v4 |
|---|---|
| 1 D4 vs primitive (bloquant) | résultat `completed_unverified` dans l'union, livraison autorisée, prédicat green∨not_configured par projet, libellé + test D4 en PR② |
| 2 epoch non sérialisé inter-jobs (bloquant) | verrous `code_projects` FOR UPDATE en ordre déterministe pour intention ET finalisation ; test inter-jobs à deux connexions |
| 3 D3 vs preuve immédiate | contrat « quand la preuve tourne » par surface — la preuve immédiate est décisionnelle, la règle de finalisation est unique |
| 4 compteur vs D2 | `repair_attempts` (harnais, max 1, incrément pré-respawn, survit au restart) séparé de `red_streak` (à 2 ⇒ exhausted) |
| 5 tests PR②-④ absents | cas d'acceptation nommés dans chaque PR |
| 6 fusion et hash sous-spécifiés | règle de fusion complète (updated_at, approbation ssi identité parfaite) ; hash sha-256 versionné `v1:` sur JSON canonique UTF-8, module partagé |
| 7 état éditorial périmé | en-tête et suivi mis à jour, v4 candidate |

## Traçabilité passe 2 → v3 (historique — vocabulaire de l'époque)

*Liste des acquis de la v3, gardée pour l'histoire des passes. Trois termes
ont été **remplacés depuis** et ne sont plus normatifs : « prédicat par
projet » → prédicats par livrable (v6.2), « `content_id` » → `snapshot_id`
(v6.1), « manifeste 5 champs » → manifeste unique à six champs dont
`invariants` (v6.2).*

Intention pré-mutation fail-closed · protocole transactionnel · matrice des
écrivains + test d'archi · table d'état spécifiée · prédicat par projet ·
primitive unique typée (cron compris) · union typée · compteurs dans l'état
décisionnel · verdict premier-gagnant · snapshot `job_protocol` · lignée
structurée + `content_id` · migration projectKey · epoch global · manifeste
5 champs · découpage ①→④.

## Vérifications qui ont corrigé le plan (cumulé)

Passe 1 : sens de delegate/resume, checkpoint ≠ mutation, D1 naïf, fail-open,
heartbeat, caps de respawn, protocole de revue contournable, slug en dur,
projectPath non canonique, chat CLI oublié. Passe 2 : table v3. Passe 3 :
table ci-dessus. Chaque constat re-vérifié à la source avant intégration.
