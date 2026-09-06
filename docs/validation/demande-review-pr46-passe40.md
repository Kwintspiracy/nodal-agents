# Demande de review — PR #46, passe 40 (les trois constats de la passe 39 sur P10b)

Périmètre : **un commit**, `5921ba4f` (4 fichiers), qui répond à la passe 39
(`docs/validation/rapport-review-pr46-passe39.md`). Un agent code P11 en parallèle dans
d'autres fichiers (`packages/checkpoints`, `packages/tools/src/execute.ts`, `apps/runner`,
`apps/web`, `packages/db`), NON committé : relire l'état COMMITTÉ (`git show 5921ba4f`, `git show
HEAD:<chemin>`), jamais l'arbre.

- `packages/tools/src/builtin/register-project.ts` : `jobAnsweredForProject(db, jobId, { name,
  folder })` — parmi les questions approuvées du job (50 au plus), l'option CHOISIE
  (`approval_requests.answer`) doit contenir le `name` demandé ou le dernier segment du `path`,
  après `fold` (NFKD, diacritiques retirés, minuscules, trim) ; aiguilles vides écartées ; sinon
  `require_approval`. Rollback : `existedBefore` sondé avant `mkdir` ; si
  `attachProductionToProject` rend `failed`, la ligne déclarée par CET appel est supprimée et le
  dossier retiré (`rmdir`) seulement s'il a été créé ici. Description de l'outil : dit la règle
  au modèle (« ask with that label, then reuse it here »).
- `packages/orchestration/src/system-prompt.ts` : « offer up to five relevant registered
  projects by name and one "New project: <name you propose>" option » ; l'inventaire reste
  plafonné à 12.
- Tests : `register-project.test.ts` (15 : « Bleu » → suspend ; libellé « New project: Veille
  IA » + name → passe ; accents/casse ; rollback par une conversation orpheline ; dossier
  préexistant conservé), `system-prompt.test.ts` (37).

## Réponses aux constats de la passe 39

| Constat 39 | Réponse |
|---|---|
| P0 — n'importe quelle question déverrouille | l'option choisie doit NOMMER le projet (name ou dossier), sans lecture de prose ; pas de table d'autorisations — dit pourquoi dans le code |
| P1 — création non atomique | rollback de la ligne et du dossier créés par l'appel quand le rattachement échoue |
| P2 — 12 projets vs 6 options | « up to five relevant » dans la consigne |
| P0-2, P0-3, P1 4-7 | aucun constat, rien à faire |

## Mesuré

register-project 15 ; system-prompt 37 ; tools 925 ; orchestration 239 ; typecheck des deux
paquets ; lint 0 erreur. Mutations rouges : garde ramenée à « une question suffit » (2, dont le
scénario « Bleu » ; refaite par l'orchestrateur) ; repli d'accents retiré (1) ; nettoyage
supprimé (2) ; `rmdir` inconditionnel (1) ; consigne du prompt revenue (1).

## Questions

1. **La liaison par le libellé** : `answer.includes(fold(name))` — un nom court (« Notes »)
   contenu dans une réponse à une autre question (« Add notes to the README ») déverrouille.
   Réel mais étroit (il faut une question approuvée dans CE job dont l'option contient ce mot,
   et l'agent écrit les deux). Acceptable, ou exiger l'égalité après retrait d'un préfixe
   « New project: » ? Dire ce qui est le plus honnête sans coupler l'outil à un texte de
   préfixe.
2. **Le rollback ne couvre pas une ligne déjà déclarée** (`created: false`) : l'appel ne l'a
   pas créée, il ne la supprime pas — mais le rattachement raté laisse la conversation sans
   projet courant ; l'outil rend `attach_failed:<code>`. Suffisant ?
3. **`rmdir` sur un dossier créé puis rempli par un autre processus** entre `mkdir` et le
   rattachement : `rmdir` échoue (non vide), ignoré. Un cas où l'échec ignoré cache autre chose ?

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
