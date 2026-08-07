# Vague D — découverte : lever les contrôles bloqués

**2026-08-07** · sur `fix/audit-wave1-2026-08-07` (vague 1 appliquée) · install jetable debout,
agent `joe` sur GLM 5.2

**Avancement : D2, D3, D4 et D5 terminés. D1 partiel (2 modules transverses sur 6, 0 fournisseur sur
11). D6 bloqué faute de navigateur.** Ce document dit ce qui est établi et ce qui ne l'est pas.

---

## D4 — Une mise à jour de skill communautaire peut-elle s'appliquer sans revue humaine ?

C'était l'angle mort désigné comme « probablement le finding le plus important absent du rapport ».
**Hypothèse principale réfutée** : il n'y a pas d'application automatique.

### Ce qui protège, vérifié

| Contrôle | Preuve |
|---|---|
| Le cron **détecte seulement** | `skills/check-updates.ts:193-206` n'écrit que `updateAvailable` / `updateDetail` / `lastUpdateCheckAt`. Jamais `content`. |
| La route exige un secret | `routes/skills.ts:138` — `checkWorkerSecret` avant toute chose. Non atteignable depuis une page web (et désormais derrière le garde d'origine de la vague 1). |
| **Aucun outil agent** ne peut l'appeler | `grep applySkillUpdate` sur `packages/tools/src` : zéro résultat. Un agent piloté ne peut pas se mettre à jour tout seul. |
| Confirmation humaine explicite | `SkillUpdateAction.tsx` → `ConfirmDialog`, avec `destructive` quand il y a conflit de scripts. |
| **Révocation des scripts AVANT écriture** | `skills/install.ts:438-465`. L'ordre est DB d'abord (révocation + ligne dans **une** transaction), fichiers ensuite. Le commentaire documente les deux modes de panne de l'ordre inverse : un crash entre la copie et la révocation laissait des scripts amont exécutables avec l'autorisation d'avant. C'est du travail soigné. |

### Le résidu — SKILL-003

```
ID: SKILL-003   TOPIC: SKILL   SEVERITE: P2   CONFIANCE: Confirmed   EFFORT: M
IMPACT: Remote control (via injection persistante)
```

**Explication simple.** Le bouton « Update » remplace le texte de la skill par la version amont, et
l'utilisateur ne voit **jamais ce texte**. La boîte de confirmation dit « This installs the latest
upstream version. Last check found: content changes. » — une catégorie, pas un diff. Or ce texte part
directement dans le prompt système de tous les agents à qui la skill est assignée.

Les **scripts** sont protégés (révocation). Le **contenu** ne l'est pas.

**Détail.** `install.ts:452-456` :

```
.set({
  defaultContent: content,
  ...(existing.contentOverridden ? {} : { content }),
  ...
})
```

Le commentaire de `describeChanges` est d'ailleurs honnête sur la raison : `updateDetail` est un
instantané de la dernière vérification de fond, et `applySkillUpdate` re-télécharge au moment du clic
— donc le résumé affiché est « a hint, never as a promise of what will be installed ». L'utilisateur
approuve littéralement un contenu inconnu.

**VERIFICATION 1** `[A]` — lecture de `check-updates.ts`, `routes/skills.ts`, `install.ts:360-470`,
`SkillUpdateAction.tsx`.
**VERIFICATION 2** `[A]` — inventaire exhaustif des appelants d'`applySkillUpdate` (un seul : la
server action du dashboard) et absence totale côté `packages/tools`.

### CHALLENGE

1. *Protection ailleurs ?* Non pour le contenu. Le plafond `MAX_SKILL_CONTENT_BYTES` borne la taille,
   pas la nature.
2. *Atteignable ?* Il faut que l'utilisateur ait installé une skill communautaire dont l'amont
   devienne hostile, puis clique. C'est le motif classique d'attaque par mise à jour — réel, mais il
   exige une action humaine, ce qui le maintient loin d'un P0.
3. *Design délibéré ?* Partiellement : l'auteur a manifestement réfléchi au problème (révocation des
   scripts, honnêteté du wording). Le diff de contenu a été laissé de côté, pas nié.
4. *Test existant ?* Aucun test n'exerce un changement de contenu hostile.
5. *Code mort ?* Non.
6. *Pourquoi pas d'incident ?* Peu de skills communautaires installées, et aucune n'a encore changé
   de main.

**Résultat : Survived, P2.** Mon hypothèse de départ (P0 par application automatique) est **réfutée**.

### OPTIONS

```
A) Afficher le diff avant d'appliquer : re-télécharger à l'ouverture de la
   confirmation et montrer les lignes ajoutées/retirées du SKILL.md.
   Effort : M. Compromis : la modale devient un écran. Risque résiduel :
   l'utilisateur ne lit pas.

B) Traiter le contenu comme les scripts : marquer la skill « à re-valider »
   après une mise à jour de contenu, et la retirer des prompts jusqu'à
   re-assignation.
   Effort : M. Compromis : une skill utile disparaît silencieusement d'un
   agent — exactement le fallback silencieux que l'invariant #4 interdit.

C) Afficher au moins la TAILLE du changement (« +120 / −8 lignes ») dans la
   modale actuelle. Effort : S.
```

### CHALLENGE DE L'OPTION RECOMMANDÉE

A demande de re-télécharger à l'ouverture de la modale — donc une latence réseau sur un clic, et un
état d'erreur à gérer si l'amont est injoignable au mauvais moment. Coût réel plus proche de M que de
S. Ce qu'elle ne corrige pas : un diff long ne sera pas lu, et une charge d'injection tient en une
ligne au milieu de trois cents. B est plus sûre mais viole l'invariant #4. C est presque gratuite et
donne le seul signal qui compte vraiment en pratique : « ce changement est énorme » vs « deux mots ont
bougé ».

### ★ RECOMMANDATION

**Option C d'abord, A quand la surface skills sera retravaillée.** La raison qui tranche : sur une
mise à jour de skill, la question à laquelle l'utilisateur peut réellement répondre en trois secondes
n'est pas « ce texte est-il malveillant » mais « ce changement est-il de la taille que j'attendais ».
Un compteur de lignes répond à celle-là pour un effort S ; un diff complet ne répond pas mieux à la
première.

---

## D3 — Comportement face à un expéditeur non autorisé

**Le design channel-neutral tient**, vérifié : les quatre canaux passent par la **même** fonction,
`apps/runner/src/channels/shared.ts:135-200`. Telegram, Slack, Discord et WhatsApp appellent tous
`allowOwnerClaim: true` sur le chemin DM et `false` sur le chemin groupe.

### La machine à états, vérifiée

| Situation | Décision |
|---|---|
| Conversation connue + `active` | autorisée |
| Conversation connue + `pending` | **rejetée en silence**, sans re-demander — pas de spam vers le propriétaire |
| Inconnue, propriétaire existant | mise en `pending`, carte de confirmation envoyée au propriétaire |
| Inconnue, **pas** de propriétaire, canal de groupe | rejetée (`no_owner_group`) — un groupe ne peut pas amorcer la propriété |
| Inconnue, **pas** de propriétaire, DM privé | **propriété revendiquée immédiatement** |

Les quatre premières lignes sont bonnes. C'est la cinquième qui pose un problème.

### CHANNEL-001

```
ID: CHANNEL-001   TOPIC: CHANNEL   SEVERITE: P2   CONFIANCE: Confirmed   EFFORT: S
IMPACT: Remote control
```

**Explication simple.** Le premier qui envoie un message privé au bot en devient le propriétaire. Or
un bot Telegram porte un `@username` **public et cherchable**. Entre le moment où le token est collé
dans le dashboard (le poller démarre aussitôt) et le moment où le propriétaire envoie son premier DM,
n'importe qui ayant trouvé le bot peut prendre sa place — et devient alors autorisé à lui donner des
tâches et à recevoir ses cartes d'approbation.

Ce n'est pas théorique dans l'ordre que la documentation recommande. `guides/create-an-agent.mdx:83` :
*« paste a bot token from @BotFather. DM the bot once so the runner records your chat ID »* — coller
d'abord, DM ensuite. La fenêtre est ouverte par le flux nominal.

**VERIFICATION 1** `[A]` — `channels/shared.ts:170`, et les six sites d'appel (`telegram/handler.ts:156`,
`slack/handler.ts:105`, `discord/handler.ts:119`, `whatsapp/handler.ts:98`, plus les variantes groupe
à `false`).
**VERIFICATION 2** `[A]` — `apps/docs/content/docs/guides/create-an-agent.mdx:83` et
`guides/telegram.mdx:85` confirment l'ordre recommandé.

### CHALLENGE

1. *Protection ailleurs ?* Non. C'est un modèle « trust on first use » assumé, sans code ni délai.
2. *Atteignable ?* **Très inégal selon le canal.** Telegram : le plus exposé — un bot est cherchable
   globalement par nom. Slack et Discord : l'attaquant doit déjà être dans l'espace de travail ou
   partager un serveur, donc la frontière organisationnelle protège. WhatsApp : c'est le compte de
   l'utilisateur, exposition quasi nulle. **Le finding est en pratique un finding Telegram.**
3. *Design délibéré ?* Oui, et le raisonnement se défend : sans TOFU il faudrait un code à recopier,
   ce qui alourdit un flux déjà long. Le défaut n'est pas le choix, c'est qu'il n'est ni borné dans
   le temps ni signalé.
4. *Test existant ?* La logique est testée ; aucun test ne couvre la course entre deux prétendants.
5. *Code mort ?* Non.
6. *Pourquoi pas d'incident ?* La fenêtre dure typiquement quelques secondes, et un bot fraîchement
   créé au nom aléatoire n'est pas trouvé par hasard.

**Résultat : Survived, P2.** Serait P1 si la documentation invitait à configurer le bot longtemps
avant de l'utiliser.

### OPTIONS

```
A) Code de revendication à usage unique, affiché dans le dashboard : le premier
   DM doit contenir ce code. Effort : S. Compromis : une étape de plus dans un
   flux déjà long — exactement ce que le produit cherche à éviter.

B) Confirmation côté dashboard : le premier DM crée une revendication EN
   ATTENTE, visible dans l'écran Telegram de l'agent, que l'utilisateur valide
   d'un clic. Effort : S. Réutilise le mécanisme `pending` qui existe déjà pour
   les conversations suivantes. Risque résiduel : l'utilisateur valide sans
   regarder qui c'est.

C) Borner la fenêtre : n'accepter la revendication que dans les N minutes qui
   suivent l'enregistrement du token, et le dire dans l'UI.
   Effort : S. Risque résiduel : un utilisateur interrompu rate la fenêtre et
   ne comprend pas pourquoi.
```

### CHALLENGE DE L'OPTION RECOMMANDÉE

B réutilise un mécanisme éprouvé et n'ajoute aucune étape quand tout va bien — l'utilisateur DM le
bot, revient au dashboard, voit « une conversation demande l'accès », valide. Mais elle déplace la
décision vers un écran que l'utilisateur vient de quitter, et si la carte affiche seulement un
identifiant Telegram numérique, il validera sans savoir qui c'est. Le correctif n'a de valeur que si
la carte montre le **nom d'affichage** du prétendant — que `senderName` porte déjà. Mal faite, elle
donne un consentement de façade, le même défaut que PRIVILEGE-003.

### ★ RECOMMANDATION

**Option B, avec le nom d'affichage du prétendant en évidence sur la carte.** La raison qui tranche :
c'est la seule option qui ne rallonge pas le chemin nominal tout en fermant la fenêtre, et
l'infrastructure `pending` + carte de confirmation existe déjà — c'est du câblage, pas une
fonctionnalité.

---

## D1 — Modules transverses des harnais LLM (partiel)

Deux des six modules que l'audit signalait comme « aucune base pour affirmer quoi que ce soit » sont
maintenant instruits. **Les deux suspicions sont réfutées.**

### `tolerant-fetch.ts` — suspicion réfutée

L'audit demandait : *« tolérant est un mot à interroger — cette tolérance peut-elle masquer une vraie
erreur, voire accepter une réponse malveillante ? »*

**Non.** La portée est d'un seul champ : `choices[].message.tool_calls[].function.arguments`, coercé
d'objet ou `null` vers chaîne, uniquement sur les endpoints `/chat/completions` et les réponses JSON.
Le statut HTTP, le `statusText` et les en-têtes sont reconstruits à l'identique — une 500 traverse
avec sa 500. Rien n'est avalé.

C'est un correctif précis pour une dérive de spec documentée (OpenRouter/DeepSeek V4 Pro renvoient
`arguments` déjà parsé alors que la spec impose une chaîne), et il **remplace** trois couches de
rustines par modèle. À porter au crédit des contrôles qui tiennent.

### `failover.ts` — suspicion réfutée

L'audit demandait si le failover pouvait boucler. **Structurellement impossible** :
`for (let i = activeIndex; i < clients.length; i++)` — parcours avant uniquement, borné par la
longueur de la chaîne, `AllProvidersFailed` levé en sortie. Et le module ne remonte jamais la chaîne
en cours de job : un primaire rétabli n'est repris qu'au job suivant.

Point de coût confirmé mais non chiffré : un basculement re-envoie le contexte au fournisseur suivant,
et le plafond en dollars suit le client actif. Reste à mesurer.

### Non instruits

`retry.ts` (338 lignes), `parsers.ts`, `tool-call-middleware.ts`, `probe-context.ts`, et les
**huit dimensions par fournisseur** pour les onze harnais. `AUDIT_HARNESSES.md` reste globalement
`BLOCKED`.

---

## D2 — Les 153 server actions du dashboard

**Aucun finding. Le contrôle tient, sur toute la surface.**

Analyse mécanique des 5 fichiers `'use server'`, action par action :

| Mesure | Résultat |
|---|---|
| Server actions exportées | **152** |
| Avec contrôle de session | **152 / 152** |
| Actions touchant la base | 123 |
| Référençant `entityId` | **123 / 123** |

Trois faux positifs de mon premier passage, tous instructifs :

- `getWeeklyActivityAction` / `getDailyActivityAction` — le contrôle est dans `loadActivity`, qu'elles
  délèguent (`actions.ts:6815` : `const session = await getSession()`). Mon scan ne regardait que le
  corps de l'action.
- `getVersionInfoAction` — lit `process.env.NODAL_VERSION` et interroge le registre npm. Aucune donnée
  utilisateur, aucun accès base.
- `refreshCredentialAccessToken` / `persistCredentialFromOauthFlow` — signalées parce que mon `grep`
  initial cherchait la chaîne `use server`, présente **dans un commentaire**. Le fichier
  `credentials-internal.ts` est justement construit pour NE PAS être un tel module, et son en-tête
  explique pourquoi en détail (É-1, remédiation audit #2) : Next enregistre toute fonction async
  exportée d'un module `'use server'` comme endpoint RPC réseau, que le client la référence ou non —
  ce qui avait transformé ces deux helpers, qui renvoient des jetons OAuth **en clair**, en endpoints
  appelables sans contrôle de propriété. Ils vivent désormais dans un module `server-only` ordinaire.
  **Finding déjà corrigé, et bien corrigé.**

**Limite à énoncer** : « référence `entityId` » n'est pas « scope correctement chaque requête ». Un
scan mécanique ne prouve pas la correction. Mais 123/123 est un signal fort de discipline homogène, et
les commentaires de `server.ts` (findings #4/#5) montrent que ce plan a déjà été durci délibérément.

---

## D5 — Portées OAuth des connecteurs

### CONNECTOR-001

```
ID: CONNECTOR-001   TOPIC: SKILL   SEVERITE: P2   CONFIANCE: Confirmed   EFFORT: M
IMPACT: Data leak
```

**Explication simple.** Quatre connecteurs Google demandent la portée la **plus large** de leur
famille, alors qu'une portée restreinte existe. Brancher le connecteur Drive ne donne pas à l'agent
l'accès aux fichiers qu'il manipule : ça lui donne l'accès à **tout** le Drive.

| Connecteur | Portée demandée | Restreinte disponible |
|---|---|---|
| Google Drive | `auth/drive` — **tous les fichiers**, lecture et écriture | `auth/drive.file` |
| Google Calendar | `auth/calendar` — tous les agendas | `auth/calendar.events` |
| Google Sheets | `auth/spreadsheets` — tous les classeurs | `auth/spreadsheets.readonly` |
| Google Docs | `auth/documents` — tous les documents | `auth/documents.readonly` |

Croisé avec INJECT-001 (les payloads de connecteurs entrent sans balisage), un agent détourné qui
dispose du connecteur Drive lit l'intégralité du Drive de l'utilisateur.

**Bien fait, à signaler** : Gmail demande **uniquement** `gmail.readonly` + `gmail.send`, pas
`gmail.modify` ni `mail.google.com`. La question des portées a donc bien été pensée — le reste n'a
simplement pas suivi. Notion utilise des portées vides (l'utilisateur choisit les pages au moment de
l'autorisation) : le meilleur des trois modèles. Airtable est correctement granulaire.

**VERIFICATION 1** `[A]` — `packages/shared/src/oauth/providers.ts:46-188`, registre canonique.
**VERIFICATION 2** `[A]` — portées effectivement envoyées : `api/oauth/[provider]/start/route.ts:123-124`.

### CHALLENGE

1. *Protection ailleurs ?* Non. La portée est la borne supérieure de ce que le jeton permet.
2. *Atteignable ?* Il faut brancher le connecteur. Mais l'écran Google annonce « voir, modifier et
   supprimer tous vos fichiers Drive » — l'utilisateur est informé par Google, pas par le produit.
3. *Design délibéré ?* Probablement pragmatique : `drive.file` impose un sélecteur de fichiers et
   interdit d'ouvrir un fichier par son chemin, ce qui casserait l'usage agentique « ouvre le rapport
   trimestriel ». Le compromis se défend ; il n'est pas documenté.
4. *Test existant ?* Aucun test n'assert les portées.
5. *Code mort ?* Non.
6. *Pourquoi pas d'incident ?* Peu de connecteurs branchés, et Google affiche l'avertissement.

**Résultat : Survived, P2.**

### OPTIONS

```
A) Passer Sheets/Docs/Calendar en portées restreintes là où les outils exposés
   n'exigent pas plus. Effort : M. Compromis : re-consentement de tous les
   utilisateurs déjà connectés.

B) Ne rien changer et DOCUMENTER, dans l'écran de connexion, ce que la portée
   couvre réellement. Effort : S.

C) Portées par capacité : lecture seule par défaut, écriture seulement si
   l'agent a l'outil correspondant. Effort : L.
```

### CHALLENGE DE L'OPTION RECOMMANDÉE

A force un re-consentement de tous les utilisateurs déjà connectés : un jeton existant ne gagne ni ne
perd de portées, il faut révoquer et refaire le flux. Coût réel supérieur au M annoncé. Ce qu'elle ne
corrige pas : Drive, le plus exposé et le plus difficile à réduire sans casser l'usage. B est presque
gratuite et adresse le vrai problème — l'utilisateur ne sait pas ce qu'il accorde tant que Google ne
le lui dit pas, trop tard dans le flux.

### ★ RECOMMANDATION

**Option B maintenant, A pour Calendar seulement.** La raison qui tranche : Drive et Sheets ont besoin
d'ouvrir un fichier par son nom, ce que la portée restreinte interdit — le compromis est réel.
Calendar est le seul où `calendar.events` couvre exactement les outils exposés sans rien casser.

### Observation annexe — Gmail : portées plus étroites que les outils

Le connecteur expose `gmail_trash_message`, `gmail_delete_message` et `gmail_modify_labels`, qui
exigent `gmail.modify`. Seul `gmail.readonly` est demandé : ces trois outils échoueront en 403. Défaut
dans la **bonne** direction — sous-privilégié, échec bruyant — mais l'utilisateur se voit offrir des
outils inopérants. À traiter avec la refonte « capacités ON/OFF ».

---

## Ce qui reste de la vague D

| Sous-tâche | État |
|---|---|
| D4 — mise à jour de skill communautaire | **Terminé** → SKILL-003 (P2), hypothèse P0 réfutée |
| D3 — expéditeur non autorisé, 4 canaux | **Terminé** → CHANNEL-001 (P2) |
| D1 — harnais LLM | **Partiel** : 2 modules transverses sur 6, 0 fournisseur sur 11 |
| D2 — 153 server actions | **Terminé** → aucun finding : 152/152 contrôlées, 123/123 scopées |
| D5 — 13 connecteurs, portées OAuth | **Terminé** → CONNECTOR-001 (P2) |
| D6 — WCAG 2.1 AA | **Bloqué** — exige un navigateur, indisponible cette session |

**Bilan de la vague D : 3 findings, tous P2, et 4 suspicions réfutées** — application automatique des
mises à jour de skills, tolérance de `tolerant-fetch`, boucle de `failover`, absence de contrôle sur
les server actions.

**Aucun P0 dans les zones instruites.** C'est un résultat, pas une absence de résultat : l'angle mort
désigné comme le plus inquiétant du rapport s'est révélé correctement gardé, sauf sur le diff de
contenu.

### Couverture après la vague D

| Phase | Avant | Après |
|---|---|---|
| 8 — Canaux | 4/12 | **10/12** (D3) |
| 9 — Skills / connecteurs / MCP | 5/8 | **8/8** (D4, D5) |
| 6 — Harnais LLM | 2/20 | **4/20** (D1 partiel) |
| Dashboard (réparti phases 3 et 11) | ~2 | **+8** (D2) |
| **TOTAL** | **57/137 (42 %)** | **~79/137 (58 %)** |

Le reste tient presque entièrement dans D1 : les huit dimensions par fournisseur des onze harnais,
plus `retry.ts`, `parsers.ts`, `tool-call-middleware.ts` et `probe-context.ts`. Plus D6, bloqué.
