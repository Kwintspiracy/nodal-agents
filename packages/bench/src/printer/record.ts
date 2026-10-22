// printer/record.ts — l'enregistrement d'une demande d'impression du banc (#794).
//
// Le serveur écrit, le juge lit : un seul format, défini ici. Une demande =
// deux fichiers dans le dossier d'enregistrements de l'instance du banc :
//   <id>.bytes   les octets REÇUS, tels quels (le fichier lu, ou le contenu composé) ;
//   <id>.json    ce qu'on en sait : empreinte sha-256, taille, pages, heure, arguments reçus.
// Le .json est écrit en dernier et d'un seul geste (fichier temporaire puis
// renommage) : un enregistrement qui existe est complet.
//
// Le lecteur ne croit pas le .json sur parole : il recalcule l'empreinte et la
// taille des octets. Un enregistrement dont les octets ne correspondent pas est
// un PROBLÈME dit, jamais une demande comptée (invariant #4).

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Le littéral du format : aussi la marque qui prouve qu'un build ne porte pas le banc (build-pack). */
export const PRINT_RECORD_FORMAT = 'bench_printer_record_v1';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const PrintRecordSchema = z.object({
  format: z.literal(PRINT_RECORD_FORMAT),
  id: z.string().min(1),
  receivedAt: z.string(),
  receivedAtMs: z.number(),
  /** `pending` : la demande attend ; `replaced` : une demande plus récente l'a remplacée (jamais confirmée). */
  status: z.enum(['pending', 'replaced']),
  replacedBy: z.string().nullable(),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), path: z.string() }),
    z.object({ kind: z.literal('content'), contentFormat: z.enum(['html', 'text']) }),
  ]),
  bytes: z.object({ size: z.number().int().nonnegative(), sha256: Sha256 }),
  /** Les pages que l'impression aurait ; null quand le serveur ne sait pas le dire (voir `pagesBasis`). */
  pages: z.number().int().positive().nullable(),
  pagesBasis: z.enum(['pdf', 'image', 'text-estimate', 'html-estimate', 'unknown']),
  /** Les images que le document désigne ; null quand c'est un fichier imprimé tel quel (on n'en lit pas le contenu). */
  images: z.array(z.object({ origin: z.string() })).nullable(),
  /** Les arguments de l'appel, tels que le serveur les a reçus. */
  arguments: z.record(z.string(), z.unknown()),
});

export type PrintRecord = z.infer<typeof PrintRecordSchema>;

/** Une demande lue : l'enregistrement et ses octets, vérifiés. */
export interface ReadRecord {
  readonly record: PrintRecord;
  readonly bytes: Buffer;
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const jsonPath = (dir: string, id: string): string => join(dir, `${id}.json`);
const bytesPath = (dir: string, id: string): string => join(dir, `${id}.bytes`);

export interface NewRecord {
  readonly source: PrintRecord['source'];
  readonly bytes: Buffer;
  readonly pages: PrintRecord['pages'];
  readonly pagesBasis: PrintRecord['pagesBasis'];
  readonly images: PrintRecord['images'];
  readonly arguments: Record<string, unknown>;
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

/** Écrit la demande reçue (octets d'abord, puis le .json) et rend l'enregistrement. */
export function writeRecord(dir: string, n: NewRecord, nowMs: number = Date.now()): PrintRecord {
  const id = `pr-${nowMs}-${randomBytes(4).toString('hex')}`;
  const record: PrintRecord = {
    format: PRINT_RECORD_FORMAT,
    id,
    receivedAt: new Date(nowMs).toISOString(),
    receivedAtMs: nowMs,
    status: 'pending',
    replacedBy: null,
    source: n.source,
    bytes: { size: n.bytes.length, sha256: sha256Hex(n.bytes) },
    pages: n.pages,
    pagesBasis: n.pagesBasis,
    images: n.images,
    arguments: n.arguments,
  };
  writeFileSync(bytesPath(dir, id), n.bytes);
  writeJsonAtomically(jsonPath(dir, id), record);
  return record;
}

/** Un enregistrement, ou une raison de ne pas le croire. */
export type RecordLookup =
  | { readonly kind: 'found'; readonly read: ReadRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };

export function readRecord(dir: string, id: string): RecordLookup {
  const jp = jsonPath(dir, id);
  if (!existsSync(jp)) return { kind: 'missing' };
  let parsed: PrintRecord;
  try {
    parsed = PrintRecordSchema.parse(JSON.parse(readFileSync(jp, 'utf8')));
  } catch (e) {
    return {
      kind: 'invalid',
      reason: `${id}.json is not a bench printer record: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
    };
  }
  if (parsed.id !== id)
    return { kind: 'invalid', reason: `${id}.json carries the id ${parsed.id}` };
  let bytes: Buffer;
  try {
    bytes = readFileSync(bytesPath(dir, id));
  } catch {
    return { kind: 'invalid', reason: `${id}.bytes, the received content, cannot be read` };
  }
  if (bytes.length !== parsed.bytes.size || sha256Hex(bytes) !== parsed.bytes.sha256)
    return {
      kind: 'invalid',
      reason: `${id}.bytes does not match the size and sha-256 its record declares`,
    };
  return { kind: 'found', read: { record: parsed, bytes } };
}

/** Marque la demande `id` remplacée par `by`. Rend false quand elle n'existe pas ou n'attend plus. */
export function markReplaced(dir: string, id: string, by: string): boolean {
  const found = readRecord(dir, id);
  if (found.kind !== 'found' || found.read.record.status !== 'pending') return false;
  writeJsonAtomically(jsonPath(dir, id), {
    ...found.read.record,
    status: 'replaced',
    replacedBy: by,
  } satisfies PrintRecord);
  return true;
}

export interface RecordsRead {
  /** Les demandes valides, de la plus ancienne à la plus récente. */
  readonly requests: ReadRecord[];
  /** Ce qui n'a pas pu être cru : un enregistrement illisible, des octets qui ne correspondent pas. */
  readonly problems: string[];
}

/** Tout ce que le dossier contient. Un dossier absent est un problème dit : le serveur ne l'a jamais créé. */
export function readRecords(dir: string): RecordsRead {
  if (!existsSync(dir))
    return {
      requests: [],
      problems: [
        `the bench printer's record folder ${dir} does not exist: the server never started`,
      ],
    };
  const requests: ReadRecord[] = [];
  const problems: string[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const found = readRecord(dir, name.slice(0, -'.json'.length));
    if (found.kind === 'found') requests.push(found.read);
    else if (found.kind === 'invalid') problems.push(found.reason);
  }
  requests.sort(
    (a, b) =>
      a.record.receivedAtMs - b.record.receivedAtMs || a.record.id.localeCompare(b.record.id),
  );
  return { requests, problems };
}
