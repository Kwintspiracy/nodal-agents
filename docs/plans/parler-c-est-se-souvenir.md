<!-- artifact: https://claude.ai/code/artifact/a7bc52c8-b9e9-4561-a44d-5ec1c78dca81 -->

# Parler, c'est se souvenir — deux PR

> Une PR, un lot, mergée dans la semaine. Deux lots ici, donc deux PR : ce qui
> tient l'état d'une routine, et ce qui tient le fil d'une conversation.

## Le sujet, en une phrase

**Alfred a parlé dans le fil de Quentin sans y écrire, il a republié une
annonce déjà faite dix jours plus tôt, et il a répondu aux accusés de réception
de ses propres messages.**

Les trois constats viennent de la nuit du 07 au 08/09, sur le fil Telegram
`a7aa39e4` (chat `199791464`) et la routine
`Check-Nodal-Agents-GitHub-Updates`. Tous les trois sont lus en base, pas
déduits. **Aucun n'est un défaut du modèle.**

## Suivi

> **LES DEUX PR SONT MERGÉES** — #47 (`2a28dabe`) et #48 (`28fcb25e`, le
> 09/09/2026, après **douze passes** de revue Codex).

| # | PR | Ce qui change | Taille | État |
|---|----|---------------|--------|------|
| 1 | B — la routine | Une routine a un état à elle, pas un souvenir | M | ✅ PR #47 mergée |
| 1b | B — la routine | La mémoire n'est pas un journal de bord | S | 🔄 source coupée ; passé à ranger |
| 2 | A — le fil | Ce qu'un agent dit dans un chat appartient au fil de ce chat | M | ✅ PR #48 mergée |
| 3 | A — le fil | Un envoi rend « envoyé », pas un identifiant à interpréter | S | ✅ PR #48 mergée |
| 4 | A — le fil | La page Chat sépare les canaux des conversations | M | ✅ PR #48 mergée |
| 5 | A — le fil | Le fil descend tout seul quand un message arrive | S | ✅ PR #48 mergée, avec deux réserves |

## Ce que la vérification a corrigé DANS CE PLAN

Douze passes sur la PR #48, et le plan ne prévoyait aucun des trois défauts les
plus sérieux. Ils portent tous sur la même erreur de méthode : **recalculer côté
écran une règle qui vit ailleurs.**

**Le lot 4 supposait qu'une liste de conversations suffit à désigner le fil
courant d'un chat.** Faux, de trois façons, et il a fallu deux correctifs pour
le voir : la liste est plafonnée à 200 lignes, une `Date` JavaScript tronque les
microsecondes d'un `timestamptz`, et `created_at` est nullable — or `ORDER BY …
DESC` place les NULL DEVANT en PostgreSQL. La ligne pouvait donc ouvrir un fil
pendant que le prochain message partait dans un autre. Le remède final ne corrige
pas la formule : il la SUPPRIME. La base désigne le fil courant, avec la règle
exacte de `resolveConversation`, et l'écran affiche.

**Le lot 5 tenait dans un drapeau, puis dans un compteur ; ni l'un ni l'autre ne
pouvait marcher.** Le drapeau restait armé quand le fil était déjà en bas, et
avalait le geste suivant du lecteur. Le compteur d'événements ne pouvait pas
marcher davantage : le navigateur FUSIONNE les événements de défilement d'un même
élément (CSSOM View §13.2). C'est la position mémorisée qui tranche.

**Deux réserves assumées, portées au backlog du harnais** : deux entrelacements
SOUS la frame subsistent — le lecteur défile et le contenu grandit avant que
l'événement de son geste ne soit distribué. Ils se réparent au geste suivant, et
les fermer demanderait un second état à tenir cohérent avec le premier. La
technique qui les supprime par construction est le conteneur inversé
(`flex-direction: column-reverse`), qui impose de rendre le fil à l'envers :
c'est un chantier à soi.

**Trois silences trouvés par la revue, qu'aucun lot n'avait prévus** : un chat
dont toutes les conversations tombent hors de la fenêtre disparaissait sans un
mot ; une lecture des fils en échec faisait disparaître la section entière ; et
un nom de chat qu'on n'a pas pu LIRE s'affichait comme un nom qui n'existe pas —
ce qui est le cas normal du propriétaire. L'écran dit maintenant chacun des
trois.

## Les trois preuves

### Le doublon Discord

La routine tourne 2 à 3 fois par jour. Sa consigne dit :
*« Read the last-known announced version with query_memory. This memory IS your
stored state. »*

- Runs du 07/09 à 01:00, 06:01 et 15:00 : `query_memory` rend en tête le fait
  `ab46445c` — « v0.8.8 (Aug 28), announced on Discord #announcements ».
  Verdict : rien de nouveau. Correct.
- Run du 08/09 à 01:00 : **la même requête rend en tête un fait sur le vault
  Obsidian AI Training**. L'agent conclut « aucune version précédente en
  mémoire (premier run) », poste l'annonce sur `#announcements`
  (`conversationId 1511202553420054671`, message `1546686789001945099`) et
  enregistre un fait neuf.

Le fait `ab46445c` **n'est plus dans la table**. Pas archivé : supprimé. Les
chemins de suppression ont été vérifiés un par un — le curateur archive et ne
supprime jamais (`packages/memory/src/curator.ts:10`), `mark_memory_outdated`
archive, `save_memory` n'écrase rien. Le seul code qui supprime pour de bon est
`deleteMemory`, appelé uniquement par la page Memories et la page Root context.
**Aucun agent ne peut l'avoir fait.**

### Le trou dans le fil

Colonne `messages` du job de 01:23, 28 entrées. Les tours rejoués au modèle :

1. « Fais-moi une app en HTML… IGDB » (26/08)
2. « Mets en ligne sur cloudflare »
3. « Je peux pas juste m'authentifier avec mon compte steam »
4. « Fais l'option la plus simple »
5. « T'en est où ? »
6. « Allo ? »
7. « Quelle url utiliser pour accéder à nodal en lan ! » (26/08)
8. « Je comprend pas. Elle est déjà publiée la 0.8.8 » (08/09)

L'annonce n'y est pas. Le prompt système (54 804 caractères) ne contient ni
`0.8.8`, ni `changelog`, ni `announce` — les trois ont été cherchés. Le
raisonnement du modèle, enregistré : *« User confused — replying to "0.8.8"? …
Context unclear. Ask clarifying question. »*

Pourquoi : `thread-history.ts:192` construit le fil avec
`WHERE conversation_id = …`. Le job de la routine porte `conversation_id NULL`,
alors qu'il a écrit sur `chat_id 199791464` — le fil de Quentin. Telegram
affiche un fil continu ; Nodal en relit un troué.

### Les accusés de réception pris pour des réponses

Dans ce même job, après l'envoi qui rend `{messageId: "2311"}` :

> *« User replied "2311"? That's odd — messageId "2311" means it came from a
> different chat? … likely they mean port 2311? Earlier I said port 3000 »*

Puis la même chose avec « 2312 ». Trois tours menés contre ses propres
identifiants, et plusieurs messages décousus envoyés pour une seule question.

Le `messageId` ne sert à rien au modèle : il est consommé par l'outbox
(`apps/runner/src/delivery/outbox.ts:453`, accusé de réception), et
`thread-history.ts:297` rejoue d'ailleurs `{messageId: 'history'}` pour tous les
tours passés — la valeur réelle n'a jamais été utile.

---

## PR B — la routine se souvient de ce qu'elle a fait

**Une routine a un état à elle.** Une clé, une valeur, écrite et relue sans
LLM, portée par la routine et visible sur son écran. Pas un fait en langage
naturel, noyé dans 37 souvenirs, retrouvé par recherche floue et effaçable d'un
clic depuis une page qui ne dit nulle part qu'une routine en dépend.

`agent_schedules` n'a aujourd'hui aucune colonne libre pour ça (vérifié :
`packages/db/src/schema/schedules.ts`).

*Preuve* : vider entièrement `agent_memory`, lancer la routine — elle ne
republie pas. Poser un état différent de la version du dépôt — elle republie
une fois, une seule.

**Ce que ça ne change pas** : la mémoire reste ce qu'elle est, pour ce à quoi
elle sert (ce que l'agent sait de Quentin). On lui retire seulement un rôle
qu'elle ne pouvait pas tenir.

### La mémoire n'est pas un journal de bord — S

Quentin, 08/09 : *« à chaque fois qu'une routine fait son job, elle crée une
mémoire et on s'en sort pas »*. Compté en base, sur 37 faits :

| Ce que c'est | Combien |
|---|---|
| Journaux de routines | **13** — « Nodal-Agents latest version: v0.8.x » ×7, « AcmeCorp SDK release watch » ×6 |
| Journaux d'actions | 2 — « Note Tyranids.md créée », « Dossier Warhammer 40000 créé » |
| Ce que l'agent sait de Quentin | 16 visibles — langue, fuseau, ComfyUI, délégation à Prompt-Master… |

Plus d'un tiers de la table est du compte rendu. La routine AcmeCorp a laissé
six lignes à elle seule : « initial state recorded on first run », puis
« updated state (01:25) », puis « latest release as of 01:25 »… une par
exécution. Ce qui sauve l'écran aujourd'hui, c'est que le curateur finit par les
archiver — une seule des 13 est encore visible. Il amortit le bruit, il
n'empêche rien, et il amortit aussi les vraies mémoires.

**Un filtre traiterait le symptôme.** Le point 1 coupe la source : après lui une
routine n'écrit plus dans la mémoire, elle écrit son état. Ce qui reste à faire
tient en deux gestes :

- **Ranger le passé** : les 13 lignes de journal existantes ne remontent plus
  dans la page Memories. Archivées, pas détruites — un fait supprimé pour de
  bon est exactement ce qui a causé le doublon.
- **Poser le principe dans l'écran** : la page Memories montre ce que l'agent
  sait de l'utilisateur. Si un journal doit rester consultable, c'est derrière
  un filtre éteint par défaut, jamais dans la liste principale.

*Preuve* : après un run de routine, la page Memories affiche exactement le même
nombre de faits qu'avant.

## PR A — le fil dit la vérité

### 1 · Ce qu'un agent dit dans un chat appartient au fil de ce chat — M

Aujourd'hui un tour de fil est un job. Un job de routine n'appartient à aucun
fil, et **un même run peut parler dans plusieurs chats** — celui du 08/09 a
écrit sur Discord *et* sur Telegram. Le tour ne peut donc pas être le job : il
doit être l'**envoi**, rattaché au fil du chat où il part.

`resolveConversation` sait déjà désigner le fil d'un chat. Ce qui manque, c'est
que l'envoi l'appelle et laisse une trace lisible par `thread-history`.

⚠️ **À vérifier avant de coder** : ce que ça fait des routines qui écrivent dans
un chat sans que personne n'y réponde jamais — un fil qui grossit d'un tour par
jour sans interlocuteur. Le budget de relecture doit rester borné.

*Preuve* : après un run de routine qui annonce quelque chose, le tour suivant de
l'utilisateur dans ce chat rejoue l'annonce. Aujourd'hui il ne la rejoue pas —
c'est la mutation qui doit rougir.

### 2 · Un envoi rend « envoyé » — S

Le modèle reçoit `{sent: true}`. L'identifiant reste côté runner, où il sert
(receipt de l'outbox). Rien de ce que le modèle reçoit ne doit ressembler à un
message.

*Preuve* : rejouer le tour du 08/09 — le modèle ne produit plus de tour sur
« 2311 ».

### 3 · La page Chat sépare les canaux des conversations — M

Deux tableaux, l'un au-dessus de l'autre.

- **En haut, les canaux.** Une ligne **par chat**, pas par canal : Telegram peut
  avoir un privé et des groupes, Discord plusieurs salons. Pas de titre tiré
  d'un message — le nom du chat (on sait déjà le lire : `list_conversations`
  rend « #announcements »), sinon l'identifiant. Ces fils ne se ferment jamais
  et ne se nettoient pas.
- **En bas, les conversations du dashboard.** Jetables, créées par « New
  conversation », renommées par l'IA.

Ça règle du même coup le titre figé : un fil Telegram de dix jours s'appelait
« Fais-moi une app en HTML, en récupérant l'API de IGDB » parce que
`touchConversation` (`conversation-id.ts:167`) pose le titre au premier message
et ne le change jamais. Nommé par son chat, le problème disparaît — et le
titrage IA, qui ne couvre que le dashboard (`run-chat-turn.ts:577`), n'a pas à
être étendu aux canaux.

### 4 · Le fil descend tout seul — S

Aujourd'hui **rien ne fait défiler le fil**. `scrollIntoView` / `scrollTop`
n'apparaissent nulle part dans les écrans de conversation — seulement dans le
panneau de logs (`ServiceLogsPanel.tsx:78`) et l'onboarding
(`OnboardingFlow.tsx:329`), qui l'ont chacun réimplémenté dans leur coin.

Conséquence : un message qui arrive se pose sous le bord bas de la zone
visible, contre la saisie, et Quentin doit faire défiler à la main pour lire ce
qu'il vient de recevoir. La charpente, elle, est correcte — les trois écrans
partagent `ThreadScreen`, où la saisie est hors de la zone qui défile.

Deux règles, celles de n'importe quelle messagerie :

- à l'ouverture d'un fil, on est en bas ;
- un message qui arrive fait descendre le fil **seulement si on était déjà en
  bas**. Remonter dans l'historique doit tenir : c'est ce que fait déjà le
  panneau de logs, à 40 px près.

⚠️ **À vérifier à l'écran** : si un message est réellement rendu *derrière* la
saisie et pas seulement hors champ, c'est un second défaut, de géométrie
celui-là. La capture le dira ; le correctif n'est pas le même.

*Preuve* : Playwright — ouvrir un fil de 30 tours, le dernier message est
visible sans toucher à rien ; remonter de 500 px, envoyer un message, la
position ne bouge pas ; revenir en bas, envoyer, ça suit.

## L'ordre, et pourquoi

**B avant A.** Le doublon est le seul des trois qui soit visible par d'autres
que Quentin : il a laissé deux annonces identiques dans un Discord public. B est
aussi la plus petite et la plus autonome.

Puis A. À l'intérieur de A : le point 2 d'abord (une heure), puis 1, puis 3.

**Et cette pierre passe avant « Créer, c'est prouver »** : un agent qui
republie une annonce publique coûte plus cher qu'un nom de fichier tronqué.

## Ce que ça ne contient pas

- **Le coût d'un tour de chat.** Toujours la PR d'après.
- **Une alerte quand on supprime une mémoire dont dépend une routine.** Après
  B, plus aucune routine n'en dépend : l'alerte n'aurait plus d'objet.
- **`/new` découvrable depuis un canal.** Une fois les canaux séparés dans
  l'écran, la question se repose différemment — à trancher ensuite.

## Un risque sur la boucle de revue

`codex review` est le seul relecteur autorisé pour une PR (CLAUDE.md), et
**Quentin signale que la dernière version refuse de coder depuis la CLI**
(constaté par lui le 08/09 ; version installée et dernière publiée :
`codex-cli 0.153.4`).

Ça ne bloque pas la rédaction de ces plans, mais ça bloque la **fermeture**
d'une PR : la règle dit que si `codex` manque ou échoue, on le dit et on
s'arrête — jamais de repli sur un relecteur Claude, qui serait un fallback
silencieux (invariant #4). À éprouver avant d'ouvrir la première PR, pour
savoir si la boucle review → fix → review tient encore.

## Ce que la livraison a appris (PR #47)

- **La table `schedule_state` a un plafond de clés, et ce plafond ne pouvait pas
  être une contrainte SQL.** Une contrainte sait borner une longueur, pas un
  nombre de lignes : il a fallu un verrou consultatif par routine (revue Codex,
  passe 1, constat 1).
- **Deux doutes du plan étaient infondés**, vérifiés plutôt que supposés : le
  bloc `## Runtime` est dans la moitié volatile du prompt (jamais servi périmé
  par le cache), et un worker délégué n'hérite pas du `schedule_id` (il n'obtient
  donc pas l'outil).
- **La routine n'était pas la seule source de journaux en mémoire.** Le skill
  `obsidian` livré avec le produit invitait lui-même à un `save_memory` « I wrote
  X.md in the vault » quatre lignes avant d'interdire la pratique. Corrigé, et la
  règle posée dans le socle commun à tous les agents.
- **Le rangement des 13 lignes existantes reste ouvert** : aucun marqueur en base
  ne distingue un journal d'une connaissance. Les repérer demanderait une
  heuristique textuelle — une règle inventée. C'est un geste de Quentin, depuis
  la page Memories.
- **Le correctif répétait le bug qu'il répare** (revue Codex, passe 5, le
  constat le plus utile des six). Le bloc annonçait « genuinely its first run »
  dès que l'état était vide. Or la table naît vide : la première exécution de
  chaque routine EXISTANTE, après la mise à jour, l'aurait lue comme un premier
  run — et une routine qui annonce aurait réannoncé. Le bloc dit maintenant ce
  qu'il sait et rien de plus : « nothing recorded yet. This does NOT mean the
  routine has never run. » Deux assertions NÉGATIVES gardent le piège fermé.
- **Une garde n'est une garantie que si elle couvre tous les chemins.** Celle
  qui interdit deux exécutions simultanées d'une même routine ne vivait que
  dans le cron ; l'outil `run_schedule` et le bouton « Run now » inséraient sans
  regarder. Il a fallu deux passes de revue pour trouver les deux autres.
- **La course reste ouverte, et c'est dit.** Les trois chemins lisent puis
  insèrent, sans verrou commun : deux lancements simultanés passent encore. La
  fermer demande un index unique partiel, donc une migration qui doit décider du
  sort des installations où deux runs vivants coexistent déjà. Au backlog du
  harnais, pas bâclé ici.
- **La consigne de la routine de Quentin dit encore d'utiliser `query_memory`.**
  C'est de la donnée, pas du code. À mettre à jour depuis /automations, ou à me
  demander explicitement.
