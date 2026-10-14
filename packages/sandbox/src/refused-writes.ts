// refused-writes.ts — retrouver, dans la sortie d'une commande confinée, les
// écritures que le bac à sable a refusées, avec leur chemin quand la ligne le
// donne.
//
// Rien n'est rédigé ici (invariant #2) : chaque refus est la LIGNE de l'OS ou
// de l'outil, citée telle quelle, et le chemin qu'elle nomme. Quand la ligne
// ne nomme aucun chemin (`Access is denied.` de cmd.exe), le refus est rendu
// sans chemin — on ne devine pas lequel.
//
// Les formes reconnues, toutes mesurées par les essais #731 / #733 :
//   - Node : `EPERM: operation not permitted, open 'C:\…'` (et EACCES, EROFS,
//     mkdir / unlink / rename / symlink) ;
//   - Python : `PermissionError: [Errno 13] Permission denied: 'C:\…'`,
//     `[WinError 5] Access is denied: 'C:\…'` ;
//   - shells Unix : `cannot create /…: Read-only file system`,
//     `/…: Operation not permitted` ;
//   - cmd.exe : `Access is denied.` (sans chemin).

import { isAbsolute, resolve } from 'node:path';

/** Un refus d'écriture lu dans la sortie : la ligne citée, et le chemin si elle le nomme. */
export interface RefusedWrite {
  /** Le chemin refusé, tel que la ligne l'écrit, ou `null` si elle n'en nomme aucun. */
  readonly path: string | null;
  /** La ligne de l'OS ou de l'outil, telle quelle. */
  readonly error: string;
}

const DENIAL =
  /\b(EPERM|EACCES|EROFS)\b|Permission denied|Access is denied|Operation not permitted|Read-only file system/i;

/**
 * Un chemin entre apostrophes ou guillemets sur une ligne de refus : Node
 * (`open 'x'`, `rename 'a' -> 'b'`) et Python (`Permission denied: 'x'`)
 * citent ainsi le chemin, tel que le programme l'a écrit — relatif compris.
 */
const QUOTED = /['"]([^'"\r\n]+)['"]/g;
/**
 * Shells et outils Unix : le chemin est celui qui précède IMMÉDIATEMENT la
 * raison (`cannot create /chemin: Read-only file system`) — pas le nom du
 * programme qui ouvre la ligne (`/bin/sh: 1: …`).
 */
const UNIX_SHELL =
  /(\/[^\s:'"]+):\s*(?:Read-only file system|Operation not permitted|Permission denied)/g;

/** Un code d'erreur cité (`code: 'EPERM'` dans l'objet d'erreur de Node) n'est pas un chemin. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Python cite le chemin sous sa forme `repr`, antislashs doublés
 * (`'C:\\Users\\x'`). Quand TOUS les antislashs vont par paires, c'est cette
 * forme : on la ramène au chemin. Un chemin UNC brut (`\\serveur\partage`)
 * a des antislashs seuls, et reste tel quel.
 */
function unescapeRepr(p: string): string {
  if (!p.includes('\\\\')) return p;
  if (p.replace(/\\\\/g, '').includes('\\')) return p;
  return p.replace(/\\\\/g, '\\');
}

/** Plafond : la sortie d'une commande qui boucle sur un refus ne doit pas tout remplir. */
const MAX_REFUSED = 20;

/**
 * Les écritures refusées par le bac à sable que la sortie laisse voir.
 *
 * Le chemin est rendu TEL QUE LA LIGNE L'ÉCRIT : un chemin relatif reste
 * relatif (au dossier où la commande a tourné, le plus souvent — mais un
 * enfant a pu changer de dossier, et on ne le devine pas). `writableRoots`
 * et `cwd` servent seulement à écarter un chemin qui tombe DANS un dossier
 * permis : son refus a une autre cause (un fichier verrouillé, un attribut
 * lecture seule), le bac à sable n'y est pour rien.
 */
export function extractRefusedWrites(
  output: string,
  writableRoots: readonly string[],
  cwd: string,
): RefusedWrite[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const roots = writableRoots.map(norm);
  const inside = (p: string): boolean => {
    const abs = isAbsolute(p) || /^[A-Za-z]:/.test(p) ? p : resolve(cwd, p);
    const n = norm(abs);
    return roots.some((r) => n === r || n.startsWith(`${r}/`));
  };
  const out: RefusedWrite[] = [];
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    if (out.length >= MAX_REFUSED) break;
    const line = raw.trim();
    if (!line || !DENIAL.test(line)) continue;
    const quoted = [...line.matchAll(QUOTED)].map((m) => m[1] ?? '').filter(Boolean);
    // `code: 'EPERM',` : la ligne ne cite qu'un code — l'écho d'un refus
    // déjà lu sur sa propre ligne, pas un second refus.
    if (quoted.length > 0 && quoted.every((q) => ERROR_CODE.test(q))) continue;
    const paths = new Set(quoted.filter((q) => !ERROR_CODE.test(q)).map(unescapeRepr));
    if (paths.size === 0) for (const m of line.matchAll(UNIX_SHELL)) if (m[1]) paths.add(m[1]);
    const outside = [...paths].filter((p) => !inside(p));
    if (paths.size > 0 && outside.length === 0) continue;
    const entries = outside.length > 0 ? outside : [null];
    for (const path of entries) {
      const key = `${path ?? ''}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path, error: line });
      if (out.length >= MAX_REFUSED) break;
    }
  }
  return out;
}
