// workflows/designation.ts — ce que les arguments d'un appel DISENT d'un fichier posé.
//
// Pour un outil dont la plateforme enregistre la lecture, le banc lit
// `tool_call_reads` (judge-kit `readReasons`). Un outil MCP (`request_print`)
// ouvre le fichier dans son propre processus : aucune lecture n'est
// enregistrée (#784), et le banc ne juge que ce que l'appel a DEMANDÉ. Revue
// de #777, passe 5 : chercher le nom du fichier dans l'entrée laissait passer
// une copie (`backup/…`) et une note qui le cite.
//
// La règle, pour tout serveur MCP :
//
//   - QUEL argument porte le fichier n'est pas deviné par son nom. Le schéma
//     d'entrée d'un outil MCP ne le dit pas non plus : JSON Schema n'a pas de
//     type ni de `format` « chemin de fichier ». Chaque chaîne de l'entrée,
//     à toute profondeur, est lue, et elle désigne un fichier seulement quand
//     sa valeur ENTIÈRE est un chemin absolu ;
//   - seul un chemin ABSOLU désigne le fichier sans rien deviner. Le runner
//     passe les arguments tels quels au serveur, qu'il lance sans dossier de
//     travail (adapters/mcp `client.ts`, `StdioClientTransport` sans `cwd`). Un
//     chemin relatif se résout donc contre le dossier du serveur, jamais contre
//     le dossier partagé. Le libellé `shared/` ne vaut que pour les outils de
//     fichier du produit (`resolveAndCheckPath`, workspace.ts), pas pour un
//     processus (`PROCESS_PATHS_RULE`, workspace.ts) ;
//   - le chemin donné est comparé au chemin réel du fichier posé après la même
//     normalisation que la plateforme applique à ses lignes (`cheminConstate` :
//     lien et jonction résolus, barres obliques) ;
//   - la demande désigne LE fichier posé quand au moins un chemin absolu de son
//     entrée est le sien, et qu'aucun autre chemin absolu n'y désigne un autre
//     fichier.
//
// Tout le reste est rouge, avec sa raison : un autre fichier, le seul nom du
// fichier, un chemin relatif, ou le nom trouvé seulement dans un texte.

import { isAbsolute } from 'node:path';
import { cheminConstate } from '@nodal-agents/tools';
import { parseJson } from './judge-kit';

/** Ce que l'entrée d'un appel dit d'un fichier posé : elle le désigne, ou pourquoi pas. */
export type FileDesignation =
  | { readonly kind: 'posed' }
  | { readonly kind: 'not'; readonly why: string };

function stringLeaves(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v.trim());
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
}

const not = (why: string): FileDesignation => ({ kind: 'not', why });

/**
 * Ce que l'entrée `input` (JSON, telle que `tool_calls` la range) dit du
 * fichier posé à `posedPath` (son chemin réel, `cheminConstate`), de nom
 * relatif `rel` (voir l'en-tête).
 */
export async function fileDesignation(
  input: string | null,
  posedPath: string,
  rel: string,
): Promise<FileDesignation> {
  const leaves = stringLeaves(parseJson(input), []);
  const absolute = await Promise.all(
    leaves.filter((s) => s !== '' && isAbsolute(s)).map((s) => cheminConstate(s)),
  );
  const hits = absolute.filter((p) => p === posedPath).length;
  if (hits > 0 && hits === absolute.length) return { kind: 'posed' };
  if (absolute.length > hits)
    return not(
      hits > 0
        ? 'names the posed file and another file by their absolute paths'
        : 'names another file by its absolute path',
    );
  const base = (rel.split('/').pop() ?? rel).toLowerCase();
  const low = leaves.map((s) => s.replace(/\\/g, '/').toLowerCase());
  if (low.some((s) => s === base)) return not('names only the file name');
  if (low.some((s) => !/\s/.test(s) && s.endsWith(`/${base}`)))
    return not(
      'names it by a relative path, which an MCP server resolves against its own working directory, not the shared folder',
    );
  if (low.some((s) => s.includes(base))) return not('names it only inside a text');
  return not('does not name it');
}
