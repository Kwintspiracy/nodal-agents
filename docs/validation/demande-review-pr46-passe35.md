# Demande de review — PR #46, passe 35 (le P0 et les deux P1 de la passe 34 sur P5b)

Périmètre : le commit `4f084c21` (et un commit de lint qui le suit, sur le seul fichier de
test `markers-unc.test.ts`), qui répond à la passe 34
(`docs/validation/rapport-review-pr46-passe34.md`). L'arbre de travail contient le chantier
P10a (`ask_user`) NON committé, d'un autre agent : relire l'état COMMITTÉ (`git show`, `git show
HEAD:<chemin>`), pas l'arbre.

- `apps/runner/src/cli-runtime/run-job.ts` : `AUDIT_WRITES_WAIT_MS = 5_000` (exporté),
  `settleAuditWrites(writes, jobId)` — `Promise.race` entre `allSettled(writes)` et une borne
  (timer nettoyé dans `finally`), code `CLI_AUDIT_WRITES_TIMEOUT job= writes= waited_ms=` sur
  `console.error` à la borne, ne lève jamais ; appelée à la place du `allSettled` nu.
- `packages/tools/src/projects/markers.ts` : `uncRoot` = les quatre premiers segments d'un
  chemin `//…` (`//serveur/partage`) ; la remontée rend le chemin normalisé dès que le parent
  serait plus court que cette racine — `//serveur` n'est jamais sondé.
- Tests : `intent-cli-runtime.test.ts` (bloc passe 33 réécrit : `dbWithSlowAudit(delayMs |
  'never')`, `runWith`, `ecritureParEvenement` ; la course avec `DELAI = 1_500` ET l'assertion
  « le tour a duré ≥ DELAI − 50 ms » ; la borne : insertion qui ne se règle jamais → statut
  `completed`, durée entre `AUDIT_WRITES_WAIT_MS − 50` et `+ 5 s`, le code journalisé, rien de
  déclaré) ; `markers-unc.test.ts` neuf (`node:fs` moqué : `realpathSync.native` note chaque
  sonde et lève `ENOENT` — UNC : `//nas/projets` sondé, jamais `//nas`, jamais `/` ; lecteur :
  `C:/` sondé, jamais `C:` ; POSIX : `[p, '/nulle/part', '/nulle']` exactement).

## Réponses aux constats de la passe 34

| Constat 34 | Réponse |
|---|---|
| P0 — attente sans limite | bornée à 5 s, dite par un code, jamais levée |
| P1 — le test de la course n'est pas déterministe | assumé et DIT dans le test : fenêtre 1,5 s (au lieu de 80 ms) + assertion que le tour a duré au moins ce délai ; un signal contrôlé par le test aurait besoin d'un point d'accroche dans run-job que le code n'a pas (et que je ne veux pas ajouter pour un test) |
| P1 — UNC | la remontée s'arrête au partage |
| P1 — casse Windows rappendue | aucun constat, rien à faire |
| P1 — Proxy sans `.returning()` | assumé (une incompatibilité visible, pas un faux vert) |

## Mesuré

- tools : `src/tests/projects` 43 tests (markers 6, markers-unc 3) ; runner : CLI 18 ;
  typecheck des fichiers touchés ; lint 0 après le correctif d'import de type.
- Mutations rouges puis restaurées : M17 (`settleAuditWrites` remplacé par `allSettled` nu →
  le test « ne se règle jamais » dépasse ses 20 s) ; M18 (garde `uncRoot` retirée → `//nas`
  sondé).

## Questions, par priorité

### P0

1. **La borne et la lecture qui suit.** À la borne, `harnessEdits` lit ce qui est posé ; une
   insertion qui finit par aboutir APRÈS la lecture laisse une ligne d'audit orpheline du
   registre (le projet ne sera déclaré qu'au tour suivant, s'il y en a un). C'est le contrat
   annoncé (« on lit ce qui est là, en le disant »). Un cas où c'est pire que ça : l'insertion
   tardive et un job qui se termine — le job porte `project_id` NULL alors qu'une ligne
   d'audit dit qu'il a écrit dans un projet à manifeste. Le backfill au boot suivant le
   rattrape (fenêtre du scan). Acceptable ?
2. **`Promise.race` avec `allSettled(...).then(() => 'settled')`** : si `writes` contient une
   promesse déjà réglée, tout est synchrone dans la microtâche — le timer est posé puis nettoyé
   sans jamais tirer. Un piège de `clearTimeout` sur un timer déjà tiré (le `'timeout'` gagne
   la course puis `finally` nettoie) ? Le timer d'un `'timeout'` gagnant est déjà consommé,
   `clearTimeout` est alors sans effet — vérifier que rien ne fuit.

### P1

3. **`uncRoot` pour un chemin `//serveur` sans partage** (`//serveur/x.ts`) : `split('/')`
   donne `['', '', 'serveur', 'x.ts']` → `uncRoot = '//serveur/x.ts'` (le fichier lui-même) ;
   la remontée s'arrête aussitôt et rend le chemin normalisé — correct par accident ? Dire si
   c'est le comportement voulu (un UNC sans partage n'est pas un chemin de fichier valide).
4. **Le mock `node:fs` de `markers-unc.test.ts`** remplace `realpathSync` par un objet fonction
   + `native` : `existsSync` (utilisé par `hasMarker`) reste réel via `...actual`. Le module
   `markers.ts` importe `{ existsSync, realpathSync }` — le mock couvre-t-il l'import nommé
   sous vitest (ESM) ? Le test passe (3/3), donc oui ; un doute sur un autre bundler ?

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
