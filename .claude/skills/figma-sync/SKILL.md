---
name: figma-sync
description: Répercute dans le code les changements faits par Quentin dans le Design System Figma (fichier GWXBALe90DMFR3XYGccofJ). Diff profond via le lockfile, application classée (tokens/géométrie/structurel), gauntlet, mise à jour du lock. Invoquer quand Quentin dit /figma-sync ou « synchronise le DS ».
---

# /figma-sync — Figma → code, le Design System comme source d'intention

Le CODE reste la source de vérité du produit, mais quand Quentin édite le DS
dans Figma, c'est une INTENTION de changement produit : ce pipeline la traduit
en code, vérifie tout, puis re-scelle le miroir.

## Pipeline (dans cet ordre, sans sauter d'étape)

### 1. Diff
```bash
cd apps/web && node scripts/figma-ds-lock.mjs --diff
```
- Exit 0 → « Figma inchangé depuis le dernier sync » : rapporter, terminé.
- Sinon : la sortie liste les deltas (humain + JSON). C'est le contrat de
  travail de la session — chaque delta doit finir soit APPLIQUÉ soit
  explicitement REFUSÉ avec raison (jamais ignoré en silence).
- Lancer aussi `pnpm figma:drift` (cohérence mappings) — corriger ses erreurs
  d'abord si elles existent.

### 2. Classer chaque delta

**A. Tokens & styles (déterministe)** — delta sur une valeur résolue partagée
(rgba d'une variable, fontSize/lineHeight d'un text style, vu simultanément sur
tous les nœuds liés) :
- Variables couleur : `color/<x>` (Figma) ↔ `--c-<x>` dans
  `apps/web/src/app/globals.css` (modes Light/Dark ↔ `:root` / `[data-theme='dark']`).
- Radii : `--radius-*` dans globals.css.
- Échelle typo : `--text-xs: 13px`, `--text-sm: 15px` (PIÈGE CONNU : le thème
  redéfinit les utilities — ne JAMAIS raisonner sur les défauts Tailwind).
  Un changement de `Body/15` etc. côté Figma se voit dans les fontSize résolues
  des nœuds liés.
- Pour lire les définitions de variables Figma (id → nom/valeurs par mode),
  utiliser l'outil MCP `get_variable_defs` (le REST ne les expose pas sur ce plan).

**B. Géométrie d'un composant mappé (quasi-déterministe)** — padding, gap,
radius, tailles, strokeWeight sur un variant :
- Trouver le fichier code via le `.figma.tsx` du composant
  (`apps/web/src/components/ui/<X>.figma.tsx` → source).
- Traduire en classes Tailwind du fichier (px-2=8, py-1.5=6, rounded-md=8px via
  thème, etc.). LIRE le composant avant d'éditer — certains variants code
  partagent des classes.

**C. Structurel (agentique)** — variant ajouté/supprimé, composant
ajouté/renommé/supprimé, refonte :
- Variant ajouté (ex. Button `ghost`) : ajouter la valeur au type + au record
  de classes du composant, à l'enum du `.figma.tsx`, PUIS
  `npx figma connect publish --force` (token: `~/.figma-token`).
- Composant ajouté dans Figma : créer le composant code dans `ui/` (tokens du
  thème, conventions du dossier), son `.figma.tsx`, publier Code Connect.
- Suppression/renommage : répercuter avec prudence — chercher tous les usages
  avant de supprimer du code ; en cas de doute produit, DEMANDER à Quentin.

### 3. Appliquer
- Familles A et B : appliquer directement.
- Famille C : appliquer si l'intention est sans ambiguïté ; sinon poser LA
  question à Quentin avant (jamais de supposition sur un rename/suppression).
- Si le changement Figma contredit une valeur que le code fait exprès (vérifier
  les docstrings/commentaires du composant), SIGNALER le conflit au lieu
  d'écraser silencieusement.

### 4. Vérifier (gauntlet, obligatoire)
```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
pnpm figma:drift   # doit rester sans erreur
```
- Si l'UI a visuellement changé : vérification Playwright ciblée sur une page
  qui rend le composant (les specs e2e existantes + screenshot light/dark).
- La stack dev tourne en général sur :3000 (HMR) — vérifier le rendu réel.

### 5. Re-sceller le miroir
```bash
node scripts/figma-ds-lock.mjs --write
```
- Le lock (`apps/web/design/figma-ds.lock.json`) doit être commité AVEC les
  changements de code — c'est la définition de « synchronisé ».
- Si des `.figma.tsx` ont changé : `npx figma connect publish --force`.
- Rappeler à Quentin de publier la bibliothèque Figma si LES COMPOSANTS Figma
  ont été retouchés en retour (seul geste hors de portée de l'agent).

### 6. Rapport
Par delta : quoi (Figma) → quoi (code, fichier:ligne) → vérifié comment.
Lister les refusés/questions. Format court, tableau si ≥3 deltas.

## Règles de sécurité
- Corrections côté Figma : TOUJOURS via styles/variables partagés, jamais de
  valeur locale sur un nœud (ça détache — leçon du 2026-07-16).
- Typographie côté code : la ramp est en @utility nommées (text-body-14…,
  miroir 1:1 des text styles Figma) + text-legacy-* pixel-identiques. JAMAIS
  de `text-[Npx]` (le garde-fou lint échoue). Un rebind Figma Body/X→Body/Y se
  traduit par text-body-x→text-body-y. Piège cascade : les @utility custom
  battent les utilities natives à spécificité égale — suffixer `!` la classe
  (font-medium!, leading-*!) qui doit gagner sur le bundle d'une utility ramp.
- Jamais de `--write` du lock AVANT que le code soit aligné et vérifié.
- Les changements hors DS (pages Examples/Patterns du fichier Figma) ne sont
  pas du ressort de ce pipeline — les signaler seulement.
