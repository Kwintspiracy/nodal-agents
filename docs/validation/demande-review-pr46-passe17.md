# Demande de review — PR #46, passe 17 (P2 : le fil de conversation, page /spaces)

Périmètre : **les commits `0344b711` (modèle) et le commit P2 qui suit
`497ed04b`** — tout ce qui est sous `apps/web/src/lib/conversation-feed*`,
`apps/web/src/app/(dashboard)/spaces/**`, l'action
`getSpaceConversationAction` dans `apps/web/src/lib/actions.ts`, et UNE ligne
dans `Sidebar.tsx`. P1 est clos (passe 16) et n'est pas à rouvrir.

## Ce que ça pose (plan « De la maquette au produit », P2)

Une entrée « Spaces » dans la barre latérale — **la seule modification de
l'existant** (décision de Quentin, 05/09 : sidebar, header, DS, pages Runs /
Code / Chat inchangés). Deux pages neuves :

- `/spaces` : les tâches de tête récentes (`listDelegationRunsAction`,
  délégations exclues), une ligne par tâche → `/spaces/<jobId>`.
- `/spaces/[id]` : le fil dessiné. Rendu serveur depuis
  `getSpaceConversationAction` ; `LiveRefresh` relit la page toutes les 3 s
  tant que le job court.

Le modèle (`conversation-feed.ts`) est PUR : job + messages, tool_calls
(carte + charge utile P1), llm_calls, enfants → items `request · turn · note ·
child · answer · failure`. Un tour = prose puis actions ; les actions
mineures (raisonnement, `read`, `search`, `text`, `generic`, ligne sans carte)
se replient en `steps`, les résultats (`files`, `table`, `terminal`, `sent`,
`checks`, `delegation`) se montrent en `card` — **si l'appel a réussi et si la
charge a quelque chose à dessiner** (`showsAlone` : une table sans ligne
reste une étape). Le dispatch se fait sur `presented.card`, jamais sur le nom.

## Ce que le commit affirme, et comment c'est mesuré

1. Le fil se construit depuis la VRAIE forme des lignes — le test du modèle
   reproduit un transcript relevé en base dev (cron, nudge `[système]`,
   reasoning, telegram_send_message, return_result sans ligne d'audit).
2. L'action lit des lignes RÉELLES (pglite) : job + messages, deux tool_calls
   avec `card`/`presented`, deux llm_calls, un enfant ; bornée à l'entité ;
   refuse un id non-uuid.
3. La vue rend chaque carte depuis sa charge utile (`renderToStaticMarkup`) :
   table (cellules, « first row may or may not be a header »), envoi (canal,
   destinataire, message parti), terminal (commande, exit, coupe), brut dit
   brut (`files · raw`), rappel du runner dit comme tel, réponse finale en
   dernier, étapes repliées par défaut avec un titre déduit des CARTES.
4. Mutations mesurées : `showsAlone` sans test d'échec → rouge ; carte table
   rendue en brut → rouge ; action sans borne d'entité → rouge.

## Ce dont je doute moi-même — à attaquer en priorité

### P0 — les messages `user` après le premier sont TOUS des rappels du runner

`buildConversationFeed` traite tout message `user` après la demande comme une
`note` (« Nodal reminded the agent: … »). Vrai pour un job : les nudges de
livraison et d'approbation sont les seuls `user` ajoutés (execute.ts ~2911,
~3717). Mais `thread-history.ts` préfixe l'historique d'une conversation
Telegram/chat au job suivant (`messages = [...history, ...messages]`,
execute.ts ~1788) : dans CE job, les anciens messages de l'utilisateur sont
des `user` qui précèdent la demande courante. Le fil dirait alors « Nodal
reminded the agent » pour de vrais messages de l'utilisateur, et prendrait le
PREMIER message de l'historique pour la demande. Vérifier la forme exacte que
`thread-history.ts` injecte (rôles, marqueurs) et dire si le modèle se trompe.

### P1 — le tour k = le k-ième message de l'agent = `llm_calls.turn = k`

L'appariement tours ↔ appels LLM repose sur l'index du message assistant.
Vérifié sur UN job (4 messages assistant, turns 1..4). Un job repris après
approbation ou délégation (`resume.ts`) garde-t-il cet alignement, ou le
compteur `turn` du job avance-t-il sans message assistant ?

### P1 — `return_result` et `assign_*` n'ont pas de ligne d'audit

Leurs appels apparaissent comme étapes « no card recorded ». Voulu (le fil dit
ce qu'il sait), mais est-ce lisible ? La réponse finale vient de `job.result`
(item `answer`), la délégation de `parent_job_id` (item `child`).

### P2 — `LiveRefresh` recharge toute la page toutes les 3 s

`router.refresh()` relit l'action entière (messages complets) à chaque tic.
Acceptable pour P2 ; dire si c'est une dette pour P4 (barre d'état).

### P2 — la copie est en anglais

Le tableau de bord est en anglais (Runs, Home, Delegation). Le fil suit
(« Sent to telegram », « Answer », « Nodal reminded the agent »). Aucun texte
d'interface dans le modèle ; tout est dans `format.ts` et la vue.

## Hors périmètre

P3 (cartes de preuve depuis `verification_runs`), P4 (barre d'état, coût par
agent), P5 (diff), P7 (question à boutons). Le rendu Telegram.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts : tient / faux. Un constat non exécuté est
marqué NON EXÉCUTÉ.
