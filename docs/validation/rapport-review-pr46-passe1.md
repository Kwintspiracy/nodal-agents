# Rapport de relecture — PR #46

Relecture statique de `main...HEAD`. Aucun fichier modifié. Les constats marqués **VÉRIFIÉ** viennent directement du code ; ceux marqués **DÉDUIT** décrivent une interleaving ou un comportement non exécuté.

## Constats

### P0 — Des outils Office écrivent sans intention de mutation

**Fichiers :**

- `packages/tools/src/execute.ts:414`
- `packages/tools/src/builtin/office-ops/index.ts:59`
- `packages/tools/src/builtin/office-ops/docx.ts:361`
- `packages/tools/src/builtin/office-ops/pptx.ts:374`
- `packages/tools/src/builtin/office-ops/xlsx.ts:339`
- `packages/tools/src/builtin/office-ops/office-helpers.ts:307`
- `packages/tools/src/tests/intent-wiring.test.ts:41`

**Verdict : FAUX — VÉRIFIÉ par lecture.**

Le seam d’intention ne s’exécute que lorsque `tool.mutatesWorkspace` vaut explicitement `true`. Les outils Office enregistrés dans `OFFICE_TOOLS` créent ou modifient pourtant des fichiers via l’écriture atomique de `office-helpers.ts`, sans porter ce marqueur.

Le test censé énumérer « tous les outils mutants » fait lui-même :

```ts
registry.list().filter((t) => t.mutatesWorkspace === true)
```

Il ne peut donc pas découvrir un outil mutant auquel le marqueur manque.

**Ce qui casse concrètement :** un job peut modifier un DOCX, PPTX ou XLSX dans un projet sans incrémenter `verification_epoch` ni `dirty_generation`. La finalisation peut alors conserver ou produire un état vert qui ne couvre pas cette modification. Le test `intent-wiring` reste vert si ces outils continuent de contourner le seam.

Le même modèle ne permet pas de garantir les mutations éventuelles d’un outil MCP : sans métadonnée déclarant la mutation du workspace, `executeTool` ne pose aucune intention.

---

### P0 — L’outbox peut envoyer deux fois la même livraison

**Fichiers :**

- `apps/runner/src/delivery/outbox.ts:259`
- `apps/runner/src/delivery/outbox.ts:273`
- `apps/runner/src/delivery/outbox.ts:284`
- `apps/runner/src/delivery/outbox.ts:290`
- `apps/runner/src/delivery/outbox.ts:374`
- `apps/runner/src/delivery/outbox.ts:379`
- `apps/runner/src/delivery/outbox.ts:414`

**Verdict : FAUX — VÉRIFIÉ pour le câblage, DÉDUIT pour l’interleaving.**

`now` est calculé une seule fois au début du drain puis réutilisé comme `claimed_at` pour toutes les lignes, alors que les envois sont séquentiels et sans `LIMIT`. Si les livraisons précédentes consomment une partie importante du bail, une ligne réclamée tardivement reçoit néanmoins un `claimed_at` ancien. Un autre runner peut alors la considérer périmée pendant son envoi et la réclamer à nouveau.

Deuxième cas : `sendWithTimeout` ne peut pas annuler l’adaptateur. Après le timeout, le premier envoi continue. Une reprise est autorisée après le bail et peut partir pendant que le premier envoi finit tardivement. La clé `idempotency_key` est stockée en base mais n’est jamais transmise à `sendText`.

Enfin, la confirmation finale fait seulement :

```ts
.where(eq(jobDeliveries.id, row.id))
```

Elle ne vérifie ni `outcome='attempted'`, ni `claimed_by`, ni le numéro de tentative. Une ancienne tentative peut donc confirmer une ligne déjà reprise par un autre runner.

**Ce qui casse concrètement :** Telegram et les autres canaux sans idempotence native peuvent recevoir deux messages identiques. Le claim atomique empêche deux claims frais simultanés, mais ne fournit pas la garantie générale « jamais deux envois » affirmée dans les commentaires.

Le test `apps/runner/src/tests/delivery/outbox.test.ts:435` ne couvre que deux drains concurrents sur une ligne fraîche ; il resterait vert avec les courses ci-dessus.

---

### P1 — L’alerte de rejet est du texte utilisateur écrit par le runner

**Fichiers :**

- `apps/runner/src/delivery/outbox.ts:531`
- `apps/runner/src/delivery/outbox.ts:532`
- `apps/runner/src/delivery/outbox.ts:570`
- `apps/runner/src/delivery/outbox.ts:571`
- `packages/test-kit/src/architecture.ts:110`

**Verdict : FAUX — VÉRIFIÉ par lecture.**

Le runner construit directement :

```text
DELIVERY_REJECTED job=… delivery=… channel=… attempts=… reason=…
```

puis l’envoie au propriétaire avec `adapter.sendText`. Le fait que ce soit un code et des données ne change pas sa destination : c’est bien un message utilisateur codé en dur par le runner, alors que l’invariant impose « LLM speaks or runner stays silent ».

Le scanner ne recherche que quelques expressions comme `Sorry`, `Désolé` ou `Voici votre résultat`. Il ne peut pas détecter cette classe générale de messages envoyés directement.

**Ce qui casse concrètement :** l’utilisateur reçoit une ligne technique interne, avec identifiants de job et de livraison, à la place d’un message produit par l’agent. L’invariant d’architecture #2 est contourné tout en laissant les tests verts.

---

### P1 — Les règles d’architecture sont trivialement contournables

**Fichiers :**

- `packages/test-kit/src/architecture.ts:364`
- `packages/test-kit/src/architecture.ts:375`
- `packages/test-kit/src/architecture.ts:389`
- `apps/runner/src/tests/architecture.test.ts:83`
- `apps/runner/src/tests/architecture.test.ts:91`

**Verdict : FAUX — VÉRIFIÉ par lecture.**

Quelques contournements directs :

- L’écriture terminale n’est reconnue que sous la forme littérale `.update(agentJobs)`, dans une fenêtre de 400 caractères, suivie de quelques formes de `status`.
- Un alias de `agentJobs`, une clé calculée, plus de 400 caractères ou un helper intermédiaire échappent au scanner.
- Les envois ne sont détectés que par quatre motifs littéraux ; une méthode déstructurée ou un wrapper échappe au contrôle.
- `skipFiles` exempte des fichiers entiers, notamment `job/state.ts` et six expéditeurs. Toute nouvelle écriture terminale ou livraison ajoutée dans l’un de ces fichiers est invisible.

**Ce qui casse concrètement :** les tests peuvent rester verts après réintroduction d’un chemin terminal ou d’un envoi direct hors primitive. Ils constituent un garde-fou lexical, pas une preuve de l’invariant annoncé.

---

### P1 — La séquence de finalisation protège bien l’état vert courant

**Fichiers :**

- `apps/runner/src/job/finalize.ts:307`
- `apps/runner/src/job/finalize.ts:333`
- `apps/runner/src/job/finalize.ts:352`
- `apps/runner/src/job/finalize.ts:365`
- `apps/runner/src/job/finalize.ts:384`
- `apps/runner/src/job/finalize.ts:430`
- `apps/runner/src/job/finalize.ts:454`
- `apps/runner/src/job/finalize.ts:478`

**Verdict : TIENT — VÉRIFIÉ par lecture, interleavings DÉDUITS.**

La transaction 1 verrouille le job, réclame `finalizing_at`, capture la génération et charge la configuration. La transaction 2 :

- reverrouille le job ;
- relit la configuration sous verrou ;
- invalide le résultat si l’epoch ou le manifeste ont changé ;
- conditionne l’écriture d’état à `dirty_generation = G` ;
- finalise ensuite le job dans la même transaction.

Une écriture du même job fait échouer la garde de génération ; une écriture d’un autre job fait bouger l’epoch du projet. Dans les deux cas l’état effectif reste `dirty`, pas `green`.

La reprise d’un claim actif après dix minutes peut lancer une deuxième preuve si la première est seulement lente, mais une seule transaction terminale gagne et les gardes empêchent la publication d’un vert périmé. Cela gaspille potentiellement une preuve sans créer, à lui seul, un faux vert.

---

### P1 — Les actions web ajoutées sont correctement bornées à l’espace

**Fichiers :**

- `apps/web/src/lib/actions.ts:12782`
- `apps/web/src/lib/actions.ts:12923`
- `apps/web/src/lib/actions.ts:12957`
- `apps/web/src/lib/actions.ts:12971`
- `apps/web/src/lib/actions.ts:12978`
- `apps/web/src/lib/actions.ts:12097`
- `apps/web/src/lib/actions.ts:12113`
- `apps/web/src/lib/actions.ts:12289`

**Verdict : TIENT — VÉRIFIÉ par lecture.**

Les écritures de commandes et d’approbation passent par `assertProjectOwner`. La ligne approuvée est recherchée par `(session.entityId, projectKey)`. Le hash est recalculé côté serveur et comparé au jeton fourni.

Les lectures de détail commencent par charger le job avec `agentJobs.entityId = session.entityId`, construisent ensuite elles-mêmes `allRelevantIds`, puis bornent les lectures de `verification_runs` par l’entité et ces identifiants. Le client ne fournit donc pas directement `pipelineJobIds`.

La fenêtre entre la lecture du manifeste et l’UPSERT d’approbation n’approuve pas silencieusement un nouveau manifeste : une écriture concurrente produit soit un hash approuvé ancien face aux nouvelles commandes, donc `pending_approval`, soit efface l’approbation.

---

### P2 — Le drain global peut monopoliser un tick pendant une durée non bornée globalement

**Fichiers :**

- `apps/runner/src/delivery/outbox.ts:277`
- `apps/runner/src/delivery/outbox.ts:284`
- `apps/runner/src/delivery/outbox.ts:374`
- `apps/runner/src/cron/tick.ts:351`
- `apps/runner/src/cron/tick.ts:354`

**Verdict : FAUX — VÉRIFIÉ par lecture, impact DÉDUIT.**

Le drain sélectionne toutes les livraisons ouvertes, sans `LIMIT`, puis les envoie séquentiellement avec un timeout pouvant atteindre 240 secondes chacune.

**Ce qui casse concrètement :** un backlog de dix adaptateurs bloqués peut retenir la phase pendant environ quarante minutes. Cela retarde les phases suivantes du tick et amplifie le défaut de datation du claim décrit plus haut.

---

### P2 — La migration 0088 respecte la règle de fusion spécifiée

**Fichiers :**

- `packages/db/migrations/0088_code_projects_project_key.sql:46`
- `packages/db/migrations/0088_code_projects_project_key.sql:77`
- `packages/db/migrations/0088_code_projects_project_key.sql:87`
- `packages/db/migrations/0088_code_projects_project_key.sql:97`
- `packages/db/migrations/0088_code_projects_project_key.sql:112`
- `packages/db/migrations/0088_code_projects_project_key.sql:132`

**Verdict : TIENT — VÉRIFIÉ par lecture.**

Le backfill correspond à la normalisation partagée pour Windows/UNC, la gagnante est déterminée par `updated_at DESC, id ASC`, et les préférences `display_name`, `hidden` et `project_path` viennent conformément au plan de cette gagnante. Les approbations divergentes sont effacées ; les approbations identiques sont reprises depuis la plus ancienne.

La recherche de l’ancienne contrainte vérifie son type, sa table et exactement les colonnes `entity_id/project_path`, puis échappe son nom avec `%I`. Sur la base 0086 attendue, le DROP est sûr.

## Classement final

### P0

1. Les outils Office mutants contournent entièrement l’intention de mutation.
2. L’outbox peut doubler un envoi après expiration du bail ou timeout ambigu.

### P1

1. L’alerte `DELIVERY_REJECTED` viole l’interdiction de texte utilisateur codé en dur dans le runner.
2. Les règles d’architecture sont des motifs lexicaux facilement contournables et leurs `skipFiles` exemptent des fichiers entiers.
3. La primitive terminale et le cloisonnement web tiennent sur les scénarios examinés.

### P2

1. Le drain sans limite peut bloquer un tick proportionnellement à tout le backlog.
2. La migration 0088 respecte la règle de fusion demandée.

**Synthèse : la PR ne tient pas en l’état, principalement parce que certaines écritures réelles échappent encore à l’intention et que l’outbox n’offre pas la garantie d’absence de doublon qu’elle affirme.**