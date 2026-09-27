// router/delegated-files.ts — les fichiers qu'un enfant de délégation a écrits
// (issue #491).
//
// CE QUI S'EST PASSÉ (run e2e794db, 25/09/2026). Un spécialiste a écrit
// `voiceover-agentic-harness.wav` (`generate_speech` ok, 979 244 octets), puis
// le runner a redémarré pendant qu'il rédigeait sa réponse. Son parent n'a reçu
// que `[stopped: runner restarted …]` : rien ne lui disait que le fichier
// existait. Il a redélégué le même travail, et le propriétaire a reçu une
// demande d'approbation pour écraser un fichier déjà fait.
//
// LA SOURCE, ET POURQUOI ELLE-LÀ. Chaque outil qui écrit un fichier passe par
// le seam d'exécution (`packages/tools/src/execute.ts`), qui pose une ligne
// d'état de vérification AVANT l'écriture et la marque `produced` quand
// l'écriture est CONSTATÉE sur le disque ; `return_result.deliverables` pose
// `declared` sur la même ligne (#509). C'est la seule comptabilité des
// écritures d'un run qui ne dépende d'aucun outil : la relire ici donne au
// parent la même réponse quel que soit l'outil (fichier, bureautique, voix,
// shell), le runtime ou la façon dont l'enfant s'est arrêté.
//
// CE QU'ELLE NE VOIT PAS, et c'est dit : une surface que le propriétaire a
// sortie de la vérification (Réglages → vérification) ne pose aucune ligne, et
// un envoi (`outbound_action`) n'est pas un fichier. Dans ces cas la liste est
// vide et le parent retombe sur le texte de l'enfant, comme avant.
//
// L'HISTORIQUE NE SUFFIT PAS, LA PRÉSENCE NON PLUS (revue Codex, passes 1 et
// 2). `produced` dit qu'une écriture a eu lieu, pas que le fichier est encore
// là ; un fichier présent n'est pas forcément celui que l'enfant a écrit — une
// personne a pu le changer, ou il était là avant. Chaque chemin est donc relu
// au moment de la reprise, et sa PROVENANCE se prouve par l'empreinte des
// octets que l'enfant a écrits (`constated_writes.content_sha256`, #505) :
//
//   written_by_child_unchanged  présent, et identique à ce que l'enfant a écrit
//   changed_since_child_wrote   présent, mais différent de ce qu'il a écrit
//   not_written_by_child        présent, sans écriture de l'enfant prouvée
//   absent                      ENOENT, et seulement ENOENT
//   unknown: <code>             toute autre erreur : on ne sait pas, on le dit
//                               (invariant #4) — jamais « n'est pas là »
//
// Un livrable `code_project` est un DOSSIER : il est rendu comme un projet,
// avec les fichiers que l'enfant y a changés selon ses constats, chacun avec
// son état — jamais comme « un fichier écrit ».

import { createHash } from 'node:crypto';
import { readFile, stat as statFs } from 'node:fs/promises';
import {
  and,
  asc,
  desc,
  eq,
  ne,
  or,
  constatedWrites,
  jobDeliverableVerificationState,
} from '@nodal-agents/db';
import { normalizePath, isWithinRoot } from '@nodal-agents/shared';
import { cheminConstate } from '@nodal-agents/tools';
import type { AnyDrizzleDb, JobId } from '../types';

/** Ce qu'on sait d'un chemin au moment de la reprise (voir l'en-tête). */
export type DelegatedFileState =
  | 'written_by_child_unchanged'
  | 'changed_since_child_wrote'
  | 'not_written_by_child'
  | 'absent'
  | `unknown: ${string}`;

/** Un fichier que l'enfant a écrit ou nommé comme livrable, tel que le parent le lit. */
export interface DelegatedFileEntry {
  kind: 'file';
  /** Le chemin tel que l'outil l'a résolu — celui que le parent peut relire. */
  path: string;
  /** L'enfant l'a-t-il NOMMÉ dans `return_result.deliverables` (#509) ? */
  declared: boolean;
  state: DelegatedFileState;
  /** Sa taille en octets quand il est présent et lisible, sinon `null`. */
  bytes: number | null;
  /** Où en est sa preuve (`dirty`, `green`, `red`, …) — le fait, pas un verdict. */
  proof: string;
}

/** Un projet de code que l'enfant a touché, avec les fichiers qu'il y a changés. */
export interface DelegatedProjectEntry {
  kind: 'project';
  path: string;
  declared: boolean;
  proof: string;
  files: DelegatedFileEntry[];
}

export type DelegatedFile = DelegatedFileEntry | DelegatedProjectEntry;

/** Ce que la lecture du disque utilise — remplaçable aux frontières, en test. */
export interface DiskReader {
  stat: (path: string) => Promise<{ isFile(): boolean; size: number }>;
}

const DISQUE: DiskReader = { stat: (p) => statFs(p) };

function codeDe(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'unreadable';
}

/** L'état d'UN chemin, comparé à l'empreinte que l'enfant y a laissée. */
async function etatDe(
  path: string,
  empreinteDeLEnfant: string | null,
  disque: DiskReader,
): Promise<{ state: DelegatedFileState; bytes: number | null }> {
  let taille: number;
  try {
    const s = await disque.stat(path);
    if (!s.isFile()) return { state: 'unknown: EISDIR', bytes: null };
    taille = s.size;
  } catch (err) {
    const code = codeDe(err);
    return { state: code === 'ENOENT' ? 'absent' : `unknown: ${code}`, bytes: null };
  }
  let actuelle: string;
  try {
    actuelle = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (err) {
    return { state: `unknown: ${codeDe(err)}`, bytes: null };
  }
  if (empreinteDeLEnfant === null) return { state: 'not_written_by_child', bytes: taille };
  return {
    state:
      actuelle === empreinteDeLEnfant ? 'written_by_child_unchanged' : 'changed_since_child_wrote',
    bytes: taille,
  };
}

/**
 * Les livrables que ce job a ÉCRITS (écriture constatée) ou DÉCLARÉS, chacun
 * dans son état actuel. Une tentative d'écriture qui n'a rien changé n'y est
 * pas : la ligne reste `addressed` sans être `produced`.
 */
export async function readFilesWrittenBy(
  db: AnyDrizzleDb,
  jobId: JobId,
  disque: DiskReader = DISQUE,
): Promise<DelegatedFile[]> {
  const t = jobDeliverableVerificationState;
  const rows = await db
    .select({
      key: t.canonicalKey,
      path: t.displayPathSnapshot,
      type: t.deliverableType,
      declared: t.declared,
      proof: t.decisionStatus,
    })
    .from(t)
    .where(
      and(
        eq(t.jobId, jobId as string),
        ne(t.deliverableType, 'outbound_action'),
        or(eq(t.produced, true), eq(t.declared, true)),
      ),
    )
    .orderBy(asc(t.canonicalKey));

  // La DERNIÈRE écriture constatée de l'enfant, par chemin réel.
  const constats = await db
    .select({ path: constatedWrites.path, sha: constatedWrites.contentSha256 })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId as string))
    .orderBy(desc(constatedWrites.createdAt));
  const empreintes = new Map<string, string | null>();
  for (const c of constats) if (!empreintes.has(c.path)) empreintes.set(c.path, c.sha);

  const out: DelegatedFile[] = [];
  for (const r of rows) {
    const path = r.path ?? r.key;
    if (r.type === 'code_project') {
      const racine = normalizePath(await cheminConstate(path));
      const files: DelegatedFileEntry[] = [];
      for (const [chemin, sha] of [...empreintes].sort(([a], [b]) => a.localeCompare(b))) {
        if (!isWithinRoot(chemin, racine)) continue;
        files.push({
          kind: 'file',
          path: chemin,
          declared: false,
          ...(await etatDe(chemin, sha, disque)),
          proof: r.proof,
        });
      }
      out.push({ kind: 'project', path, declared: r.declared, proof: r.proof, files });
      continue;
    }
    const sha = empreintes.get(await cheminConstate(path)) ?? null;
    out.push({
      kind: 'file',
      path,
      declared: r.declared,
      ...(await etatDe(path, sha, disque)),
      proof: r.proof,
    });
  }
  return out;
}

/** Les fichiers, projets compris, qui sont EXACTEMENT ce que l'enfant a écrit. */
export function filesUnchangedSinceChildWrote(
  files: readonly DelegatedFile[],
): DelegatedFileEntry[] {
  const plats = files.flatMap((f) => (f.kind === 'project' ? f.files : [f]));
  return plats.filter((f) => f.state === 'written_by_child_unchanged');
}
