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
//   2. l'onglet Code et le fil (`apps/web/src/lib/coding-changes.ts`) ;
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
 * Les chemins de fichiers qu'une ligne d'un outil CLI DÉCLARE avoir écrits.
 *
 * Deux formes, et rien d'autre n'est deviné :
 *   — Claude Code pose un chemin par appel, sous `file_path` (ou `path`, selon
 *     l'outil) ;
 *   — Codex pose `changes: [{ path, kind, diff }]`, plusieurs fichiers dans le
 *     même appel.
 *
 * Rend une liste vide pour tout le reste, y compris une entrée absente ou d'une
 * forme inconnue : un chemin inventé ferait constater un fichier que personne
 * n'a nommé.
 */
export function pathsDeclaredByCliWrite(toolName: string, toolInput: unknown): readonly string[] {
  if (!CLI_WRITE_TOOLS.includes(toolName)) return [];
  const input = (toolInput ?? null) as Record<string, unknown> | null;
  if (input === null || typeof input !== 'object') return [];

  const changes = Array.isArray(input['changes']) ? input['changes'] : null;
  if (changes !== null) {
    const out: string[] = [];
    for (const c of changes) {
      if (!c || typeof c !== 'object') continue;
      const p = (c as Record<string, unknown>)['path'];
      if (typeof p === 'string' && p.trim() !== '') out.push(p);
    }
    return out;
  }

  for (const cle of ['file_path', 'path', 'notebook_path']) {
    const p = input[cle];
    if (typeof p === 'string' && p.trim() !== '') return [p];
  }
  return [];
}
