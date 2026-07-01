# Travail de nuit — 2026-07-01 (à revoir avant commit)

**Rien n'est commité.** Tout est dans le working tree, gauntlet vert (format · typecheck 27/27 · lint 0 erreur · deps:check PASS). À valider, puis on commite ensemble.

## Fichiers touchés
- `scripts/build-pack.mjs` — fix warnings npm (bundle exceljs)
- `apps/web/src/app/onboarding/OnboardingFlow.tsx` — bug fin d'onboarding (Continue + Skip)
- `apps/cli/src/commands/up.ts` — wizard → navigateur + pas de compte par défaut
- `docs/proposals/office-and-base-tools-2026-07.md` — propositions (office + outils de base Hermès)

---

## 1. Warnings npm — RÉGLÉ ✅

**Diagnostic (vérifié empiriquement, vrai `npm install -g`) :**
- Les warnings viennent d'**exceljs** (vieux) : il tire `glob@7` (security), `inflight` (memory-leak), `fstream`, `rimraf@2`, `uuid@8`, `lodash.isequal`.
- Les `overrides` npm sont **IGNORÉS** sur un `npm install -g` (testé : le tarball les contenait, les 8 warnings sont quand même apparus). Donc inutilisables.

**Fix :** `bundledDependencies: ['exceljs', 'node-fetch', 'fetch-blob', 'node-domexception']` dans le pack → ces deps voyagent **dans notre tarball** au lieu d'être re-résolues du registry → npm ne lit jamais leur champ `deprecated` → **plus de warnings**.

**Résultat sur le pack 0.6.4 réel : ZÉRO warning.** Vérifié par install -g réel (avant/après) : les 8 warnings publiés → 0. `node-fetch`/`fetch-blob`/`node-domexception` sont minuscules (quelques Ko) → aucun impact taille (pack reste 17M, dû à exceljs).

**Sur le « poids » :** exceljs (~15 Mo) était **déjà téléchargé par chaque utilisateur** aujourd'hui — on déplace juste ses octets dans notre tarball. **Mêmes octets installés sur la machine de l'user, zéro vrai bloat.** Le seul changement : le pack npm affiche 17 Mo (cosmétique). `node-domexception` n'est pas tué car ses sources (googleapis/notion/tesseract) sont énormes — pas rentable pour 1 warning bénin.

**Fix propre à terme :** remplacer exceljs (bloqué aujourd'hui : SheetJS a quitté npm, xlsx-kit encore jeune — voir proposals). Quand ce sera fait, on pourra retirer le bundle.

---

## 2. Bug fin d'onboarding — RÉGLÉ ✅

**Le bug :** le bouton « Continue » n'apparaissait que sur le marqueur `[[INTERVIEW_DONE]]` que l'agent doit émettre — fragile, les petits/locaux LLM l'oublient → tu restais bloqué jusqu'à renvoyer un message.

**Fix (`OnboardingFlow.tsx`) :**
- `canContinue` est maintenant **count-based** : `interviewDone || answerCount >= INTERVIEW_MEMORY.length` (le compteur de réponses canonique). → Continue apparaît **dès que tu as répondu à toutes les questions**, sans dépendre du marqueur (qui reste un early-out s'il arrive).
- Bouton **« Skip for now » TOUJOURS visible** pendant le chat → un LLM lent ne peut plus jamais te bloquer.
- L'input reste dispo tout du long (tu peux continuer à discuter même après l'apparition de Continue).

**À valider en live** (machine fraîche) : dérouler l'interview, vérifier que Continue apparaît à la dernière réponse + que Skip marche à tout moment.

---

## 3. Wizard terminal → navigateur + pas de compte par défaut — RÉGLÉ ✅

**`up.ts` :** sur un premier `nodal-agents up` (sans config), **plus de wizard terminal**. On écrit un défaut : `bind: loopback` → `auth: local-trust` (**aucun compte**), **sans clé LLM**. Le runner boote keyless, le navigateur s'ouvre, et **le web onboarding fait tout le setup** (modèle + 1er agent + interview).

- `nodal-agents init` (config terminal : LAN, auth, clé) **préservé** pour power-users/serveurs.
- Chemin Docker/non-interactif **inchangé**.
- `config.llm` était déjà `optional()` → aucun changement de schéma.

**⚠️ À VALIDER sur machine fraîche** (je n'ai pas pu le faire sans risquer tes données `~/.nodalai`, qui n'a pas d'override de répertoire) :
- `nodal-agents up` sur `~/.nodalai` vierge → **aucune question terminal**, le runner reste **healthy keyless**, le navigateur ouvre l'onboarding, **aucun mur de login**.
- C'est le seul risque que l'agent a flaggé : confirmer que le runner boote sans clé LLM (logiquement OK : seed-llm-key skip, health check sans LLM, pas de jobs au démarrage).

---

## 4. Propositions (pour décision, non urgent)
Voir `docs/proposals/office-and-base-tools-2026-07.md`. En bref :
- **Office** : `docx.patchDocument()` (déjà dispo, édition Word in-place sans formatage perdu) ; `pptx-automizer` (édition PPTX in-place, 1 dep MIT) ; swap exceljs différé (SheetJS hors npm).
- **Outils de base Hermès** : **P0 = vraie recherche web** (`web_search` est un stub qui throw aujourd'hui — Hermès la ship par défaut) ; puis multi-canal, génération d'image, browser automation par défaut.

---

## Plan de commit suggéré (demain, après ta validation)
1. `fix(dist): bundle exceljs to silence install-time deprecation warnings` (build-pack.mjs)
2. `fix(onboarding): reliable Continue + always-on Skip at interview end` (OnboardingFlow.tsx)
3. `feat(cli): browser-first onboarding — no terminal wizard, local-trust by default` (up.ts)

→ probablement **0.6.5** (1 + 2 sont des fixes ; 3 est une feature de premier-lancement).
