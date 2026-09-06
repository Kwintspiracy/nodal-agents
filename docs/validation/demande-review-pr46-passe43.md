# Demande de review — PR #46, passe 43 (les constats de la passe 42 sur P11)

Périmètre : **un commit**, `ea6170ec` (6 fichiers), qui répond à la passe 42
(`docs/validation/rapport-review-pr46-passe42.md`). Deux agents codent en parallèle dans
d'AUTRES fichiers (`register-project.ts` + test, `system-prompt.ts` + test ; les outils xlsx,
`tool-cards.ts`, `ConversationFeedView.tsx`), NON committés : relire l'état COMMITTÉ (`git show
ea6170ec`, `git show HEAD:<chemin>`), jamais l'arbre.

- `apps/runner/src/cli-runtime/run-job.ts` : `resolveCliTurn(db, jobId)` (1 + `cli_runs` joués),
  calculé UNE fois avant `onEvent` ; `takeCliTurnCheckpoints(db, jobId, workspaces, turn)` ;
  chaque insertion `tool_calls` de l'enregistreur porte `turn: cliTurn`. Test
  (`checkpoint-cli-runtime.test.ts`) : la ligne `cli:Write` posée par le VRAI `onEvent` a le
  même `turn` que la ligne `job_checkpoints`.
- `packages/checkpoints/src/checkpoints.ts` : `gitEnv/git/gitRaw` acceptent un `indexFile` ;
  `diffFile` avec `toSha === null` travaille dans un index JETABLE
  (`indexes/<key>.diff-<aléa>` : `read-tree <fromSha>`, `add -A -- <relPath>`, `ls-files
  --cached`, `diff --cached <fromSha>`, puis `rm` dans un `finally`) ; `gitRawCapped` lit la
  sortie de `git diff` en FLUX (`spawn`), coupe au premier octet au-delà de `DIFF_MAX_BYTES`,
  tue git, compte des OCTETS ; le `numstat` reste par `gitRaw`. Tests : l'index du dossier est
  octet pour octet inchangé après une lecture et aucun `.diff-*` ne reste, le tour suivant
  photographie ; un diff de ~9 Mo (`é` × 60 par ligne, 75 000 lignes) → `truncated`,
  `Buffer.byteLength ≤ 200 000`, commence par `diff --git`.
- `apps/web/src/app/(dashboard)/spaces/FileDiff.tsx` : `DiffLines.truncatedNote` ; un fragment
  borné dit « diff simplified: too long to compare line by line ».

## Réponses aux constats de la passe 42

| Constat 42 | Réponse |
|---|---|
| P0 — `turn` NULL sur les lignes CLI | `turn: cliTurn` sur chaque ligne, le même que l'instantané |
| P0 — index partagé modifié par une lecture | index jetable par lecture, supprimé après |
| P1 — tampon 8 Mio avant la coupe | lecture en flux, coupée aux octets |
| P2 — `DIFF_MAX_BYTES` en unités UTF-16 | octets d'un `Buffer` |
| P2 — « truncated » d'un fragment | « diff simplified » |
| Fichier créé puis supprimé dans le tour → `not_in_snapshot` | limite dite, inchangée |
| Instantané lent refuse le tour du harnais | inchangé (même contrat que le seam) |
| Clés positionnelles dans le fil | inchangé (constat non bloquant) |

## Mesuré

checkpoints 26 ; runner 31 (CLI instantané 5, route 8, intention 18) ; web FileDiff 8 ;
typecheck des paquets ; lint 0 erreur. Mutations rouges : `turn` retiré de l'audit (1) ;
lecture dans l'index du dossier (1) ; borne en flux retirée (2).

## Questions

1. **`read-tree <fromSha>` dans l'index jetable** : pour un dossier de dizaines de milliers de
   fichiers, `read-tree` écrit un index complet à chaque lecture (quelques dizaines de ms à
   quelques centaines) — acceptable pour un clic ? Une alternative sans `read-tree` (index vide
   + `add` du seul chemin, puis `diff --cached <fromSha> -- <relPath>` restreint au chemin)
   donnerait-elle le même résultat ? Dire si le pathspec suffit à ne pas voir les autres
   fichiers comme supprimés.
2. **`gitRawCapped` tue git après la coupe** : `child.kill()` sur Windows (`windowsHide`) — un
   processus git zombie ou un `index.lock` laissé (le diff ne verrouille pas l'index jetable
   en lecture `--cached` ?) ; et le `finally` supprime l'index jetable pendant que git le lit
   encore quelques ms : un `EBUSY` Windows avalé par `.catch(() => undefined)` laisserait un
   `.diff-*` orphelin — grave ?
3. **Le tour CLI** : `resolveCliTurn` est lu AVANT les verrous de dossier ; deux tours du même
   job ne peuvent pas être concurrents (verrou d'écriture), mais un tour `read` en parallèle
   d'un tour `write` du même job insère des lignes d'audit avec le MÊME `turn` (aucun `cli_runs`
   posé entre les deux lectures). Réel ? Conséquence : le diff d'une ligne `read` n'a pas de
   sens de toute façon (rien d'écrit). À confirmer.

## Ce qui n'est PAS attendu

Le style. Un constat désigne un fichier, une ligne, et ce qui casse.
