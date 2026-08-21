# Plan — combler les tests manquants

Établi le 2026-08-10 à partir de `pnpm inventory` (441 capacités recensées) et de la
carte de confiance à trois paliers.

**Le principe de tri.** Les lots ne sont PAS ordonnés par gravité d'audit ni par nombre
de trous. Ils suivent une seule question : *si ça casse, est-ce qu'une machine le dit,
ou est-ce que Quentin le découvre en s'en servant ?* Un trou dans une zone déjà surveillée
coûte moins qu'un trou dans une zone muette, même si le second paraît anodin.

Chaque lot indique ce qu'il rend **modifiable sereinement** — c'est la vraie sortie, pas
le pourcentage.

---

## Lot 1 — Les 39 actions serveur

**Pourquoi en premier.** Ce sont elles qui écrivent en base, et c'est la seule surface
où une régression est à la fois silencieuse et destructrice. Le précédent est net :
`setAgentApprovalRuleAction` supprimait la règle au lieu de l'écrire, en annonçant un
succès. Aucun test ne l'a vu ; l'utilisateur l'a découvert après douze approbations
inutiles.

**Ce qu'il faut écrire.** Le motif existe déjà, éprouvé, dans
`apps/web/src/lib/__tests__/approval-rule-scope.test.ts` : DB de test réelle,
`vi.mock` de `@/lib/server.ts`, assertions sur les **lignes** produites.

Un test par action, avec au minimum :

- la ligne écrite est celle attendue (pas « l'action a renvoyé ok ») ;
- l'idempotence : deux appels laissent UNE ligne, pas deux divergentes ;
- la garde de propriété : une entité ne peut pas toucher les lignes d'une autre.

Le troisième point mérite une insistance particulière : `resolveApprovalAction` porte
une garde IDOR explicite, et rien ne vérifie qu'elle tient.

**Effort.** ~1,5 jour. Mécanique, pas difficile — mais volumineux.

**Rend modifiable sereinement.** Toute l'interface. C'est aujourd'hui la zone où je
conseillerais à quiconque de ne rien changer sans vérifier à la main.

---

## Lot 2 — Faire passer Playwright en CI

**Pourquoi.** 85 tests existent et n'ont jamais été verts sur une machine qui n'est pas
celle de leur auteur. Le job a été ajouté le 9 août et a échoué à son premier passage
(`spawn ENOENT` : il appelait un binaire installé globalement). Corrigé, jamais revalidé.

**Ce qu'il faut faire.**

1. Faire passer les trois parcours actuels (`smoke`, `agent-flows`, `autonomy-approvals`).
2. Une fois verts sur plusieurs jours d'affilée, retirer `continue-on-error`.
3. Alors seulement, élargir aux 28 autres specs — par lots, jamais d'un coup.

**Ne pas rendre le job bloquant avant qu'il ait été vert.** Un job requis qui flake est
désactivé dans la semaine, et on perd les 85 tests au lieu d'en gagner 85.

**Effort.** ~0,5 jour pour les trois parcours, puis de la patience.

**Rend modifiable sereinement.** Les 22 pages du dashboard.

---

## Lot 3 — Les 16 skills du catalogue

**Pourquoi.** Ce sont des données, pas du code — d'où l'absence de tests. Mais elles
partent chez **tous les agents de toutes les installations**, et c'est là qu'a été trouvé
`"agentSlug": "displacer"`, le nom d'un agent personnel, dans un exemple.

**Ce qu'il faut écrire.** Pas un test par skill : un test STRUCTUREL sur le lot, comme
`packages/tools/src/tests/skill-write-paths.test.ts`. Pour chaque skill du catalogue :

- elle passe `lintSkillContent` (les outils MCP qu'elle cite existent) ;
- elle ne contient aucun slug d'agent ni UUID (déjà couvert par les invariants, à
  confirmer explicitement pour ce répertoire) ;
- ses blocs de code JSON parsent.

**Effort.** ~0,5 jour.

**Rend modifiable sereinement.** L'édition des skills livrées.

---

## Lot 4 — Les canaux autres que Telegram

**Pourquoi.** Discord, Slack et WhatsApp ont du code et des tests unitaires, mais
**aucune preuve en vrai**. Telegram a été éprouvé une fois : approbation livrée et
résolue en 45 secondes, `resolved_by = telegram` en base. Les trois autres n'ont jamais
livré un message à un humain.

**Ce qu'il faut faire.** D'abord un rituel de connexion manuel par canal, jusqu'au
premier message reçu — c'est un geste de Quentin, pas un test. Puis figer ce qui a marché
dans un test d'intégration avec un serveur factice, sur le motif de
`apps/runner/src/tests/approvals/notify.test.ts`.

**Ordre.** Discord d'abord (le binding existe déjà), puis Slack, puis WhatsApp — dont
la dépendance est épinglée pour une faille de spoofing et mérite sa propre attention.

**Effort.** ~1 jour par canal, dont une bonne moitié en dehors du code.

---

## Lot 5 — Les 11 harnais de fournisseurs natifs

**Pourquoi.** La suite de conformité existe et fonctionne — mais elle n'a été exécutée
que via OpenRouter, ce qui éprouve le harnais `openrouter` et **aucun autre**. Les onze
autres n'ont jamais été pilotés avec leurs identifiants natifs.

**Ce qu'il faut faire.** Rien à écrire : l'outil est prêt.

```
pnpm --filter @nodal-agents/llm conformance -- --provider anthropic --model claude-sonnet-5
```

Un passage par fournisseur, en archivant le rapport JSON. Ce qui manque, ce sont les
**clés**, pas le code.

**Effort.** ~2 heures une fois les clés réunies. Coût en tokens réel mais modeste.

**Rend modifiable sereinement.** Le catalogue de modèles et les providers — aujourd'hui
on sait qu'un identifiant existe, pas qu'un modèle répond.

---

## Lot 6 — Un runner Windows en CI

**Pourquoi.** Toute la CI tourne sur `ubuntu-latest`, alors que le développement est sur
Windows. Les trois pièges qui ont réellement coûté du temps cette semaine — `taskkill`
laissant un bloc de mémoire partagée, le port 58001 réservé par le système, l'arrêt de
Postgres — sont **invisibles sur Ubuntu**.

**Ce qu'il faut faire.** Une matrice sur le job `ci` :

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

**Le coût est réel** : le temps de CI double. À arbitrer — mais l'audit a produit
exactement zéro finding sur ces sujets alors qu'ils sont la première cause d'incident
observée en usage.

**Effort.** ~2 heures, plus la résolution de ce qui tombera.

---

## Ce que ce plan ne couvre pas

- **Les 135 outils connecteurs**, comptés par adaptateur. Les couvrir un par un demanderait
  des identifiants pour treize services tiers ; le rapport coût/preuve est mauvais tant que
  les lots 1 à 4 ne sont pas faits.
- **La boucle de réflexion et le curateur**, désactivées par défaut. À traiter **avant**
  toute activation par défaut, pas avant.
- **Le plafond de coût sur les 11 fournisseurs sans coût rapporté.** Ce n'est pas un trou
  de test mais une limite de conception : sans coût rapporté, il n'y a rien à vérifier.
  Le budget de tokens reste le garde-fou, et la documentation le dit désormais.

## Comment mesurer l'avancement

`pnpm inventory` régénère le recensement et la page. Les nombres « sans test » de chaque
section sont la métrique du plan — pas le pourcentage global, qui mesure la citation d'un
nom et non la force d'une assertion.

---

## Avancement

### 2026-08-10 — lot 1 entamé

`apps/web/src/lib/__tests__/workspace-actions.test.ts` — **6 actions couvertes**,
9 tests, tous sur des lignes réelles :

| Action | Ce qui est prouvé |
|---|---|
| `createWorkspaceAction` | l'entité ET la ligne d'appartenance propriétaire ; un nom vide n'écrit rien |
| `renameWorkspaceAction` | renomme ; un espace dont on n'est pas membre est refusé **et reste intact** |
| `deleteWorkspaceAction` | refuse l'espace courant, refuse un id non-GUID, et supprime réellement la ligne sinon |
| `switchWorkspaceAction` | refuse un espace hors appartenance |

Reste **33 actions** sur les 39.

### Question tranchée — la suppression n'a PAS de cascade

`apps/web/src/lib/__tests__/delete-cascade.test.ts` répond à la suspicion la plus
grave ouverte par le lot 1 : **le produit va bien**. `deleteWorkspaceAction`
supprime exactement une ligne ; le voisin et l'espace de la session restent
intacts. La disparition observée venait de la base de test partagée entre suites,
pas d'une cascade.

Le test est conservé comme régression : une cascade ajoutée plus tard ferait
perdre des espaces à des utilisateurs sans que rien ne le dise.

Conséquence pour la reprise : `setLanCommandYoloAction` se règle par l'isolation
de la base entre suites, pas par un correctif produit.

### 2026-08-10 — les 9 unités les plus dangereuses sont couvertes

Les trois blocs de tête du tableau ci-dessous (détruisent / ouvrent l'exécution
de code / manipulent des secrets) sont faits : **39 tests**, tous sur des lignes
réelles, des fichiers réels ou le corps de la requête sortante.

| Fichier | Actions | Ce qui est prouvé |
|---|---|---|
| `destructive-actions.test.ts` | `deleteConversationAction`, `removeAgentWorkspaceAction`, `deleteWorkspaceFileAction`, `uninstallCommunitySkillAction` | la cible part, le voisin reste ; l'entité d'à côté est hors d'atteinte ; `../secret.txt` ne sort pas du dossier ; le corps envoyé au runner porte bien le slug ET l'entityId |
| `grant-actions.test.ts` | `setSkillScriptsAuthorizedAction`, `setSkillFilesWritableAction`, `setLanCommandYoloAction` | l'interrupteur bascule dans les deux sens ; un non-propriétaire est refusé **et la colonne reste à false** ; scripts et fichiers sont deux portes distinctes ; l'espace voisin n'est jamais ouvert |
| `secret-rotation-actions.test.ts` | `updateConnectorApiKeyAction`, `updateMcpServerApiKeyAction` | la clé est stockée chiffrée, jamais en clair ; pas de double chiffrement ; **une clé refusée n'écrase pas celle qui marche** ; un préfixe hors catalogue n'entraîne aucun appel réseau |

**Ces tests ont été éprouvés par mutation**, parce qu'une suite verte ne prouve
rien tant qu'on ne l'a pas vue échouer. Trois gardes cassées volontairement dans
`actions.ts` — la garde propriétaire de `setLanCommandYoloAction`, le scoping par
entité du `DELETE` de `deleteConversationAction`, le chiffrement de
`updateConnectorApiKeyAction` — ont fait tomber exactement le test correspondant,
et lui seul. Le fichier a été restauré ensuite.

Un constat consigné au passage, sans le traiter comme un défaut :
`deleteConversationAction` renvoie `ok` quand l'identifiant est inconnu ou
appartient à une autre entité. L'écriture est sûre — rien ne part — mais le
message est optimiste. Un test le fixe pour qu'un changement de ce contrat soit
un choix, pas une surprise.

Reste **8 unités** dans le tableau de danger (retirer une capacité, ouvrir un
canal, surface publique), puis les 45 unités ordinaires et le test générique
d'IDOR sur les lectures.

### 2026-08-10 — le tableau de danger est vidé (et l'inventaire mentait sur un point)

Les 8 unités restantes ont été traitées, mais elles n'étaient que **7** : le
croisement de l'inventaire produisait un faux négatif franc.

**`POST /webhooks/:slug/:secret` était déjà couvert.**
`apps/runner/src/tests/routes/webhook.test.ts` (497 lignes) monte le vrai
serveur via `createApp` et l'éprouve en douze tests : uniformité des 404,
création de job, incréments concurrents, notify, enveloppe anti-injection,
plafond de corps, limite de débit. L'inventaire le comptait « sans test » parce
que `testStatus` cherchait la chaîne entre quotes immédiates ou entre frontières
de mot — or elle apparaît dans `describe('POST /webhooks/:slug/:secret — …')`,
et `\b` ne s'arme pas devant un `/`. Corrigé dans `scripts/inventory/collect.mjs` :
les chemins sont désormais cherchés en sous-chaîne.

Le premier correctif a créé le défaut inverse — `/api/skills/uninstall` passait
pour testée parce qu'un test du dashboard vérifie l'URL qu'il appelle, sans
jamais monter le handler du runner. Les routes sont donc mesurées sur
`apps/runner` uniquement. État réel après correction : **11 routes sur 13
couvertes**, les deux manquantes étant `/api/skills/acknowledge-update` et
`/api/skills/install` (traitée ci-dessous).

Ce croisement reste une mesure de CITATION, jamais de preuve. C'est écrit dans
le code du collecteur pour que le prochain lecteur ne s'y trompe pas.

**Les 7 unités réellement découvertes — 36 tests.**

| Fichier | Unités | Ce qui est prouvé |
|---|---|---|
| `packages/tools/src/tests/meta-ops-links.test.ts` | `detach_agent`, `detach_connector`, `detach_mcp`, `detach_skill`, `attach_connector` | la bonne ligne de lien part, les voisines restent ; détacher ne supprime jamais la ressource ni l'agent ; un slug d'une autre entité ne résout rien ; `detach_agent` ne défait que le lien de MON orchestrateur ; `attach_connector` est idempotent et écrit le bon `entityId` |
| `apps/web/src/lib/__tests__/channel-conversation-actions.test.ts` | `resolveChannelAllowedConversationAction` | approuver ne touche qu'une ligne ; une ligne déjà active ne peut pas être rejouée ; refuser supprime réellement ; la demande d'un autre espace n'est ni approuvée ni supprimée |
| `apps/runner/src/tests/routes/skills-install.test.ts` | `POST /api/skills/install` | le secret est vérifié **avant** le corps ; un secret de bonne longueur mais faux est refusé ; l'allowlist d'hôtes rejette **avant tout téléchargement**, y compris sur la reprise sans schéma ; une erreur prévue devient un 400 lisible, jamais un 500 |

Le garde Origin/Host qui ferme `/api/*` aux origines étrangères n'est pas
redoublé ici : `trusted-origin.test.ts` l'éprouve déjà, et prouve qu'il passe
avant l'authentification.

**Mutations, à nouveau.** Trois gardes cassées : le `orchestratorId` du DELETE de
`detach_agent`, la garde `status !== 'pending'` de l'action de canal, et la
comparaison du secret runner remplacée par un test de préfixe. Chacune a fait
tomber son test, et lui seul. Fichiers restaurés.

Un accident de test corrigé au passage, qui vaut d'être noté : le premier jet du
test d'authentification envoyait un secret VALIDE — il partait donc réellement
sur le réseau au lieu de s'arrêter au 403. Un test d'auth qui télécharge est un
test qui ne prouve pas ce qu'il annonce.

### L'ordre qui reste — par danger, pas par ordre alphabétique

Sur les 62 unités non couvertes, **17 détruisent, ouvrent ou authentifient**.
Elles valent les 45 autres réunies :

| Priorité | Unités |
|---|---|
| ~~**Détruisent**~~ ✅ | ~~`deleteConversationAction`, `deleteWorkspaceFileAction`, `removeAgentWorkspaceAction`, `uninstallCommunitySkillAction`~~ |
| ~~**Ouvrent l'exécution de code**~~ ✅ | ~~`setLanCommandYoloAction`, `setSkillScriptsAuthorizedAction`, `setSkillFilesWritableAction`~~ |
| ~~**Manipulent des secrets**~~ ✅ | ~~`updateConnectorApiKeyAction`, `updateMcpServerApiKeyAction`~~ |
| ~~**Ouvrent un canal**~~ ✅ | ~~`resolveChannelAllowedConversationAction`~~ |
| ~~**Retirent une capacité**~~ ✅ | ~~`detach_agent`, `detach_connector`, `detach_mcp`, `detach_skill`, `attach_connector`~~ |
| ~~**Surface publique**~~ ✅ | ~~`POST /webhooks/:slug/:secret`~~ (l'était déjà), ~~`POST /api/skills/install`~~ |

**Le tableau de danger est vidé.** Ce qui suit est de l'ordinaire : les 45 unités
restantes n'ouvrent rien et ne détruisent rien.

Les 18 lectures (`get*`, `list*`) ne méritent pas 18 tests : un seul test
générique d'IDOR — est-ce qu'elles fuient les données d'un autre espace ? —
couvre le seul risque réel. **C'est la prochaine chose à faire**, avant les
écritures ordinaires.

Restent aussi trois routes du runner jamais montées dans un test :
`/api/skills/uninstall`, `/api/skills/update`, `/api/skills/acknowledge-update`.
Le décor est écrit (`skills-install.test.ts`) — les couvrir coûte peu.

Notes pour la reprise, toutes payées une fois :

- le mock de `@/lib/server.ts` doit exporter `ACTIVE_ENTITY_COOKIE`, sinon
  `switchWorkspaceAction` lève à l'import ;
- le champ d'erreur d'`ActionResult` s'appelle `code`, pas `error` ;
- `env.ts` fige `process.env` à son premier chargement : poser `WORKER_SECRET`
  dans `beforeAll`, avant le premier `import('../actions.ts')` ;
- pour rendre la session non-propriétaire, basculer `entities.userId` vers un
  second utilisateur le temps du test, puis restaurer — c'est la seule façon
  d'éprouver les gardes owner-only avec un mock d'auth fixe.
