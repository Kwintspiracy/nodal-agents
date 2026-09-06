# Demande de review — PR #46, passe 31 (les correctifs de la passe 30 ; fin du lot 2)

Périmètre : **le dernier commit de la branche** (`git log -1` : « fix(spaces): passe Codex 30 — … »),
qui traite les trois constats et trois doutes de la passe 30 :

- `apps/web/src/app/(dashboard)/spaces/ProjectThread.tsx` (neuf) + `spaces/[id]/page.tsx` : un échec
  de lecture du fil est DIT et retire la saisie ; « Nothing said here yet » seulement sans
  conversation.
- `apps/web/src/lib/project-actions.ts` : preuve bornée aux 3 dernières séquences (sous-requête
  `GROUP BY sequence_id ORDER BY max(created_at) DESC LIMIT 3`, puis `inArray`) ;
  `ProjectFilesView.unreadable: 'absent' | 'not_a_directory' | 'permission' | 'error' | null`
  (par `err.code`) ; `kind: 'symlink'` via `Dirent.isSymbolicLink()`, sans `stat` ;
  `createProjectConversationAction` pose `origin: 'project'` ; `projectConversationId` = la
  plus récente `origin = 'project'` ancrée au projet.
- `apps/web/src/lib/conversation-actions.ts` : `LIMIT N + 1` puis coupe à N (`truncated` exact) ;
  la liste de Chat prend `origin IN ('user', 'project')`.
- `packages/db/migrations/0097_conversations_origin_project.sql` (DROP + ADD de la contrainte,
  `project` accepté), schéma Drizzle et `helpers.ts` alignés.
- `spaces/ProjectShelf.tsx` : une phrase par cause d'illisibilité ; flèche sur un lien.
- Tests : `project-actions` (preuve bornée avec une 6e séquence longue qui la discrimine,
  causes, symlink par jonction, conversation du projet par origine), `conversation-actions`
  (502 → tronqué, 500 pile → non), `ProjectThread` (rendu des trois cas), `ProjectShelf`.

**Hors périmètre** : rien — l'arbre est propre, c'est la fin du lot 2.

## Mesuré

- Web 78 fichiers / 1200 tests ; db 258 ; typecheck racine ; dependency-cruiser ; lint 0 erreur.
- Mutations (rouges puis restaurées) — Opus : échec retraité en fil vide, preuve non bornée,
  causes fondues, conversation du projet par récence, symlink reclassé, troncature sur `>=` ;
  moi : conversation du projet redevenue « la plus récente dashboard » → 2 rouges.
- Migration 0097 appliquée sur la base dev.

## Ce dont je doute moi-même

### La sous-requête de la preuve

`inArray(sequence_id, <subquery GROUP BY … ORDER BY max() … LIMIT 3>)` : Postgres accepte un
`ORDER BY` d'agrégat dans une sous-requête `IN` ? PGlite l'a accepté (tests verts) ; le vrai
Postgres 16 aussi, sauf erreur. Si tu vois un cas où la sous-requête est réécrite sans son
`ORDER BY`/`LIMIT` (certaines planifications), dis-le.

### `origin = 'project'` et l'onboarding

`listAllConversationsAction` prend `user` et `project`. Reste-t-il un lecteur de
`conversations` qui filtre `origin = 'user'` strictement et laisserait les conversations de
projet dehors (grep `origin` dans `apps/web` et `apps/runner`) ?

### Un lien symbolique n'est plus mesuré, mais il est LISTÉ

L'étagère montre `lien →` sans dire où il mène. Faut-il lire la cible (`readlink`) pour
l'afficher, au risque de révéler un chemin hors du terrain ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne trouves rien de
neuf — c'est ce qui clôt le lot. Un constat non exécuté est marqué NON EXÉCUTÉ.
