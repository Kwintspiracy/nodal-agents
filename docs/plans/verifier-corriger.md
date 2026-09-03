<!-- artifact: https://claude.ai/code/artifact/8744ad8c-e7ec-455a-8ae7-4ca25d826ede -->

# Vérifier & Corriger — la preuve entre dans la boucle

Plan v6.5 du 03/09/2026 — **BOUCLE DE RELECTURE SUR PLAN CLOSE (11 passes
Codex), prêt au découpage de PR①** — **REMIS EN TÊTE DE FILE par Quentin le
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
| ① | Fondations fermées | Schéma exact — état par **(job, livrable)** et non (job, projet) (v6-A) ; **vérificateurs pluggables**, le code (liste ordonnée de commandes, v5-A) en est le premier ; `projectKey` unique + migration ; primitive terminale typée (cron compris) ; **outbox de livraison `job_deliveries`** (v6.3 — ferme un bug existant, donc en ①) ; moteur pur testé ; tests de course DB. **Aucune UI active, aucune garde active** : la preuve tourne et se journalise — c'est la phase d'observation (v5-C). | ⬜ prête au découpage après la passe 0 |
| ①→② | Observation | Une semaine de vrais jobs sur la stack de Quentin, preuve journalisée sans bloquer : taux de rouge, faux rouges (commande mal configurée), durée des preuves. Les seuils de ② se calent sur ces chiffres. | ⬜ |
| ② | Surfaces Nodal + `code_task` | Écrivains dirty (5 surfaces), preuve code_task sous verrou, compteurs persistants, **extrait de feedback borné** (v5-B), **contrôle d'oracle sur les tests écrits par l'agent** (v6-B). **UI activée ici, garde activée ici.** | ⬜ |
| ③ | Runtime CLI | Finally unique (heartbeat + verrous), multi-projets, réparation unique, livraison conditionnée au résultat typé. | ⬜ |
| ④ | Protocole revue à N relecteurs | Snapshot `job_protocol='review'`, verdict immuable **et fondé** (chaque constat cite sa preuve, v6-D), `review_rounds`, preuves de lignée ; **pool de relecteurs et politique par type de tâche (0-3) en base, lancés par le harnais en parallèle, un seul passage chacun** (v6-C) ; textes de skills. | ⬜ |
| ⑤ | Vérificateurs de livrables non-code | Fichiers Office (s'ouvre, recalcule, **invariants déclarés** tiennent) ; **relecture après écriture** sur les connecteurs (le message existe, l'événement est là) ; ancrage des affirmations aux sources ouvertes. Un vérificateur par lot, sur la tuyauterie de ①. (v6-A) | ⬜ après ④ |
| suite | Écritures périmées | Read-before-write typé (`FS_NOT_OBSERVED` / `FS_STALE_VERSION`) sur les outils fichiers — même famille (« corriger » sans s'écraser), hors de ce plan, juste après lui | ⬜ backlog harnais n°1 |

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
- **Aucune UI active.**

## PR② — surfaces Nodal + `code_task` (+ UI)

- Écrivains dirty branchés sur les cinq surfaces.
- Preuve `code_task` sous verrou tenu (fenêtre L442-460), décisionnelle
  (contrat par surface) ; champ `verification` sur `CodeTaskOutput` ⇒ verdict
  dans le tool_result du demandeur.
- `red_streak` par (job, projet) : à 2, `VERIFY_ATTEMPTS_EXHAUSTED` ⇒
  `blocked`.
- **UI activée** : champ commande + geste d'approbation owner (avertissement :
  la commande exécute du code du dépôt) ; états `not_configured` /
  `pending_approval` affichés ; **le libellé « succès non vérifié » de
  `completed_unverified` est rendu ici** (détail de run existant), distinct du
  succès vérifié.
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
