// workflows/designation.ts — ce que les arguments d'un appel DISENT d'un fichier posé.
//
// Pour un outil dont la plateforme enregistre la lecture, le banc lit
// `tool_call_reads` (judge-kit `readReasons`). Un outil MCP (`request_print`)
// ouvre le fichier dans son propre processus : aucune lecture n'est
// enregistrée (#784), et le banc ne juge que ce que l'appel a DEMANDÉ.
//
// Revue de #777, passe 5 : chercher le nom du fichier dans l'entrée laissait
// passer une copie (`backup/…`) et une note qui le cite. Passe 6 : compter
// comme « un autre fichier » toute chaîne qui COMMENCE par un chemin absolu
// rougissait une demande juste (une note « C:/temp/x.pdf généré hier », un
// dossier de sortie).
//
// Une seule règle, celle du contrat :
//
//   - une chaîne de l'entrée, à toute profondeur, DÉSIGNE UN FICHIER quand sa
//     valeur entière est un chemin absolu qui mène à un fichier ordinaire qui
//     EXISTE. Tout le reste (un texte qui commence par un chemin, un dossier,
//     un chemin où rien n'existe, des guillemets, `file://`) n'est que du
//     texte : jamais une raison de rougir.
//     QUEL argument porte le fichier n'est pas deviné par son nom ; le schéma
//     d'entrée d'un outil MCP ne le dit pas non plus (JSON Schema n'a ni type
//     ni `format` « chemin de fichier ») ;
//   - avant tout appel au système de fichiers, la chaîne passe le refus du
//     produit (`windowsPathViolation`, @nodal-agents/tools) : un chemin UNC ou
//     protocol-relative, un nom de périphérique, un flux NTFS ne sont jamais
//     sondés. Le juge ne touche jamais un partage réseau ;
//   - le fichier désigné est comparé au fichier posé par son chemin réel
//     (`cheminConstate` : liens, jonctions, noms courts 8.3, casse sous
//     Windows, `..` et barres obliques résolus par le système) ;
//   - VERT : le fichier posé est désigné, et aucun autre fichier existant.
//     ROUGE : il ne l'est pas, ou un autre fichier existant l'est aussi.
//
// Seul un chemin absolu désigne le fichier sans rien deviner, pour le client
// MCP de Nodal : le runner passe les arguments tels quels, sans capacité
// `roots`, et lance un serveur stdio sans `cwd` (adapters/mcp `client.ts`) :
// le serveur hérite du dossier de travail du runner, jamais du dossier
// partagé. Le libellé `shared/` ne vaut que pour les outils de fichier du
// produit (`resolveAndCheckPath`, workspace.ts).

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { cheminConstate, windowsPathViolation } from '@nodal-agents/tools';
import { parseJson } from './judge-kit';

/** Ce que l'entrée d'un appel dit d'un fichier posé : elle le désigne, ou pourquoi pas. */
export type FileDesignation =
  | { readonly kind: 'posed' }
  | { readonly kind: 'not'; readonly why: string };

function stringLeaves(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
}

/**
 * La chaîne peut-elle être SONDÉE comme un chemin : un chemin absolu que le
 * refus du produit laisse passer (pas d'UNC, de périphérique ni de flux NTFS).
 * Pure : aucun accès au système de fichiers.
 */
export function mayProbe(s: string): boolean {
  return s !== '' && isAbsolute(s) && windowsPathViolation(s, s) === null;
}

/** Le chemin réel du fichier ordinaire existant que la chaîne désigne en entier, sinon null. */
async function designatedFile(s: string): Promise<string | null> {
  if (!mayProbe(s)) return null;
  try {
    if (!(await stat(s)).isFile()) return null;
  } catch {
    return null;
  }
  return cheminConstate(s);
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
  const files = new Set(
    (await Promise.all(leaves.map(designatedFile))).filter((p): p is string => p !== null),
  );
  const posed = files.has(posedPath);
  if (posed && files.size === 1) return { kind: 'posed' };
  if (files.size > (posed ? 1 : 0))
    return not(
      posed ? 'names the posed file and another existing file' : 'names another existing file',
    );
  // Rien ne désigne un fichier existant : la raison dit seulement ce que l'entrée en dit.
  const base = (rel.split('/').pop() ?? rel).toLowerCase();
  const low = leaves.map((s) => s.trim().replace(/\\/g, '/').toLowerCase());
  if (low.some((s) => s === base)) return not('names only the file name');
  const i = low.findIndex((s) => !/\s/.test(s) && s.endsWith(`/${base}`));
  if (i >= 0) {
    const s = leaves[i]!.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return not('names it by a URL, not a path');
    if (isAbsolute(s) && !mayProbe(s))
      return not('names it by a network or device path, which the judge never probes');
    if (isAbsolute(s)) return not('names it by an absolute path where no file exists');
    return not(
      "names it by a relative path, which Nodal's MCP client hands to the server as is, never resolved against the shared folder",
    );
  }
  if (low.some((s) => s.includes(base))) return not('names it only inside a text');
  return not('names no existing file by its absolute path');
}
