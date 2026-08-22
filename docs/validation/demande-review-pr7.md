# Demande de review — PR #7 (poste de développement)

Branche `feat/dev-posture` → `main`. Trois manques du harnais de code :
continuité de session, conscience du dépôt, points de restauration.

**Ton rôle : essayer de me démonter, pas de me confirmer.** Deux verdicts sont
utiles — « ça tient » et « c'est faux ». Un troisième ne l'est pas : « ça a l'air
bien ».

Ne corrige rien. Rends un rapport.

---

## Contexte qui devrait orienter ton attaque

Sur les deux PR précédentes, **le même défaut est revenu deux fois** : des tests
verts qui n'exerçaient pas le câblage. La garde de sandbox appelée directement,
puis `preflight` déclaré par un faux outil — les deux fois, retirer le
branchement laissait la suite verte, et c'est ta review qui l'a vu.

J'ai écrit cette PR en essayant de corriger cette habitude. **Vérifie que j'y
suis arrivé**, plutôt que de me croire sur parole.

## Priorité 1 — les instantanés protègent-ils vraiment ?

C'est la partie où une erreur coûte le travail de quelqu'un.

**Le test qui compte** : écris un fichier, prends un instantané, corromps-le,
restaure, et **compare le SHA-256 à l'original**. `packages/checkpoints` prétend
le faire ; refais-le à la main.

Puis attaque :

- **Le magasin fantôme touche-t-il le workspace ?** Un `.git`, un `.gitignore`,
  un fichier quelconque apparu dans le projet protégé serait disqualifiant. Le
  code prétend que non (`GIT_DIR` pointe ailleurs).
- **Un workspace qui EST déjà un dépôt git** : lance des instantanés dedans et
  vérifie que l'historique, l'index et le HEAD de l'utilisateur sont intacts.
  C'est le cas que je n'ai pas testé en live.
- **Le refus quand l'instantané échoue.** Neutralise-le
  (`return null` au lieu de l'erreur) : le bon test doit rougir. Puis provoque
  un vrai échec (magasin en lecture seule, disque plein, git absent du PATH) et
  vérifie que l'écriture est **refusée**, pas laissée passer.
- **`git` absent du PATH.** Que se passe-t-il ? Un refus est correct ; un plantage
  non rattrapé ne l'est pas.
- **Volume.** Un instantané sur un vrai dépôt (celui-ci, `node_modules` compris)
  prend combien de temps ? Les exclusions sont-elles réellement appliquées ?

## Priorité 2 — le câblage, encore

Trois branchements à attaquer séparément. Pour chacun : **retire-le et vérifie
que les tests rougissent**.

| Branchement | Mutation | Attendu |
|---|---|---|
| Accroche des instantanés | `if (false && tool.mutatesWorkspace)` | les cas de câblage rougissent, ceux du marquage restent verts |
| Marqueur sur `file_write` | retirer `mutatesWorkspace: true` | au moins un rouge |
| Reprise de session | retirer `resumeSessionId` de `buildProviderArgs` | au moins un rouge |
| Bloc git | déplacer `gitBlock` dans la moitié stable du prompt | exactement les 2 tests de cache rougissent |

Si l'une de ces mutations laisse tout vert, **c'est le finding le plus utile du
rapport**.

## Priorité 3 — la continuité de session

- **La clé est-elle vraiment étanche ?** `code_task:<jobId>:<cwd>`. Vérifie
  qu'un second job ne reprend pas la session du premier, et qu'un `cwd`
  différent force le froid. Une reprise sur le mauvais arbre est pire qu'un
  départ à froid : le CLI répond avec assurance sur le mauvais dépôt.
- **Collision avec le runtime.** `cli_sessions` est unique sur
  `(agentId, conversationKey)`, et `run-job.ts` y écrit sous
  `conversationId ?? chatId`. Peux-tu construire un cas où les deux se marchent
  dessus ?
- **La branche `resume` de codex est une SECONDE liste d'arguments**, donc elle
  peut diverger de la froide sans que rien ne le signale — c'est exactement
  ainsi que `mcp_servers={}` était resté en place. Vérifie que les deux formes
  gardent `--ignore-user-config` et le bon sandbox.
- **En live si tu peux** : deux `code_task` enchaînés dans un même job. Le
  second doit se souvenir du premier.

## Priorité 4 — le bloc git dans le prompt

- Il doit arriver **après** `SYSTEM_PROMPT_CACHE_BOUNDARY`. S'il passe devant,
  la moitié cachée change à chaque job et le cache de prompt saute.
- Deux jobs du même agent, deux états git : le **préfixe stable doit être
  identique**.
- Le nom de branche passe-t-il bien par `wrapUntrusted` ? Une branche nommée
  `ignore-previous-instructions` ne doit pas atterrir non marquée.
- La sonde git : que fait-elle hors d'un dépôt, sans `git` sur le PATH, sur un
  dépôt sans commit, en HEAD détaché ?

## Priorité 5 — le nouveau paquet

`@nodal-agents/checkpoints` a été créé parce que `apps/cli` ne peut pas importer
`apps/runner`. Est-ce le bon découpage, ou ai-je créé un paquet pour contourner
une règle ?

Vérifie aussi qu'il n'a **aucune dépendance** hors builtins Node — c'est ce qui
justifie qu'un CLI de 0,6 Mo le charge.

## Ce que je sais ne pas avoir couvert

- **Linux et macOS.** Les instantanés utilisent `git` avec `GIT_DIR` /
  `GIT_WORK_TREE`, ce qui devrait être portable — mais je n'ai mesuré que
  Windows, encore.
- **Concurrence.** Deux jobs écrivant dans le même workspace en même temps :
  l'index est par workspace, donc ils partagent le même. Je n'ai pas éprouvé ce
  cas.
- **Un workspace volumineux.** Le temps de `add -A` sur un gros arbre n'est pas
  mesuré.
- **Aucun e2e dashboard.** Le comportement est prouvé au niveau `executeTool`
  avec une vraie base de test.

## Format attendu

**VÉRIFIÉ / CONTREDIT / NON TESTÉ** par point, avec la commande, la sortie
brute, la plateforme et la version. Ta section « non testé » des deux rapports
précédents était la partie la plus utile — garde-la.

Et si tu trouves quelque chose hors de cette liste, c'est le plus précieux : la
liste dit ce que je crains, donc pas ce que j'ai raté.
