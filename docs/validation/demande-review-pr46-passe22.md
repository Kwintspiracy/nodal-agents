# Demande de review — PR #46, passe 22 (P2 : retours de Quentin sur /spaces)

Périmètre : **le commit qui suit `d2aafdbb`**. P1, P2, P3 étaient clos ; ce
commit répond à deux retours de Quentin après avoir vu la page (06/09) :
« la liste est noyée par les cron, il faut les grouper à part comme la section
scheduled de Claude Code » et « la page de feed est dégueulasse comparée au
design proposé ».

## Ce qui a changé

### La liste `/spaces` — deux sections

- `listSpacesAction` (neuve, `apps/web/src/lib/actions.ts`) : les tâches de
  TÊTE de l'entité (`parent_job_id IS NULL`), 200 max, avec `schedule_id` et
  le nom de l'automatisation (`trigger_context`).
- `apps/web/src/lib/spaces-list.ts` (pur, testé) : `groupSpaces` sépare les
  conversations (tout canal sauf `cron`, dans l'ordre reçu) des
  automatisations, groupées par `scheduleId`, sinon `scheduleName`, sinon la
  tâche ; chaque groupe porte ses runs (le plus récent en tête), le nombre
  d'échecs, le coût cumulé.
- `ConversationsTable.tsx` (le tableau d'avant, extrait) et
  `ScheduledSection.tsx` (neuf, client) : une ligne par automatisation, repliée,
  ses runs dessous quand on l'ouvre.

### Le fil — ce qui le salissait, vu sur une capture réelle

J'ai rendu la page en HTML statique avec le CSS compilé du serveur dev et un
vrai job de la base (pas de mot de passe pour le navigateur), capturé avec
Playwright, et corrigé ce qui se voyait :

| Vu | Corrigé |
|---|---|
| La mémoire (`query_memory`) rendue en grand tableau de textes longs | **P1 requalifié** : `query_memory` est une carte `search` (des souvenirs qui correspondent : `fact` en titre, `id` en référence, catégorie et importance en extrait), donc une étape repliée, pas une carte. `cards.test.ts` suit. |
| La demande d'une automatisation = un prompt entier, déroulé | `ClampedText` : six lignes, « Show more ». |
| Le rappel du runner en paragraphe italique | Une ligne mono tronquée, texte complet en `title`. |
| Groupes « 1 raw result », « 1 call » qui ne disent rien | `summarizeSteps` nomme l'outil (nom court : sans préfixe MCP ni `cli:`) quand la carte est `generic` ou absente. |
| Avatar utilisateur « YO » gris | `Disc` encre du DS avec l'icône `User`. |
| Cellules de table sans borne | `max-w-[40ch] truncate` par cellule. |
| Une étape sans ligne d'audit ni sortie (`return_result`) n'affichait rien | Elle montre son entrée (le texte du résultat). |

Mesuré : `tsc` web et tools propres ; tests tools `cards` 18, web fil/rendu/
action/liste verts ; captures avant/après dans le scratchpad de la session.

## Ce dont je doute moi-même

### `query_memory` → `search` défait un arbitrage de la passe 11

La passe 11 avait jugé `table` juste (« `MemoryRecord[]`, colonnes stables »).
Le produit dit autre chose : dans le fil, une lecture de mémoire est une
recherche repliée, pas un tableau à lire. Je tranche pour le produit ; dire si
l'argument tient.

### Le nom court d'un outil dans le titre d'un groupe

Le contrat interdit de DISPATCHER sur le nom ; ici on l'AFFICHE, faute de
mieux, quand la carte ne porte rien. Est-ce une brèche dans le principe, ou son
application honnête ?

### `groupSpaces` prend « le plus récent en tête » sur la foi de l'ordre reçu

`listSpacesAction` trie par `created_at desc` ; la fonction pure suppose cet
ordre pour `lastRun`. Un appelant qui passerait un autre ordre aurait un
`lastRun` faux. Faut-il trier dans la fonction ?

### Ce que le runner en cours ne montre pas encore

Les lignes `query_memory` déjà persistées portent `card: 'table'` : elles
resteront des tableaux dans le fil (peu nombreuses, un jour de runs). Le runner
doit être relancé pour que les nouvelles lignes soient `search`.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Dis explicitement si tu ne
trouves rien de neuf. Un constat non exécuté est marqué NON EXÉCUTÉ.
