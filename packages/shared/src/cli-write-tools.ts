// cli-write-tools.ts — les noms sous lesquels un HARNAIS de code déclare avoir
// écrit un fichier.
//
// Un runtime CLI (Claude Code, Codex) écrit dans son propre processus : ses
// écritures ne passent par aucun outil de Nodal. Ce qu'il a touché n'arrive que
// par les lignes `tool_calls` vivantes que l'enregistreur pose pendant la
// session, et ces lignes portent le nom de l'outil du CLI, préfixé `cli:`.
//
// La liste vit ICI parce que TROIS lectures en dépendent et qu'une copie
// divergerait au premier outil ajouté — c'est déjà l'argument qui l'avait fait
// exporter de `apps/runner/src/job/code-projects.ts` le 06/09 :
//
//   1. le contexte Runtime d'un agent (`apps/runner`), pour dire quels projets
//      ont été édités récemment ;
//   2. l'onglet Code et le fil (`apps/web/src/lib/actions.ts`, qui en portait
//      une copie jusqu'à cette PR) ;
//   3. la vérification (`packages/tools`), depuis l'issue #102 : ces lignes
//      sont la SEULE façon de savoir quels fichiers constater après un run de
//      harnais, puisque le seam ne les a jamais vus passer.
//
// Ce que la liste n'est PAS : une promesse qu'un fichier a été écrit. Elle dit
// qu'un outil PORTE un chemin dans son entrée. Le constat se fait sur le
// disque, ailleurs.

/** Les outils d'un runtime CLI dont l'entrée porte un chemin de fichier écrit. */
export const CLI_WRITE_TOOLS: readonly string[] = [
  'cli:Edit',
  'cli:Write',
  'cli:MultiEdit',
  'cli:NotebookEdit',
  // Le nom que porte une écriture d'un agent en runtime CODEX : un seul appel,
  // plusieurs fichiers, chacun sous `changes[].path`.
  'cli:file_change',
];

/**
 * Ce qu'une ligne d'outil CLI déclare d'un fichier : son chemin, et ce qu'elle
 * dit lui avoir fait.
 *
 * Le GENRE compte pour qui va vérifier : une suppression se constate par
 * l'ABSENCE du fichier, une écriture par sa présence. Les confondre ferait dire
 * « jamais vu sur le disque » d'une suppression parfaitement réussie — un fait
 * faux (revue C de la PR #196, passe 2).
 */
export interface CliWriteDeclaration {
  readonly path: string;
  /** `delete` quand la ligne dit avoir supprimé ; `write` pour tout le reste. */
  readonly kind: 'write' | 'delete';
}

/** Les mots par lesquels un runtime dit « j'ai supprimé ce fichier ». */
const MOTS_DE_SUPPRESSION = new Set(['delete', 'deleted', 'remove', 'removed']);

/** Ceux par lesquels il dit « j'ai écrit dedans ». */
const MOTS_D_ECRITURE = new Set([
  'add',
  'added',
  'create',
  'created',
  'update',
  'updated',
  'modify',
  'modified',
  'write',
  'written',
]);

/**
 * Les genres inconnus déjà signalés — UN par valeur, pas un par fichier.
 *
 * Un CLI qui se mettrait à dire `rename` en écrirait un par fichier déplacé, et
 * l'avertissement deviendrait le bruit qui fait ignorer les avertissements.
 */
const genresDejaDits = new Set<string>();

/**
 * Les fichiers qu'une ligne d'un outil CLI DÉCLARE avoir touchés.
 *
 * Deux formes, et rien d'autre n'est deviné :
 *   — Claude Code pose un chemin par appel, sous `file_path` (ou `path`, selon
 *     l'outil) ;
 *   — Codex pose `changes: [{ path, kind, diff }]`, plusieurs fichiers dans le
 *     même appel, et son `kind` distingue `add`, `update` et `delete`.
 *
 * UN GENRE INCONNU est traité en écriture — le repli sûr, puisqu'il exige que
 * le fichier SOIT là — et il est DIT par une ligne `HARNESS_UNKNOWN_CHANGE_KIND`,
 * une fois par valeur. Le cas qui viendra est un `rename` ou un `move` : le
 * rabattre en silence ferait chercher le fichier à son ancien chemin et mettre
 * son absence au compte d'une écriture ratée.
 *
 * Rend une liste vide pour tout le reste, y compris une entrée absente ou d'une
 * forme inconnue : un chemin inventé ferait constater un fichier que personne
 * n'a nommé.
 */
export function pathsDeclaredByCliWrite(
  toolName: string,
  toolInput: unknown,
): readonly CliWriteDeclaration[] {
  if (!CLI_WRITE_TOOLS.includes(toolName)) return [];
  const input = (toolInput ?? null) as Record<string, unknown> | null;
  if (input === null || typeof input !== 'object') return [];

  const changes = Array.isArray(input['changes']) ? input['changes'] : null;
  if (changes !== null) {
    const out: CliWriteDeclaration[] = [];
    for (const c of changes) {
      if (!c || typeof c !== 'object') continue;
      const rec = c as Record<string, unknown>;
      const p = rec['path'];
      if (typeof p !== 'string' || p.trim() === '') continue;
      const mot = typeof rec['kind'] === 'string' ? rec['kind'].trim().toLowerCase() : '';
      // Un genre qu'on ne connaît pas est traité en ÉCRITURE — le repli sûr,
      // puisqu'il demande au fichier d'être là — mais il est DIT (revue C de la
      // PR #196, passe 3). Un `rename` rabattu en silence ferait chercher le
      // fichier à son ancien chemin, et l'absence serait mise au compte d'une
      // écriture ratée. Le jour où un runtime en ajoute un, la ligne le nomme
      // au lieu de laisser deviner (invariant #4).
      if (mot !== '' && !MOTS_DE_SUPPRESSION.has(mot) && !MOTS_D_ECRITURE.has(mot)) {
        if (!genresDejaDits.has(mot)) {
          genresDejaDits.add(mot);
          console.warn(`[verification] HARNESS_UNKNOWN_CHANGE_KIND tool=${toolName} kind=${mot}`);
        }
      }
      out.push({ path: p, kind: MOTS_DE_SUPPRESSION.has(mot) ? 'delete' : 'write' });
    }
    return out;
  }

  for (const cle of ['file_path', 'path', 'notebook_path']) {
    const p = input[cle];
    // Les outils de Claude Code listés plus haut écrivent tous : celui qui
    // supprime n'y est pas, donc ce qui passe par ici est une écriture.
    if (typeof p === 'string' && p.trim() !== '') return [{ path: p, kind: 'write' }];
  }
  return [];
}
