# Demande de review — PR #46, passe 26 (P9 : Scheduled, + deux correctifs CI)

Périmètre : **le commit `b9ff0f1b`** (« P9 Scheduled »). Fichiers :
`apps/web/src/components/Sidebar.tsx`, `apps/web/src/app/(dashboard)/scheduled/**`
(page, `ScheduledSection.tsx` déplacé depuis `spaces/`, test de rendu),
`apps/web/src/app/(dashboard)/spaces/page.tsx`, `apps/web/src/lib/spaces-list.ts`,
`listSpacesAction` + `listScheduledRunsAction` dans `apps/web/src/lib/actions.ts`,
`apps/web/src/lib/__tests__/spaces-list-read.test.ts` ; et, dans le même commit,
`ClampedText.tsx` / `StatusBar.tsx` (trois `<button>` bruts remplacés par `TextButton`)
et `packages/shared/src/tests/model-catalog.test.ts` (prix de cache GLM 5.3 Flash).

**Hors périmètre de cette passe** : tout fichier NON COMMITTÉ de l'arbre de travail
(`packages/db/migrations/0093_*`, `packages/tools/src/projects/**`,
`apps/web/src/lib/project-actions.ts`, les schémas modifiés) — c'est P5, en cours,
il aura sa propre passe. Ne le relis pas ici.

## Ce que ça pose (plan « De la maquette au produit », P9)

- Une entrée de menu **Scheduled** (Overview, après Spaces, icône `CalendarCheck`,
  distincte de `ClockCountdown` d'Automations).
- La page `/scheduled` : `listScheduledRunsAction()` (runs de TÊTE, `channel = 'cron'`,
  limite 300 plafonnée à 2000) → `groupSpaces(rows).scheduled` → `ScheduledSection`
  (une ligne par automatisation, repliée, ses runs dessous ; le titre de section a été
  retiré, le compteur reste). Lien « Configure automations » vers `/automations`.
  État vide et erreur dits.
- `/spaces` ne rend plus que `ConversationsTable` ; `listSpacesAction` ne lit plus
  QUE `channel <> 'cron'` (la séparation en deux requêtes de la passe 22 devient deux
  ACTIONS). `SPACE_LIST_SELECT` + `toSpaceListRow` factorisent les deux.
- Garde du plan : aucun run cron dans Spaces ; un run ouvre son fil (`/spaces/<id>`).

## Mesuré

- `spaces-list-read.test.ts` (pglite) : 300 runs cron plus récents que la conversation →
  `listSpacesAction` ne renvoie AUCUNE ligne `cron` et la conversation ancienne survit ;
  `listScheduledRunsAction` renvoie 300 lignes cron, `scheduleName` lu dans la trace,
  triées récentes d'abord, limite respectée.
- Mutation exécutée par moi : `ne(agentJobs.channel, 'cron')` retiré →
  `expected [ Array(100) ] to not include 'cron'` ; restauré, vert.
- `ScheduledSection.test.tsx` (`renderToStaticMarkup`) : deux automatisations, trois
  runs, noms, compteurs, `1 failed`, liens `/spaces/<id>` via `ScheduleRunList`
  (extrait parce qu'un groupe est replié par défaut). Mutation `/jobs/` → rouge.
- `eslint src` de `apps/web` : 0 erreur (les trois `<button>` étaient les 3 erreurs de
  la CI Linux). `packages/shared` : 465 tests verts (le test GLM était l'échec de
  `ci-windows`).

## Ce dont je doute moi-même

### `ScheduleRunList` exporté « pour le test »

Le composant est extrait uniquement parce que `renderToStaticMarkup` ne peut pas
déplier un disclosure. Est-ce un découpage qui a un sens de produit, ou un test qui
dicte la forme du code ? Si la seconde lecture est la bonne, quelle assertion
prouverait « un run ouvre son fil » sans cette extraction ?

### `TextButton` pour un toggle à `aria-pressed` (StatusBar l.109)

`TextButton` est documenté « réservé à la navigation tertiaire légère ». Ici il porte
un toggle (le chip jetons/coût qui ouvre le panneau) et un « Back to the
conversation ». Le lint est satisfait ; la règle produit l'est-elle ? Y a-t-il un
composant DS plus juste pour un chip cliquable ?

### Le test GLM : j'ai aligné l'attendu sur le catalogue

`cacheReadPerMillionUsd: 0.015` vient de `model-catalog.ts` (P4a dit l'avoir lu sur
OpenRouter le 06/09). Le test garde-t-il encore quelque chose si l'attendu est copié
du code ? Que faudrait-il pour qu'il garde le PRIX et pas la forme ?

### `groupSpaces` reste totale

Elle continue de trier `conversations` alors que plus personne ne lit ce champ.
Dette ou garde ?

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ (la sandbox
est en lecture seule : tu ne peux ni lancer pnpm ni git).
