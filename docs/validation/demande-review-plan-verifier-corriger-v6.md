# Demande de review — PLAN « Vérifier & Corriger » v6 (pas de PR)

Objet : `docs/plans/verifier-corriger.md`, version v6 du 03/09/2026. C'est un
plan AVANT tout code : rien de ce qu'il décrit n'existe dans le dépôt. Les
passes 1-6 (30/08) ont validé la v4. La v5 et la v6 ajoutent des sections
sans réécrire le reste. Cette passe 7 relit l'ensemble.

Sandbox : lecture seule. Le dépôt est sur la branche `feat/recettes-agents`
(PR #45, sans rapport avec ce plan) — les ancrages du plan visent `main`, qui
est quasi identique pour les fichiers concernés.

## Ce que le plan affirme

1. La v4 reste vraie : table d'état par (job, cible), intention de mutation
   écrite AVANT d'écrire, protocole transactionnel `FOR UPDATE` en ordre
   déterministe, primitive terminale typée unique (le cron compris), protocole
   de revue avec snapshot `job_protocol='review'`.
2. v5-A : `verify_command` devient `verify_commands` (liste ordonnée 1-5,
   arrêt au premier rouge), une ligne `verification_runs` par commande.
3. v5-B : un module unique produit l'extrait réinjecté à l'agent.
4. v5-C : PR① journalise sans que la finalisation lise le résultat.
5. v6-A : l'état de décision passe de (job, projet) à (job, LIVRABLE) avec un
   type et un vérificateur par type ; invariants déclarés dans un manifeste
   hashé/approuvé ; recalcul indépendant.
6. v6-B : contrôle syntaxique d'oracle sur les tests ajoutés par l'agent.
7. v6-C : pool de relecteurs = agents relecteurs ; politique par type de
   livrable (0-3) ; familles de modèle distinctes exigées ; le HARNAIS crée N
   jobs de revue en parallèle sur un snapshot gelé, un passage chacun ; une
   correction = N revues fraîches ; `review_rounds` compte ces cycles.
8. v6-D : `review_verdict` exige severity/kind/citation par constat.
9. Décisions D1-D7 : TRANCHÉES par le propriétaire, hors débat.

## Questions, par priorité

### P0 — ce qui bloquerait le découpage de PR①

- **Q1. Le modèle dirty/verified s'applique-t-il à tous les types de
  livrable ?** Pour `code_project` et `office_file`, une écriture précède la
  preuve : le modèle tient. Pour `outbound_action` (envoyer un message, créer
  un événement), l'action est atomique et irréversible : il n'y a pas de
  « sale puis prouvé », il y a « tenté puis constaté ». Le plan dit-il
  comment l'état (job, livrable) représente ce cas, ou force-t-il un modèle
  inadapté ? Si inadapté, dire précisément quel champ/quelle transition casse.
- **Q2. Identité canonique d'un livrable non-code.** `projectKey` est défini
  pour le code. Le plan ne définit PAS la clé canonique d'un `office_file`
  (chemin ? sous quel workspace ?), d'une `outbound_action` (id de message ?
  connecteur+id ?), d'un `document`. Sans clé, l'UNIQUE (job, livrable) et les
  verrous `FOR UPDATE` en ordre déterministe n'ont pas de sens. Constat
  attendu : quelles clés manquent, et si PR① peut se limiter à `code_project`
  sans peindre dans un coin le schéma pour les autres types.
- **Q3. Qui déclenche la revue, et quand ?** Dans la v4 (PR④), la revue est
  une DÉLÉGATION décidée par l'orchestrateur (`handleDelegation` calcule la
  whitelist, snapshot si elle contient `review_verdict`). Dans la v6-C, c'est
  LE HARNAIS qui crée N jobs de revue d'après la politique d'espace. Ces deux
  descriptions coexistent dans le plan. Sont-elles compatibles (la délégation
  LLM reste possible ET le harnais impose N à la finalisation ?) ou
  contradictoires ? Où, dans la primitive terminale, la revue s'insère-t-elle
  par rapport à la preuve ? Le plan doit dire UN flux.
- **Q4. `content_id` et « snapshot gelé » pour un livrable sans git.** La v4
  définit `content_id` = git HEAD + hash du diff sale. Pour un `office_file`
  ou un `document` hors dépôt, qu'est-ce qui est gelé, et comment N relecteurs
  reçoivent-ils le même octet ? Le plan est-il muet ?

### P1 — incohérences internes v4 ↔ v5/v6

- **Q5. `review_rounds`.** v4 : incrémenté depuis un verdict `request_changes`
  persisté, refus de la 3e délégation. v6-C : compte des « cycles correction →
  N revues fraîches ». Avec N relecteurs, un cycle = N verdicts. Le plan
  dit-il clairement ce qui incrémente (un cycle, pas un verdict) et ce qui
  arrive si 2 relecteurs sur 3 demandent des changements ?
- **Q6. D5 et l'échec d'un relecteur.** « Approuver exige que tous les
  relecteurs requis aient rendu ». Si un job de revue échoue (budget épuisé,
  provider en panne, timeout), le livrable est-il bloqué (fail-closed),
  « non relu », ou en attente ? Le plan ne le dit pas — le dire comme trou.
- **Q7. `verify_commands` et le manifeste.** Le hash couvre `{commands,
  projectKey, cwd, shellPolicyVersion, envAllowlistVersion}`. Avec les
  invariants déclarés (v6-A) hashés « comme les commandes » : même manifeste
  ou manifeste séparé ? Une seule approbation ou deux ? Le plan est ambigu.
- **Q8. v5-C vs primitive typée.** En PR①, « la primitive calcule et
  journalise le résultat typé mais la finalisation ne le lit pas ». Or la v4
  dit « toutes les transitions terminales succès passent par la primitive »
  et « la livraison est interdite hors completed/completed_unverified ». En
  PR①, la primitive retourne-t-elle toujours `completed` (mensonge typé) ou
  un résultat que la finalisation IGNORE (garde débranchée par un flag) ?
  Lequel des deux, et le test nommé le prouve-t-il ?
- **Q9. Familles de modèle.** « Familles distinctes exigées, le harnais refuse
  `REVIEW_POOL_SAME_FAMILY` ». Le catalogue (`packages/catalog`) expose-t-il
  une notion de famille/vendor indépendante du provider (un Claude via
  OpenRouter et un Claude via Anthropic sont la même famille) ? Si non, le
  plan doit nommer le champ à ajouter.

### P2 — ancrages dans le code

- **Q10.** Vérifier que les ancrages cités tiennent encore : `execute.ts:2919`
  (chemin sans tool call), `run-job.ts:400` et `302-332`, `deliver-results.ts`
  (écriture directe de `status`), `delegate.ts:78-110`, `runInShell` non
  exporté (`packages/tools/src/builtin/run-command.ts:141`), `review_verdict`
  (où est-il défini, quel schéma aujourd'hui), `task-ledger.ts` et
  `STATE_CHANGING_TOOLS` (thread-history.ts) que v6-A cite pour l'ancrage des
  sources. Donner fichier:ligne réel pour chaque ancrage faux.
- **Q11.** `code_projects` : le plan suppose une table avec `projectKey`. Elle
  existe ? Sous quel nom, quelles colonnes ? La migration de fusion décrite
  est-elle cohérente avec les contraintes actuelles ?

## Ce dont je doute moi-même

- Q1 et Q3 sont mes deux vrais doutes : j'ai étendu un modèle conçu pour des
  FICHIERS à des ACTIONS, et j'ai ajouté un déclencheur harnais à côté d'un
  déclencheur LLM sans dire lequel gagne.
- Q9 : j'affirme « familles distinctes » sans avoir vérifié que la donnée
  existe.
- v6-A `outbound_action` : je n'ai PAS inventorié quels connecteurs ont une
  lecture symétrique à leur écriture ; le plan le dit, mais un constat chiffré
  (combien sur combien, lesquels) serait utile — si le temps le permet.

## Hors périmètre

- Rediscuter D1-D7.
- Le style, le nommage, la longueur du plan.
- Le contenu des six papiers cités (leurs chiffres sont pris tels quels).
- Toute suggestion d'ajouter des fonctionnalités.

## Ce qui n'est PAS attendu

« Ça a l'air cohérent », « conforme aux bonnes pratiques », « je confirme ».
Deux verdicts valent par question : le constat tient / le constat est faux —
avec fichier:ligne quand le code est en cause, et la phrase exacte du plan
quand le plan est en cause.

## Format du rapport

Une section par question Q1-Q11, dans l'ordre. Pour chaque : verdict
(TIENT / FAUX / TROU), preuve (citation du plan ou fichier:ligne), et si TROU
ou FAUX : la spécification minimale qui le fermerait — sans coder. Terminer
par la liste des constats BLOQUANTS pour PR①, numérotés.
