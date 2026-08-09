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

### Point bloquant à reprendre

`setLanCommandYoloAction` / `getLanCommandYoloAction` résistent. Ce qui est établi :

- l'action renvoie `ok`, donc elle a bien trouvé l'entité par `session.entityId`
  (sa garde `if (!entityRow) return fail('not_found')` n'a pas tiré) ;
- une relecture immédiate de `entities` par `eq(entities.id, seed.entityId)` rend
  une ligne **indéfinie**, alors que le même motif fonctionne pour
  `renameWorkspaceAction` dans le même fichier ;
- ce n'est pas un effet d'ordre : isolé dans son propre fichier, le
  comportement est identique.

L'hypothèse restante est que `session.entityId` ne vaut pas `seed.entityId` dans
ce contexte de mock — l'action écrirait alors sur une autre entité, existante,
et la relecture porterait sur la bonne. À vérifier en imprimant la valeur
retournée par `getSession()` sous ce mock, ce qui n'a pas été fait.

Note pour la reprise : `@/lib/server.ts` doit exporter `ACTIVE_ENTITY_COOKIE`
dans le mock, sinon `switchWorkspaceAction` lève à l'import.
