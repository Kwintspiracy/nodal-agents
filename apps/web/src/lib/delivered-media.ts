// delivered-media.ts — RETROUVER SUR LE DISQUE UN MÉDIA QU'UN TRAVAIL A LIVRÉ (#490).
//
// La route `/api/runs/<jobId>/media` sert au navigateur l'image, la piste
// audio ou la vidéo qu'un run a écrite, pour que l'encart de livraison la
// montre. Servir un fichier du disque à un navigateur est exactement ce qu'on
// ne fait pas à la légère ; ce module dit ce qui est servi, et rien d'autre :
//
// 1. UN FICHIER QUE CE TRAVAIL A ÉCRIT. Le navigateur ne donne jamais de chemin
//    à ouvrir : il désigne une ligne de l'encart (son chemin AFFICHÉ et son
//    rang, #380), et le chemin brut vient des lignes d'audit de ce travail et
//    de sa descendance (`deliveredFileSources`). Un chemin inventé ne désigne
//    aucune ligne.
// 2. DANS LES DOSSIERS DE L'ENTITÉ. Le chemin réel (liens résolus) doit tomber
//    sous l'une des racines réelles de l'entité (`entityWorkspaceRoots`) : un
//    lien symbolique posé depuis ne fait pas sortir la lecture.
// 3. UN MÉDIA DE LA LISTE FERMÉE (`MEDIA_TYPES`), jugé sur le fichier réel. Le
//    type envoyé vient de l'extension, jamais du contenu.
//
// Chaque refus a son code, et la route le dit (invariant #4) : « supprimé
// depuis » n'est pas « introuvable », et un chemin relatif que deux dossiers
// portent n'est pas servi au hasard.

import 'server-only';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { deliveredFileSources, type AuditRowForChanges } from './file-change-groups.ts';
import { mediaTypeOfPath, type MediaKind } from './media-kinds.ts';

export type DeliveredMedia = {
  absPath: string;
  fileName: string;
  size: number;
  kind: MediaKind;
  contentType: string;
};

export type DeliveredMediaRefusal =
  /** Aucune ligne de l'encart ne porte ce chemin à ce rang. */
  | 'not_delivered'
  /** Le fichier n'est pas un média de la liste fermée. */
  | 'not_media'
  /** Le fichier n'est plus sur le disque (supprimé ou déplacé depuis). */
  | 'gone'
  /** Un chemin relatif que plusieurs dossiers portent : lequel, on ne sait pas. */
  | 'ambiguous'
  /** Le chemin réel sort des dossiers de l'entité. */
  | 'outside';

const exists = (p: string): Promise<boolean> =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

/** `inner` est-il `outer` ou sous lui ? Les deux chemins sont réels. */
function isUnder(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function resolveDeliveredMedia(
  audit: readonly AuditRowForChanges[],
  workspaceRoots: readonly string[],
  displayPath: string,
  rank: number,
): Promise<{ ok: true; media: DeliveredMedia } | { ok: false; code: DeliveredMediaRefusal }> {
  const source = deliveredFileSources(audit, workspaceRoots).filter(
    (f) => f.filePath === displayPath,
  )[rank];
  if (source === undefined) return { ok: false, code: 'not_delivered' };

  // Absolu pour `file_write` et `generate_speech` ; relatif pour `file_edit`,
  // et alors il se résout contre les dossiers de l'entité — un seul doit le
  // porter.
  let candidate: string;
  if (isAbsolute(source.rawPath)) {
    candidate = source.rawPath;
  } else {
    const found: string[] = [];
    for (const root of workspaceRoots) {
      const p = join(root, source.rawPath);
      if (await exists(p)) found.push(p);
    }
    if (found.length > 1) return { ok: false, code: 'ambiguous' };
    if (found.length === 0) return { ok: false, code: 'gone' };
    candidate = found[0]!;
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return { ok: false, code: 'gone' };
  }
  const realRoots = (
    await Promise.all(workspaceRoots.map((r) => realpath(r).catch(() => null)))
  ).filter((r): r is string => r !== null);
  if (!realRoots.some((root) => isUnder(real, root))) return { ok: false, code: 'outside' };

  const type = mediaTypeOfPath(real);
  if (type === null) return { ok: false, code: 'not_media' };

  const info = await stat(real).catch(() => null);
  if (info === null || !info.isFile()) return { ok: false, code: 'gone' };

  return {
    ok: true,
    media: {
      absPath: real,
      fileName: basename(real),
      size: info.size,
      kind: type.kind,
      contentType: type.contentType,
    },
  };
}
