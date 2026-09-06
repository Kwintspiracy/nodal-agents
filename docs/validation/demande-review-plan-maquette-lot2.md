# Demande de review — plan « De la maquette au produit », lot 2 réécrit (06/09)

Périmètre : **le document** `docs/plans/de-la-maquette-au-produit.md` (source) et
son miroir publié `docs/plans/de-la-maquette-au-produit.html`. Pas de PR, pas de
code : c'est un plan avant tout code, réécrit le 06/09 sur les décisions de
Quentin, **juste après une compaction de contexte**. Le risque relu ici est
précis : qu'une décision prise dans la discussion n'ait pas atterri dans le
plan, ou y ait atterri déformée.

## La source de vérité

L'extrait verbatim de la discussion (12 messages de Quentin, mes réponses),
sorti du transcript de session :
`C:\Users\kwint\AppData\Local\Temp\claude\D--APPS-NodalAI\4c06922d-6c07-4046-b357-890e8aefe6b3\scratchpad\discussion-06-09.md`

Si ce fichier n'est pas lisible depuis la sandbox, le DIRE et relire le plan
pour sa seule cohérence interne et ses ancrages code — ne pas conclure sur la
fidélité à la discussion sans l'avoir lue.

## Ce que le plan affirme

1. Les décisions de Quentin du 06/09 sont dans la section « Ce qui a été décidé
   le 06/09 » et déclinées en pierres P5-P9 (lot 2), P10-P12 (lot 3), P13-P14
   (lot 4). Les anciennes P5-P10 du 05/09 sont renumérotées P10-P14 et la
   section « Ce qui arrive par Telegram » est remplacée.
2. Chaque pierre nomme sur quoi elle s'appuie dans le code : `agent_workspaces`,
   `code_projects`, `PROJECT_MARKERS`, `conversations` + `chat_messages`,
   `agent_jobs.conversation_id`, `resolveConversationId`, `thread-history.ts`,
   `ChatClient`, `sendChatMessageAction`, `listSpacesAction`, `groupSpaces`,
   `ScheduledSection`, `takeCheckpointForTurn`, `notify.ts`, `job_deliveries`,
   `save_memory`, `riskLevel` sur `ToolDefinition` (non persisté sur
   `tool_calls`).
3. La frontière chat / travail est celle de la discussion : « quelque chose est
   sorti du chat », récursive sur les descendants, lue sur les cartes de P1 et
   sur le niveau de risque des outils tiers.

## Questions, par priorité

### P0 — fidélité à la discussion

Pour CHAQUE message de Quentin dans l'extrait, dire : quelle décision ou nuance
il porte, et OÙ elle est dans le plan (section, pierre). Une décision sans
atterrissage est un constat. Une décision déformée aussi — citer les deux
textes.

Points que je soupçonne moi-même :

- **L'agent de recherche.** À 02:15 Quentin cite « utilise l'agent de recherche
  et ne fait pas la recherche lui-même » comme un cas de production. À 02:20 il
  pose que sans outil autre que le chat, même via un sous-agent, ça reste du
  chat. Le plan retient la règle du 02:20 (récursive). Est-ce dit comme un
  point à confirmer ?
- **L'email avec les résultats.** Cité à 02:15 comme production. La frontière
  du plan dit « répondre en texte sur n'importe quel canal = chat ». Un email
  n'est pas un canal de conversation de Nodal : le plan le classe-t-il ?
- **« Une box avec les détails du projet et un lien »** (02:10). Le plan dit
  « un encart dit ce qui a été produit et où il vit, avec le lien vers le
  projet ». Les détails du projet (nom, dossier) sont-ils dits ?
- **Le chat en bas de la page du projet, « comme VS Code »** (03:36) et « la
  discussion doit savoir de quel dossier je parle » (03:36) : P8 et P6.
- **Plus de découpage par silences ; l'utilisateur crée une nouvelle
  conversation** (03:36) : P6.
- **Scheduled avec son propre item de menu** (03:46) : P9.
- **Les conteneurs internes de Claude Code / Codex ne sont pas user-facing ;
  le dossier doit être choisi ou attribué par l'utilisateur** (03:29) : « La
  référence produit » et P5.

### P1 — cohérence interne après renumérotation

- Le tableau « Verdict de faisabilité » et le paragraphe « Ce qui reste hors
  de P2 » renvoient-ils aux BONS numéros après le passage P5-P10 → P10-P14 ?
- Le périmètre du 05/09 (« les écrans Runs, Code, Chat ne sont pas touchés »,
  « On ne touche pas ») est-il réconcilié avec « Chat change de nature » ?
- L'état de P2 (« codée », « à vérifier contre thread-history.ts », « pas par
  Playwright ») est-il celui du 06/09 au soir (passes 17-19 closes, capture
  réelle faite) ?
- Le `.html` dit-il la même chose que le `.md` partout où il a une section
  correspondante ? (Il est volontairement plus court : pas de tableau de
  verdict, pas de notes d'état — ce n'est pas un constat.)

### P2 — ancrages code

Pour chaque nom cité au point 2 ci-dessus : existe-t-il, et joue-t-il le rôle
que le plan lui donne ? En particulier : `conversations` (table drizzle dans
`packages/db/src/schema/chat-messages.ts`) — une conversation du dashboard
a-t-elle des tours SANS job ? Si oui, « en ouvrir une rend le fil de P2, le
même code » (P7) suppose une lecture que P2 ne fait pas aujourd'hui (P2 lit un
job). Est-ce dit ?

## Hors périmètre

Le lot 1 (P1-P4) et son code : relus en 15 passes, clos. La qualité du design
produit des décisions elles-mêmes : elles sont de Quentin, on ne les rediscute
pas.

## Ce qui n'est PAS attendu

« Ça a l'air bien ». Deux verdicts par constat : tient / faux, avec la ligne du
plan et, pour la fidélité, la ligne de l'extrait. Dis explicitement si tu ne
trouves rien de neuf. Un constat non vérifié (fichier non lu) est marqué NON
EXÉCUTÉ.
