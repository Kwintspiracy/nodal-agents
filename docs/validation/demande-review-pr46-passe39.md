# Demande de review — PR #46, passe 39 (P10b : « où écrire ? », `register_project`)

Périmètre : **un commit**, `baea7599` (19 fichiers). Codé par un agent Opus sur spec, relu par
l'orchestrateur, 7 mutations rouges. L'arbre de travail est propre.

- `packages/tools/src/builtin/register-project.ts` (neuf) + `tests/builtin/register-project.test.ts`
  (9 cas) ; `projects/register.ts` (`kind` obligatoire, `displayName` à l'INSERT seulement —
  jamais dans le `set`) ; `projects/attach.ts` et `apps/runner/src/bootstrap/backfill-registered-projects.ts`
  passent `kind: 'code'` ; `builtin/index.ts` (registre, `ALWAYS_ON_TOOLS`, `ALWAYS_ON_TOOL_DOCS`).
- `packages/shared/src/project-subfolder.ts` (+ test) : `isSafeSubfolder`, `previewProjectPath`
  remontés depuis `apps/web/src/lib/project-path.ts` (supprimé, avec son test) ;
  `apps/web/src/lib/project-actions.ts` et `spaces/NewProjectButton.tsx` importent de shared.
- `packages/orchestration/src/system-prompt.ts` : sans projet courant, le bloc `## Conversation`
  dit de demander avec `ask_user` avant d'écrire un DOCUMENT, d'offrir les projets déclarés et
  « New project: <name> », puis `register_project`, puis écrire ; le code à manifeste se déclare
  seul ; liste « Registered projects you can offer as options » (plafond
  `REGISTERED_PROJECTS_IN_PROMPT` = 12, `sanitizePromptField`) ; `router/internal-tools.ts`
  (label, risque) ; `index.ts` (export).
- `apps/runner/src/job/conversation-id.ts` : `listRegisteredProjects` (déclarés, non masqués,
  plafonnés) chargés SEULEMENT quand le fil n'a pas de projet courant ; test.

## Ce que P10b pose (plan, P10, moitié « où écrire ? »)

La règle de Quentin : « Hors de tout projet, l'agent demande OÙ avant d'écrire ; la réponse
crée le projet. Rien ne se crée en silence. » Depuis P5b, un dossier à manifeste où du code
atterrit se déclare seul : la question ne porte que sur les DOCUMENTS. Flux : `ask_user`
(options = projets déclarés + « New project: … ») → l'utilisateur choisit → `register_project`
(dossier créé sous le terrain, ligne `code_projects` `kind = 'documents'`, `registered_from =
'conversation'`, job ET conversation rattachés aussitôt par la contenance d'une cible
`office_file`) → l'agent écrit dedans → Spaces liste le projet.

La garde : `computeApproval` de `register_project` rend `require_approval` SAUF si une ligne
`approval_requests` `kind = 'question'`, `status = 'approved'` existe pour CE job. Sous
`fully_autonomous` le hook n'est pas appelé (choix explicite du propriétaire, même mécanique
que l'écrasement gaté de `file_write`).

## Mesuré

- register-project 9 ; system-prompt 37 ; conversation-id 34 ; project-subfolder 5 ; seam,
  attach, cards ; suites complètes (agent) tools 918, orchestration 239, runner 1327, shared
  475, web 1209 (+ un test e2e qui passe seul) ; typecheck 33/33 ; deps 0 ; lint 0 erreur.
- Mutations rouges puis restaurées (orchestrateur) : garde « question répondue » retirée (3) ;
  rattachement hors cible (3) ; question DÉCLINÉE suffit (1) ; `display_name` remis dans le
  `set` (1 — cas AJOUTÉ par l'orchestrateur : une ligne de comptabilité renommée depuis
  l'onglet Code garde son nom en devenant projet, car le `setWhere` ne protège que les
  lignes déjà déclarées) ; consigne du prompt retirée (2) ; lignes de comptabilité proposées
  comme projets (1). Agent : 5 mutations de plus.

## Questions, par priorité

### P0 — ce qui casserait la règle « rien ne se crée en silence »

1. **La garde est portée au JOB, pas à la question** : n'importe quelle question répondue dans
   le job (« quelle couleur ? ») déverrouille `register_project`. Assumé dans la spec (le
   propriétaire a été consulté dans ce job). Un scénario où c'est un vrai contournement — un
   agent qui pose une question anodine pour créer ensuite un projet sans demander « où » ?
   Une alternative sans coupler `register_project` au contenu de la question ?
2. **La reprise après une approbation ORDINAIRE** (sans question) : la porte suspend
   `register_project` (`computeApproval`) ; à la reprise, `executeResolvedApprovals` rejoue
   l'outil avec la règle synthétique `resume-bypass` → `matchedRule` est posée →
   `computeApproval` n'est pas appelé → l'outil s'exécute. Vérifier que rien d'autre ne le
   re-gate, et que `mutatesWorkspace: false` ne fait pas manquer une étape (intention,
   instantané) que le seam aurait posée pour un outil qui crée un dossier.
3. **`resolveAndCheckPath` pour un dossier qui n'existe pas encore** : la résolution accepte un
   chemin absent (elle sert aussi à `file_write` avec `create_dirs`) ? Un lien symbolique dans
   le terrain qui sort du terrain : la vérification physique de Spaces (`realpath` de
   l'ancêtre existant) est-elle appliquée ici aussi, ou seulement la lexicale ?

### P1

4. **Le terrain lui-même accepté** (`path` = le terrain, `subfolder ''`) : un agent peut
   déclarer TOUT son terrain comme projet de documents d'un appel. Spaces l'autorise déjà —
   mais depuis une conversation, sans clic, est-ce voulu ? (Arbitrage P5 « terrain = projet »
   toujours ouvert.)
5. **La consigne du prompt** est du texte de plateforme dans `## Conversation` (comme « Current
   project: none yet ») : elle dit à l'agent QUAND demander et QUOI appeler. Elle ne parle pas
   à l'utilisateur. Un chemin où elle fait poser une question inutile (un `.md` dans un dépôt
   à manifeste = du code ? un fichier de config ?) — la frontière « document » est-elle
   assez nette pour le modèle ?
6. **`listRegisteredProjects` masque `hidden`** : un projet masqué n'est pas proposé, mais
   `register_project` sur son dossier le retrouve (`created: false`) — cohérent avec « masquer
   n'est pas désinscrire » ?
7. **Un chemin ABSOLU est refusé** (`unsafe_path`) alors que `file_write` l'accepte : dit dans
   le rapport de l'agent. Acceptable pour un outil qui adresse un sous-dossier ?

### P2

8. `REGISTERED_PROJECTS_IN_PROMPT` = 12 mais `ask_user` n'accepte que 6 options : la consigne
   dit-elle au modèle de choisir les plus pertinents, ou risque-t-il d'appeler `ask_user` avec
   12 options et d'échouer à la validation ?

## Ce qui n'est PAS attendu

Le style, le nommage. Un constat désigne un fichier, une ligne, et ce qui casse.
